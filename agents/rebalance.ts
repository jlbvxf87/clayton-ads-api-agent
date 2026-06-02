import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { supabase } from './supabase.js';
import {
  listCampaigns,
  getCampaignInsights,
  getActionBreakdown,
  setDailyBudget,
  extractLeads,
  type Campaign,
  type CampaignInsight,
} from './meta.js';
import { getCapiConfig, listEventMap, listRecentForwards } from './capi.js';
import { loadActiveObservations, noteObservation } from './memory.js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN must be set for rebalance');
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ---------- Tunables ----------

// Phase 3: 70/20/10 portfolio tiers
const WINNER_CPL_THRESHOLD = 0.70;        // adjusted CPL ≤ 70% of avg → winner tier
const UNDERPERFORMER_CPL_THRESHOLD = 1.40; // adjusted CPL ≥ 140% of avg → underperformer
const WINNER_MIN_LEADS = 30;              // need ≥30 leads for winner eligibility
const EXPERIMENT_MAX_LEADS = 15;          // ≤15 leads → experiment tier (learning phase)
const WINNER_BUMP_PCT = 30;               // winners get +30%
const UNDERPERFORMER_CUT_PCT = 20;        // underperformers get -20%
const EXPERIMENT_BUDGET_CAP_CENTS = 5_000; // $50/day hard cap on experiments
const BAYESIAN_PRIOR_WEIGHT = 20;         // shrinks toward account avg with <20 leads
// Legacy tunables kept for clampDelta guardrail
const BAND_TOP_THRESHOLD = 0.7;
const BAND_BOTTOM_THRESHOLD = 1.3;
const TOP_BUMP_PCT = 20;
const BOTTOM_CUT_PCT = 20;
const MAX_CHANGE_PCT_PER_PASS = 50;
const MIN_DAILY_BUDGET_CENTS = 500;
const MAX_DAILY_BUDGET_CENTS = 50000;
const MIN_DAYS_ACTIVE = 3;
const MIN_LEADS_WINDOW = 20;
const CPB_MIN_FORWARDS_14D = 30;

// ---------- Types ----------

export type Metric = 'cpl' | 'cpb';
export type Band = 'top' | 'middle' | 'bottom' | 'skip_insufficient_data' | 'skip_open_signal';
export type PortfolioTier = 'winner' | 'testing' | 'experiment' | 'underperformer';

export interface CampaignMetrics {
  campaign_id: string;
  campaign_name: string;
  status: string;
  current_daily_cents: number | null;
  spend_window: number;
  leads_window: number;
  bookings_window: number;
  cpl_window: number | null;
  cpb_window: number | null;
  metric_value: number | null;
  adjusted_metric: number | null; // Bayesian-shrunk toward account avg
  portfolio_tier: PortfolioTier | null;
  winner_consecutive_cycles: number;
  band: Band;
  reason: string;
  has_open_signal: boolean;
}

export interface ProposedChange {
  campaign_id: string;
  campaign_name: string;
  current_daily_cents: number;
  proposed_daily_cents: number;
  delta_cents: number;
  delta_pct: number;
  band: Band;
  metric_value: number | null;
  winner_cycles?: number;
  reason: string;
  applied: boolean;
  apply_error?: string | null;
}

export interface RebalancePlan {
  id?: number;
  generated_by: 'cron_morning' | 'cron_evening' | 'manual' | 'agent_tool';
  status: 'proposed' | 'applied' | 'rejected' | 'superseded' | 'expired' | 'partial';
  metric: Metric;
  metric_reason: string;
  account_avg_metric: number | null;
  total_daily_before_cents: number;
  total_daily_after_cents: number;
  changes: ProposedChange[];
  rationale: string;
}

// ---------- Metric selector: CPL or CPB? ----------

export async function pickMetric(): Promise<{ metric: Metric; reason: string }> {
  let cfg;
  try {
    cfg = await getCapiConfig();
  } catch {
    return { metric: 'cpl', reason: 'CAPI config unreadable — falling back to CPL' };
  }
  if (!cfg.enabled) return { metric: 'cpl', reason: 'CAPI bridge disabled — using CPL' };

  const maps = await listEventMap();
  // Claya uses custom events: "Payment completed" = Purchase, "Request Submitted" = Lead.
  // Accept any downstream conversion event (Purchase / Payment completed / Schedule / booking).
  const BOOKING_EVENT_NAMES = new Set([
    'Schedule', 'Purchase', 'Payment completed', 'booking_created', 'appointment_booked',
  ]);
  const bookingMetaEvents = maps
    .filter((m) => m.enabled && BOOKING_EVENT_NAMES.has(m.meta_event_name))
    .map((m) => m.meta_event_name);
  if (bookingMetaEvents.length === 0) {
    return { metric: 'cpl', reason: 'no booking/purchase mapping in capi_event_map — using CPL' };
  }

  const since = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
  const { data: fwds, error } = await supabase
    .from('capi_forwards')
    .select('id, meta_event_name, success')
    .gte('created_at', since)
    .eq('success', true);
  if (error) {
    return { metric: 'cpl', reason: `capi_forwards query failed (${error.message}) — using CPL` };
  }
  const bookingFwds = (fwds ?? []).filter((f) =>
    bookingMetaEvents.includes(f.meta_event_name as string),
  );
  if (bookingFwds.length < CPB_MIN_FORWARDS_14D) {
    return {
      metric: 'cpl',
      reason: `only ${bookingFwds.length} booking forwards in last 14d (need ≥${CPB_MIN_FORWARDS_14D}) — using CPL`,
    };
  }
  return {
    metric: 'cpb',
    reason: `${bookingFwds.length} booking forwards in last 14d — switching to CPB`,
  };
}

// ---------- Per-campaign metric assembly ----------

interface CampaignWindow {
  campaign: Campaign;
  insight: CampaignInsight | undefined;
  bookings: number;
}

async function fetchCampaignWindow(): Promise<CampaignWindow[]> {
  const [campaigns, insights] = await Promise.all([
    listCampaigns(),
    getCampaignInsights('last_7d'),
  ]);
  const idx = new Map(insights.map((i) => [i.campaign_id, i] as const));
  // For CPB, we need per-campaign booking action counts.
  // ActionBreakdown row shape: { parent_id, parent_name, ..., actions: [{ action_type, value }] }
  let breakdownByCampaign = new Map<string, number>();
  try {
    const breakdown = await getActionBreakdown(null, 'campaign', 'last_7d');
    for (const row of breakdown) {
      let count = 0;
      for (const a of row.actions ?? []) {
        const t = (a.action_type ?? '').toLowerCase();
        if (t === 'schedule' || t === 'purchase' || t === 'complete_registration') {
          count += Number(a.value ?? 0);
        }
      }
      if (count > 0) breakdownByCampaign.set(row.parent_id, count);
    }
  } catch (err) {
    console.warn('[REBALANCE] action breakdown failed (continuing CPL-only):', err);
    breakdownByCampaign = new Map();
  }
  return campaigns.map((c) => ({
    campaign: c,
    insight: idx.get(c.id),
    bookings: breakdownByCampaign.get(c.id) ?? 0,
  }));
}

async function loadOpenSignalCampaignIds(): Promise<Set<string>> {
  const { data } = await supabase
    .from('agent_inbox')
    .select('target_id, signal_kind')
    .is('resolved_at', null)
    .in('signal_kind', ['cpl_spike', 'frequency_creep', 'zero_leads']);
  const ids = new Set<string>();
  for (const r of data ?? []) {
    if (r.target_id) ids.add(r.target_id as string);
  }
  return ids;
}

// ---------- Bayesian confidence ----------

function bayesianAdjust(rawMetric: number, sampleSize: number, accountAvg: number): number {
  // Shrinks raw metric toward account average when sample is small.
  // With 20 leads the estimate is 50/50 raw vs prior; at 100 leads it's 83% raw.
  return (sampleSize * rawMetric + BAYESIAN_PRIOR_WEIGHT * accountAvg) / (sampleSize + BAYESIAN_PRIOR_WEIGHT);
}

function classifyPortfolioTier(
  adjusted: number,
  leads: number,
  accountAvg: number,
): PortfolioTier {
  if (leads <= EXPERIMENT_MAX_LEADS) return 'experiment';
  if (leads < WINNER_MIN_LEADS) return 'testing';
  const ratio = adjusted / accountAvg;
  if (ratio <= WINNER_CPL_THRESHOLD) return 'winner';
  if (ratio >= UNDERPERFORMER_CPL_THRESHOLD) return 'underperformer';
  return 'testing';
}

// ---------- Winner cycle tracking ----------

async function loadWinnerCycleMap(): Promise<Map<string, { id: number; cycles: number }>> {
  const obs = await loadActiveObservations('rebalance:winner_cycles:');
  const m = new Map<string, { id: number; cycles: number }>();
  for (const o of obs) {
    try {
      const p = JSON.parse(o.observation) as { cycles: number };
      const id = o.topic.replace('rebalance:winner_cycles:', '');
      if (o.id != null) m.set(id, { id: o.id, cycles: p.cycles });
    } catch {}
  }
  return m;
}

async function updateWinnerCycles(rows: CampaignMetrics[]): Promise<void> {
  const cycleMap = await loadWinnerCycleMap();
  for (const r of rows) {
    const isWinner = r.portfolio_tier === 'winner';
    const existing = cycleMap.get(r.campaign_id);
    const newCycles = isWinner ? (existing?.cycles ?? 0) + 1 : 0;
    r.winner_consecutive_cycles = newCycles;
    if (isWinner || (existing && existing.cycles > 0)) {
      const val = JSON.stringify({
        cycles: newCycles,
        campaign_name: r.campaign_name,
        last_cycle: new Date().toISOString(),
      });
      await noteObservation(`rebalance:winner_cycles:${r.campaign_id}`, val, {
        confidence: 'high',
        supersedes: existing?.id,
      });
    }
  }
}

// ---------- Banding ----------

interface AssembledMetrics {
  rows: CampaignMetrics[];
  account_avg: number | null;
  metric: Metric;
  metric_reason: string;
}

async function assembleMetrics(): Promise<AssembledMetrics> {
  const { metric, reason } = await pickMetric();
  const windowData = await fetchCampaignWindow();
  const openSignalIds = await loadOpenSignalCampaignIds();
  const rows: CampaignMetrics[] = [];

  for (const w of windowData) {
    const status = w.campaign.effective_status ?? w.campaign.status ?? 'UNKNOWN';
    const dailyCents = w.campaign.daily_budget != null ? Number(w.campaign.daily_budget) : null;
    if (status !== 'ACTIVE') continue; // only rebalance live campaigns

    const spend = w.insight?.spend ? Number(w.insight.spend) : 0;
    const leads = w.insight ? extractLeads(w.insight) : 0;
    const cpl = leads > 0 ? spend / leads : null;
    const cpb = w.bookings > 0 ? spend / w.bookings : null;
    const metricValue = metric === 'cpl' ? cpl : cpb;

    const hasOpenSignal = openSignalIds.has(w.campaign.id);
    let band: Band;
    let reasonStr: string;

    if (leads < MIN_LEADS_WINDOW || dailyCents == null || dailyCents <= 0) {
      band = 'skip_insufficient_data';
      reasonStr = `${leads} leads in window (need ≥${MIN_LEADS_WINDOW})${dailyCents == null ? '; no daily budget set' : ''}`;
    } else if (hasOpenSignal) {
      band = 'skip_open_signal';
      reasonStr = `open inbox signal — let monitor/judgment loop resolve before rebalancing`;
    } else if (metricValue == null) {
      band = 'skip_insufficient_data';
      reasonStr = `no ${metric} data this window`;
    } else {
      band = 'middle'; // tentative; we'll classify after we know account avg
      reasonStr = '';
    }

    rows.push({
      campaign_id: w.campaign.id,
      campaign_name: w.campaign.name,
      status,
      current_daily_cents: dailyCents,
      spend_window: spend,
      leads_window: leads,
      bookings_window: w.bookings,
      cpl_window: cpl,
      cpb_window: cpb,
      metric_value: metricValue,
      adjusted_metric: null, // filled in after account avg is known
      portfolio_tier: null,  // filled in after account avg is known
      winner_consecutive_cycles: 0,
      band,
      reason: reasonStr,
      has_open_signal: hasOpenSignal,
    });
  }

  // Compute weighted-average metric across eligible (non-skip) rows
  const eligible = rows.filter((r) => r.band === 'middle' && r.metric_value != null);
  let account_avg: number | null = null;
  if (eligible.length > 0) {
    const totalSpend = eligible.reduce((s, r) => s + r.spend_window, 0);
    const totalCount =
      metric === 'cpl'
        ? eligible.reduce((s, r) => s + r.leads_window, 0)
        : eligible.reduce((s, r) => s + r.bookings_window, 0);
    account_avg = totalCount > 0 ? totalSpend / totalCount : null;
  }

  // Classify into legacy band (backward compat) AND portfolio tier (Phase 3)
  if (account_avg != null) {
    for (const r of rows) {
      if (r.band !== 'middle') continue;
      const raw = r.metric_value!;
      const sampleSize = metric === 'cpl' ? r.leads_window : r.bookings_window;
      const adjusted = bayesianAdjust(raw, sampleSize, account_avg);
      r.adjusted_metric = adjusted;
      r.portfolio_tier = classifyPortfolioTier(adjusted, sampleSize, account_avg);

      // Legacy band (kept for backward compat with stored plan JSON)
      const ratio = adjusted / account_avg;
      if (ratio <= BAND_TOP_THRESHOLD) {
        r.band = 'top';
      } else if (ratio >= BAND_BOTTOM_THRESHOLD) {
        r.band = 'bottom';
      } else {
        r.band = 'middle';
      }

      const confNote = sampleSize < WINNER_MIN_LEADS ? ` (${sampleSize} leads, Bayesian-adjusted)` : '';
      const tierLabel = r.portfolio_tier ? ` [${r.portfolio_tier.toUpperCase()}]` : '';
      r.reason = `${metric.toUpperCase()} raw $${raw.toFixed(0)} → adj $${adjusted.toFixed(0)} vs avg $${account_avg.toFixed(0)}${confNote}${tierLabel}`;
    }
    // Campaigns skipped for data get experiment tier
    for (const r of rows) {
      if (r.band === 'skip_insufficient_data') {
        r.portfolio_tier = 'experiment';
        r.adjusted_metric = null;
      }
    }
  }

  await updateWinnerCycles(rows);
  return { rows, account_avg, metric, metric_reason: reason };
}

// ---------- Plan synthesis ----------

function clampDelta(currentCents: number, deltaPct: number): { newCents: number; effectivePct: number } {
  const cappedPct = Math.max(-MAX_CHANGE_PCT_PER_PASS, Math.min(MAX_CHANGE_PCT_PER_PASS, deltaPct));
  let newCents = Math.round(currentCents * (1 + cappedPct / 100));
  if (newCents < MIN_DAILY_BUDGET_CENTS) newCents = MIN_DAILY_BUDGET_CENTS;
  if (newCents > MAX_DAILY_BUDGET_CENTS) newCents = MAX_DAILY_BUDGET_CENTS;
  const effectivePct = currentCents > 0 ? ((newCents - currentCents) / currentCents) * 100 : 0;
  return { newCents, effectivePct };
}

function buildChanges(rows: CampaignMetrics[]): ProposedChange[] {
  const out: ProposedChange[] = [];
  for (const r of rows) {
    const current = r.current_daily_cents ?? 0;
    if (current <= 0) continue;

    const tier = r.portfolio_tier;

    if (tier === 'winner') {
      // Confirmed winners (2+ cycles) earn a larger +50% bump vs first-cycle +30%
      const bumpPct = r.winner_consecutive_cycles >= 2 ? 50 : WINNER_BUMP_PCT;
      const { newCents, effectivePct } = clampDelta(current, bumpPct);
      if (newCents === current) continue;
      out.push({
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        current_daily_cents: current,
        proposed_daily_cents: newCents,
        delta_cents: newCents - current,
        delta_pct: effectivePct,
        band: r.band,
        metric_value: r.metric_value,
        winner_cycles: r.winner_consecutive_cycles,
        reason: r.reason,
        applied: false,
      });
    } else if (tier === 'underperformer') {
      const { newCents, effectivePct } = clampDelta(current, -UNDERPERFORMER_CUT_PCT);
      if (newCents === current) continue;
      out.push({
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        current_daily_cents: current,
        proposed_daily_cents: newCents,
        delta_cents: newCents - current,
        delta_pct: effectivePct,
        band: r.band,
        metric_value: r.metric_value,
        reason: r.reason,
        applied: false,
      });
    } else if (tier === 'experiment' && current > EXPERIMENT_BUDGET_CAP_CENTS) {
      // Cap experiments that have crept above the experiment ceiling
      out.push({
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        current_daily_cents: current,
        proposed_daily_cents: EXPERIMENT_BUDGET_CAP_CENTS,
        delta_cents: EXPERIMENT_BUDGET_CAP_CENTS - current,
        delta_pct: ((EXPERIMENT_BUDGET_CAP_CENTS - current) / current) * 100,
        band: r.band,
        metric_value: r.metric_value,
        reason: r.reason + ' — capped at $50/day experiment limit',
        applied: false,
      });
    }
    // testing tier → no change (protected)
  }
  return out;
}

export async function generateRebalanceProposal(
  generatedBy: RebalancePlan['generated_by'],
): Promise<RebalancePlan> {
  // Mark any existing proposed plans as superseded so only one is open at a time.
  await supabase
    .from('agent_rebalance_plans')
    .update({ status: 'superseded', resolved_at: new Date().toISOString(), resolved_by: 'auto:new_plan' })
    .eq('status', 'proposed');

  const assembled = await assembleMetrics();
  const changes = buildChanges(assembled.rows);
  const totalBefore = assembled.rows.reduce((s, r) => s + (r.current_daily_cents ?? 0), 0);
  const totalAfter =
    totalBefore -
    changes.reduce((s, c) => s + c.current_daily_cents, 0) +
    changes.reduce((s, c) => s + c.proposed_daily_cents, 0);

  const skippedSignal = assembled.rows.filter((r) => r.band === 'skip_open_signal').length;
  const skippedData = assembled.rows.filter((r) => r.band === 'skip_insufficient_data').length;
  const winnerCount = assembled.rows.filter((r) => r.portfolio_tier === 'winner').length;
  const testingCount = assembled.rows.filter((r) => r.portfolio_tier === 'testing').length;
  const experimentCount = assembled.rows.filter((r) => r.portfolio_tier === 'experiment').length;
  const underperformerCount = assembled.rows.filter((r) => r.portfolio_tier === 'underperformer').length;

  const rationale =
    `Portfolio: ${winnerCount} winner, ${testingCount} testing (held), ${experimentCount} experiment, ${underperformerCount} underperformer. ` +
    `Bayesian prior=${BAYESIAN_PRIOR_WEIGHT} leads. ` +
    `${skippedSignal} skipped (open signal), ${skippedData} skipped (no data).`;

  const plan: RebalancePlan = {
    generated_by: generatedBy,
    status: 'proposed',
    metric: assembled.metric,
    metric_reason: assembled.metric_reason,
    account_avg_metric: assembled.account_avg,
    total_daily_before_cents: totalBefore,
    total_daily_after_cents: totalAfter,
    changes,
    rationale,
  };

  const { data, error } = await supabase
    .from('agent_rebalance_plans')
    .insert({
      generated_by: plan.generated_by,
      status: plan.status,
      metric: plan.metric,
      metric_reason: plan.metric_reason,
      account_avg_metric: plan.account_avg_metric,
      total_daily_before_cents: plan.total_daily_before_cents,
      total_daily_after_cents: plan.total_daily_after_cents,
      changes: plan.changes,
      rationale: plan.rationale,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`saving rebalance plan: ${error?.message}`);
  plan.id = data.id as number;
  return plan;
}

// ---------- Apply ----------

export async function applyRebalancePlan(
  planId: number,
  resolvedBy: string,
): Promise<{ applied: number; failed: number; plan: RebalancePlan | null }> {
  const { data: row, error } = await supabase
    .from('agent_rebalance_plans')
    .select('*')
    .eq('id', planId)
    .single();
  if (error || !row) throw new Error(`load plan: ${error?.message}`);
  if (row.status !== 'proposed') {
    throw new Error(`plan status is ${row.status} — only proposed plans can be applied`);
  }
  const plan = {
    ...row,
    changes: row.changes as ProposedChange[],
  } as RebalancePlan;

  let applied = 0;
  let failed = 0;
  const appliedChanges: ProposedChange[] = [];
  const errorMessages: Array<{ campaign_id: string; error: string }> = [];

  for (const change of plan.changes) {
    try {
      await setDailyBudget(change.campaign_id, change.proposed_daily_cents);
      change.applied = true;
      change.apply_error = null;
      applied++;
      appliedChanges.push(change);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      change.applied = false;
      change.apply_error = m;
      failed++;
      errorMessages.push({ campaign_id: change.campaign_id, error: m });
    }
  }

  const newStatus: RebalancePlan['status'] =
    applied === plan.changes.length ? 'applied' : applied > 0 ? 'partial' : 'rejected';

  await supabase
    .from('agent_rebalance_plans')
    .update({
      status: newStatus,
      resolved_at: new Date().toISOString(),
      resolved_by: resolvedBy,
      applied_changes: appliedChanges,
      error_messages: errorMessages.length > 0 ? errorMessages : null,
      changes: plan.changes,
    })
    .eq('id', planId);

  // Audit each successful change to agent_actions for cross-trail consistency.
  for (const c of appliedChanges) {
    await supabase.from('agent_actions').insert({
      chat_id: null,
      user_handle: resolvedBy.startsWith('user:') ? resolvedBy.slice(5) : 'rebalance',
      command: `rebalance:set_daily_budget`,
      target_campaign_id: c.campaign_id,
      target_campaign_name: c.campaign_name,
      before_state: { daily_budget_cents: c.current_daily_cents, band: c.band },
      after_state: { daily_budget_cents: c.proposed_daily_cents },
      success: true,
    });
  }

  plan.status = newStatus;
  return { applied, failed, plan };
}

export async function rejectRebalancePlan(planId: number, resolvedBy: string): Promise<void> {
  await supabase
    .from('agent_rebalance_plans')
    .update({ status: 'rejected', resolved_at: new Date().toISOString(), resolved_by: resolvedBy })
    .eq('id', planId)
    .eq('status', 'proposed');
}

// ---------- Read helpers ----------

export async function loadOpenProposal(): Promise<RebalancePlan | null> {
  const { data, error } = await supabase
    .from('agent_rebalance_plans')
    .select('*')
    .eq('status', 'proposed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[REBALANCE] loadOpenProposal failed:', error.message);
    return null;
  }
  if (!data) return null;
  return { ...data, changes: data.changes as ProposedChange[] } as RebalancePlan;
}

export async function listRecentPlans(limit = 14): Promise<RebalancePlan[]> {
  const { data, error } = await supabase
    .from('agent_rebalance_plans')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[REBALANCE] listRecentPlans failed:', error.message);
    return [];
  }
  return (data ?? []).map((d) => ({ ...d, changes: d.changes as ProposedChange[] })) as RebalancePlan[];
}

// ---------- Telegram formatting ----------

export function formatPlanForTelegram(plan: RebalancePlan): string {
  const lines: string[] = [];
  const fmt$ = (cents: number) => `$${(cents / 100).toFixed(0)}`;
  const tag = plan.generated_by === 'cron_morning' ? 'Morning rebalance' :
              plan.generated_by === 'cron_evening' ? 'Evening rebalance' :
              plan.generated_by === 'manual' ? 'Manual rebalance' : 'Rebalance';
  lines.push(`${tag} #${plan.id} — 70/20/10 portfolio — metric=${plan.metric.toUpperCase()}`);
  lines.push(`(${plan.metric_reason})`);
  lines.push('');

  if (plan.changes.length === 0) {
    lines.push('No changes — all campaigns are in testing tier or within range.');
    lines.push('');
    lines.push(plan.rationale);
    return lines.join('\n');
  }

  lines.push(
    `Budget: ${fmt$(plan.total_daily_before_cents)}/day → ${fmt$(plan.total_daily_after_cents)}/day ` +
    `(${plan.total_daily_after_cents >= plan.total_daily_before_cents ? '+' : ''}${fmt$(plan.total_daily_after_cents - plan.total_daily_before_cents)})`,
  );
  lines.push('');

  // Group changes by tier for cleaner readability
  const winners = plan.changes.filter((c) => c.band === 'top');
  const underperformers = plan.changes.filter((c) => c.band === 'bottom');
  const experiments = plan.changes.filter((c) => c.band !== 'top' && c.band !== 'bottom');

  if (winners.length > 0) {
    lines.push('WINNERS — scaling up (Bayesian-confirmed):');
    for (const c of winners) {
      const star = c.winner_cycles && c.winner_cycles >= 2 ? ` ⭐×${c.winner_cycles}` : '';
      lines.push(`  ↑ ${c.campaign_name}${star}: ${fmt$(c.current_daily_cents)} → ${fmt$(c.proposed_daily_cents)} (+${c.delta_pct.toFixed(0)}%)`);
      lines.push(`    ${c.reason}`);
    }
    lines.push('');
  }
  if (underperformers.length > 0) {
    lines.push('UNDERPERFORMERS — trimming:');
    for (const c of underperformers) {
      lines.push(`  ↓ ${c.campaign_name}: ${fmt$(c.current_daily_cents)} → ${fmt$(c.proposed_daily_cents)} (${c.delta_pct.toFixed(0)}%)`);
      lines.push(`    ${c.reason}`);
    }
    lines.push('');
  }
  if (experiments.length > 0) {
    lines.push('EXPERIMENTS — budget capped:');
    for (const c of experiments) {
      lines.push(`  = ${c.campaign_name}: ${fmt$(c.current_daily_cents)} → ${fmt$(c.proposed_daily_cents)}`);
      lines.push(`    ${c.reason}`);
    }
    lines.push('');
  }

  lines.push(plan.rationale);
  lines.push('');
  lines.push(`Reply "yes" to apply, /rebalance reject ${plan.id} to dismiss.`);
  return lines.join('\n');
}

// ---------- Recipient discovery (matches briefing/monitor) ----------

async function loadRecipientChatIds(): Promise<string[]> {
  const env = (process.env.BRIEFING_CHAT_IDS ?? '').trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  const { data } = await supabase
    .from('chat_messages')
    .select('chat_id')
    .order('created_at', { ascending: false })
    .limit(500);
  if (!data) return [];
  return [...new Set(data.map((r) => String(r.chat_id)))];
}

async function notifyTelegram(text: string): Promise<void> {
  const recipients = await loadRecipientChatIds();
  for (const cid of recipients) {
    try {
      await bot.sendMessage(cid, text);
    } catch (err) {
      console.error('[REBALANCE] telegram send failed:', err);
    }
  }
}

// ---------- Cron entry points ----------

export async function runRebalanceTick(
  generatedBy: 'cron_morning' | 'cron_evening',
): Promise<{ plan_id: number; changes: number; metric: Metric }> {
  const plan = await generateRebalanceProposal(generatedBy);
  if (plan.changes.length === 0) {
    console.log(`[rebalance] ${generatedBy}: no changes proposed`);
    return { plan_id: plan.id ?? -1, changes: 0, metric: plan.metric };
  }
  await notifyTelegram(formatPlanForTelegram(plan));
  return { plan_id: plan.id ?? -1, changes: plan.changes.length, metric: plan.metric };
}

// CLI: `tsx agents/rebalance.ts [morning|evening|manual]`
import { fileURLToPath } from 'node:url';
const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  const mode = (process.argv[2] ?? 'manual') as 'morning' | 'evening' | 'manual';
  const gb: RebalancePlan['generated_by'] =
    mode === 'morning' ? 'cron_morning' : mode === 'evening' ? 'cron_evening' : 'manual';
  generateRebalanceProposal(gb)
    .then((p) => {
      console.log(formatPlanForTelegram(p));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
