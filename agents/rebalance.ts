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

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN must be set for rebalance');
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ---------- Tunables ----------

const BAND_TOP_THRESHOLD = 0.7;       // metric ≤ 70% of account avg → top
const BAND_BOTTOM_THRESHOLD = 1.3;    // metric ≥ 130% of account avg → bottom
const TOP_BUMP_PCT = 20;
const BOTTOM_CUT_PCT = 20;
const MAX_CHANGE_PCT_PER_PASS = 50;   // Sprint 1 hard guardrail
const MIN_DAILY_BUDGET_CENTS = 500;   // $5/day floor
const MAX_DAILY_BUDGET_CENTS = 50000; // $500/day ceiling per single change
const MIN_DAYS_ACTIVE = 3;
const MIN_LEADS_WINDOW = 20;
const CPB_MIN_FORWARDS_14D = 30;

// ---------- Types ----------

export type Metric = 'cpl' | 'cpb';
export type Band = 'top' | 'middle' | 'bottom' | 'skip_insufficient_data' | 'skip_open_signal';

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

  // Now classify into top/middle/bottom
  if (account_avg != null) {
    for (const r of rows) {
      if (r.band !== 'middle') continue;
      const ratio = (r.metric_value ?? 0) / account_avg;
      if (ratio <= BAND_TOP_THRESHOLD) {
        r.band = 'top';
        r.reason = `${metric.toUpperCase()} $${r.metric_value!.toFixed(0)} vs account avg $${account_avg.toFixed(0)} (${Math.round((1 - ratio) * 100)}% better)`;
      } else if (ratio >= BAND_BOTTOM_THRESHOLD) {
        r.band = 'bottom';
        r.reason = `${metric.toUpperCase()} $${r.metric_value!.toFixed(0)} vs account avg $${account_avg.toFixed(0)} (${Math.round((ratio - 1) * 100)}% worse)`;
      } else {
        r.band = 'middle';
        r.reason = `${metric.toUpperCase()} $${r.metric_value!.toFixed(0)} within ±30% of avg $${account_avg.toFixed(0)}`;
      }
    }
  }

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
    if (r.band !== 'top' && r.band !== 'bottom') continue;
    const current = r.current_daily_cents ?? 0;
    if (current <= 0) continue;
    const target = r.band === 'top' ? TOP_BUMP_PCT : -BOTTOM_CUT_PCT;
    const { newCents, effectivePct } = clampDelta(current, target);
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
  const middle = assembled.rows.filter((r) => r.band === 'middle').length;

  const rationale =
    `metric=${assembled.metric.toUpperCase()} (${assembled.metric_reason}). ` +
    `${changes.length} change${changes.length === 1 ? '' : 's'} proposed across ` +
    `${assembled.rows.filter((r) => r.band === 'top').length} top + ` +
    `${assembled.rows.filter((r) => r.band === 'bottom').length} bottom. ` +
    `${middle} middle untouched, ${skippedSignal} skipped for open signals, ${skippedData} skipped for insufficient data.`;

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
  lines.push(`${tag} proposal #${plan.id} — metric=${plan.metric.toUpperCase()}`);
  lines.push(`(${plan.metric_reason})`);
  lines.push('');
  if (plan.changes.length === 0) {
    lines.push('No changes proposed — every active campaign is within ±30% of account avg, or skipped.');
    lines.push('');
    lines.push(plan.rationale);
    return lines.join('\n');
  }
  lines.push(
    `Total daily: ${fmt$(plan.total_daily_before_cents)} → ${fmt$(plan.total_daily_after_cents)} ` +
      `(${plan.total_daily_after_cents >= plan.total_daily_before_cents ? '+' : ''}${fmt$(plan.total_daily_after_cents - plan.total_daily_before_cents)})`,
  );
  lines.push('');
  for (const c of plan.changes) {
    const arrow = c.delta_cents >= 0 ? '+' : '';
    lines.push(
      `${c.band === 'top' ? '↑' : '↓'} ${c.campaign_name}: ${fmt$(c.current_daily_cents)} → ${fmt$(c.proposed_daily_cents)} (${arrow}${c.delta_pct.toFixed(0)}%)`,
    );
    lines.push(`   ${c.reason}`);
  }
  lines.push('');
  lines.push(plan.rationale);
  lines.push('');
  lines.push(
    `Reply "yes" to apply all, /rebalance reject ${plan.id} to dismiss. Auto-expires when next pass runs.`,
  );
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
