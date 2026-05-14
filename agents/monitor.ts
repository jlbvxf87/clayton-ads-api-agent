import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { supabase } from './supabase.js';
import {
  listCampaigns,
  getCampaignInsights,
  pauseCampaign,
  extractLeads,
  type Campaign,
  type CampaignInsight,
} from './meta.js';
import {
  requirePermission,
  recordPermissionUsage,
  type PermissionKind,
} from './permissions.js';
import { runJudgmentOnSignal, formatJudgmentForTelegram } from './judgment.js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ACCOUNT_TZ = process.env.ACCOUNT_TZ ?? 'America/Los_Angeles';

if (!TELEGRAM_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN must be set for monitor');
}

// Single bot instance for sending. polling=false because the main bot.ts already polls.
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ---------- Types ----------

export type SignalKind =
  | 'cpl_spike'
  | 'zero_leads'
  | 'ctr_drop'
  | 'spend_velocity'
  | 'frequency_creep';

export type Severity = 'info' | 'notice' | 'alert' | 'critical';

export interface DetectedSignal {
  signal_kind: SignalKind;
  severity: Severity;
  target_type: 'campaign' | 'adset' | 'ad' | 'pixel' | 'account';
  target_id: string;
  target_name: string | null;
  current_value: number | null;
  baseline_value: number | null;
  delta_pct: number | null;
  message: string;
  data?: Record<string, unknown>;
  // If set, the monitor will attempt the action when a standing order covers it.
  recommended_action?: {
    kind: PermissionKind;
    tool: 'pause_campaign';
    params: { campaign_id: string; campaign_name: string | null };
  };
}

export interface InboxRow extends DetectedSignal {
  id: number;
  created_at: string;
  last_seen_at: string;
  surfaced_to_telegram: boolean;
  surfaced_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  auto_action_taken: boolean;
  auto_action_permission_id: number | null;
}

// ---------- Recipient discovery (matches briefing.ts) ----------

async function loadRecipientChatIds(): Promise<string[]> {
  const env = (process.env.BRIEFING_CHAT_IDS ?? '').trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  const { data, error } = await supabase
    .from('chat_messages')
    .select('chat_id')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error || !data) return [];
  const seen = new Set<string>();
  for (const row of data) seen.add(String(row.chat_id));
  return [...seen];
}

// ---------- Detection ----------

interface CampaignContext {
  campaign: Campaign;
  today?: CampaignInsight;
  last7d?: CampaignInsight;
}

async function buildContexts(): Promise<CampaignContext[]> {
  const [campaigns, today, last7d] = await Promise.all([
    listCampaigns(),
    getCampaignInsights('today'),
    getCampaignInsights('last_7d'),
  ]);
  const t = new Map(today.map((r) => [r.campaign_id, r] as const));
  const w = new Map(last7d.map((r) => [r.campaign_id, r] as const));
  return campaigns.map((c) => ({ campaign: c, today: t.get(c.id), last7d: w.get(c.id) }));
}

function hoursElapsedToday(): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ACCOUNT_TZ,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const hours = (h === 24 ? 0 : h) + m / 60;
  return Math.max(0.1, hours);
}

export function detectSignals(contexts: CampaignContext[]): DetectedSignal[] {
  const out: DetectedSignal[] = [];
  const hoursIn = hoursElapsedToday();
  const fractionOfDay = Math.min(1, hoursIn / 24);

  for (const c of contexts) {
    const status = c.campaign.effective_status ?? c.campaign.status;
    if (status !== 'ACTIVE') continue;

    const todaySpend = c.today?.spend ? Number(c.today.spend) : 0;
    const todayLeads = c.today ? extractLeads(c.today) : 0;
    const todayClicks = c.today?.clicks ? Number(c.today.clicks) : 0;
    const todayImpr = c.today?.impressions ? Number(c.today.impressions) : 0;
    const todayCtr =
      todayImpr > 0 ? (todayClicks / todayImpr) * 100 : c.today?.ctr ? Number(c.today.ctr) : null;
    const todayCpl = todayLeads > 0 ? todaySpend / todayLeads : null;

    const wkSpend = c.last7d?.spend ? Number(c.last7d.spend) : 0;
    const wkLeads = c.last7d ? extractLeads(c.last7d) : 0;
    const wkClicks = c.last7d?.clicks ? Number(c.last7d.clicks) : 0;
    const wkImpr = c.last7d?.impressions ? Number(c.last7d.impressions) : 0;
    const wkCpl = wkLeads > 0 ? wkSpend / wkLeads : null;
    const wkCtr =
      wkImpr > 0 ? (wkClicks / wkImpr) * 100 : c.last7d?.ctr ? Number(c.last7d.ctr) : null;

    const targetBase = {
      target_type: 'campaign' as const,
      target_id: c.campaign.id,
      target_name: c.campaign.name,
    };

    // 1. CPL spike — today CPL > 1.5× 7d avg, only after $20 spent today.
    if (todayCpl != null && wkCpl != null && todaySpend >= 20 && todayCpl > wkCpl * 1.5) {
      const ratio = todayCpl / wkCpl;
      const sev: Severity = ratio >= 2.5 ? 'critical' : ratio >= 2 ? 'alert' : 'notice';
      out.push({
        ...targetBase,
        signal_kind: 'cpl_spike',
        severity: sev,
        current_value: todayCpl,
        baseline_value: wkCpl,
        delta_pct: ((todayCpl - wkCpl) / wkCpl) * 100,
        message: `${c.campaign.name}: today CPL $${todayCpl.toFixed(0)} vs 7d $${wkCpl.toFixed(0)} (${ratio.toFixed(1)}×)`,
        data: { today_spend: todaySpend, today_leads: todayLeads, week_spend: wkSpend, week_leads: wkLeads },
        recommended_action:
          ratio >= 2
            ? {
                kind: 'pause',
                tool: 'pause_campaign',
                params: { campaign_id: c.campaign.id, campaign_name: c.campaign.name },
              }
            : undefined,
      });
    }

    // 2. Zero leads with significant spend.
    if (todayLeads === 0 && todaySpend >= 30) {
      const sev: Severity = todaySpend >= 100 ? 'critical' : todaySpend >= 50 ? 'alert' : 'notice';
      out.push({
        ...targetBase,
        signal_kind: 'zero_leads',
        severity: sev,
        current_value: todaySpend,  // spend, not leads — so de-dup doubled-check is meaningful
        baseline_value: null,
        delta_pct: null,
        message: `${c.campaign.name}: $${todaySpend.toFixed(0)} spent today, 0 leads`,
        data: { today_spend: todaySpend, hours_in: hoursIn },
        recommended_action:
          todaySpend >= 100
            ? {
                kind: 'pause',
                tool: 'pause_campaign',
                params: { campaign_id: c.campaign.id, campaign_name: c.campaign.name },
              }
            : undefined,
      });
    }

    // 3. CTR drop — today < 60% of 7d avg.
    if (todayCtr != null && wkCtr != null && wkCtr > 0.5 && todaySpend >= 15) {
      const ratio = todayCtr / wkCtr;
      if (ratio < 0.6) {
        const sev: Severity = ratio < 0.4 ? 'alert' : 'notice';
        out.push({
          ...targetBase,
          signal_kind: 'ctr_drop',
          severity: sev,
          current_value: todayCtr,
          baseline_value: wkCtr,
          delta_pct: ((todayCtr - wkCtr) / wkCtr) * 100,
          message: `${c.campaign.name}: CTR ${todayCtr.toFixed(2)}% vs 7d ${wkCtr.toFixed(2)}% (${(ratio * 100).toFixed(0)}% of normal)`,
        });
      }
    }

    // 4. Spend velocity — pace > 1.5× expected against daily_budget.
    const dailyBudget =
      c.campaign.daily_budget != null ? Number(c.campaign.daily_budget) / 100 : null;
    if (dailyBudget != null && dailyBudget > 0 && fractionOfDay > 0.05) {
      const expected = dailyBudget * fractionOfDay;
      const ratio = todaySpend / expected;
      if (ratio > 1.5) {
        const sev: Severity = ratio > 2.5 ? 'alert' : 'notice';
        out.push({
          ...targetBase,
          signal_kind: 'spend_velocity',
          severity: sev,
          current_value: todaySpend,
          baseline_value: expected,
          delta_pct: ((todaySpend - expected) / expected) * 100,
          message: `${c.campaign.name}: spent $${todaySpend.toFixed(0)} of $${dailyBudget.toFixed(0)} budget by hour ${hoursIn.toFixed(1)} (${ratio.toFixed(1)}× expected pace)`,
          data: { hours_in: hoursIn, daily_budget: dailyBudget },
        });
      }
    }
  }

  return out;
}

// ---------- Inbox persistence ----------

async function upsertInboxItem(
  sig: DetectedSignal,
): Promise<{ id: number; isNew: boolean; lastSurfacedAt: string | null; lastSurfacedValue: number | null } | null> {
  // Look up an open row for the same kind+target.
  const { data: existing, error: readErr } = await supabase
    .from('agent_inbox')
    .select('id, severity, surfaced_to_telegram, surfaced_at, current_value')
    .eq('signal_kind', sig.signal_kind)
    .eq('target_id', sig.target_id)
    .is('resolved_at', null)
    .maybeSingle();
  if (readErr) {
    console.error('[MONITOR] inbox read failed:', readErr.message);
    return null;
  }

  if (existing) {
    // Update last_seen_at and possibly escalate severity.
    const sevRank: Record<Severity, number> = { info: 0, notice: 1, alert: 2, critical: 3 };
    const newSev = sevRank[sig.severity] > sevRank[existing.severity as Severity] ? sig.severity : existing.severity;
    const { error: updErr } = await supabase
      .from('agent_inbox')
      .update({
        last_seen_at: new Date().toISOString(),
        severity: newSev,
        current_value: sig.current_value,
        baseline_value: sig.baseline_value,
        delta_pct: sig.delta_pct,
        message: sig.message,
        data: sig.data ?? null,
      })
      .eq('id', existing.id);
    if (updErr) console.error('[MONITOR] inbox update failed:', updErr.message);
    return {
      id: existing.id,
      isNew: false,
      lastSurfacedAt: (existing.surfaced_at as string | null) ?? null,
      lastSurfacedValue: existing.current_value != null ? Number(existing.current_value) : null,
    };
  }

  const { data: inserted, error: insErr } = await supabase
    .from('agent_inbox')
    .insert({
      signal_kind: sig.signal_kind,
      severity: sig.severity,
      target_type: sig.target_type,
      target_id: sig.target_id,
      target_name: sig.target_name,
      current_value: sig.current_value,
      baseline_value: sig.baseline_value,
      delta_pct: sig.delta_pct,
      message: sig.message,
      data: sig.data ?? null,
    })
    .select('id')
    .single();
  if (insErr || !inserted) {
    console.error('[MONITOR] inbox insert failed:', insErr?.message);
    return null;
  }
  return { id: inserted.id as number, isNew: true, lastSurfacedAt: null, lastSurfacedValue: null };
}

async function autoResolveSignalsThatStopped(active: DetectedSignal[]): Promise<number> {
  // Anything currently open that ISN'T in `active` got self-resolved.
  const activeKey = (s: DetectedSignal | InboxRow): string =>
    `${s.signal_kind}:${s.target_id}`;
  const activeSet = new Set(active.map(activeKey));

  const { data: open } = await supabase
    .from('agent_inbox')
    .select('id, signal_kind, target_id, target_name')
    .is('resolved_at', null);
  if (!open) return 0;

  let n = 0;
  for (const row of open) {
    const key = `${row.signal_kind}:${row.target_id}`;
    if (activeSet.has(key)) continue;
    await supabase
      .from('agent_inbox')
      .update({
        resolved_at: new Date().toISOString(),
        resolved_by: 'auto:self_resolved',
        resolution_note: 'condition no longer holds',
      })
      .eq('id', row.id);
    n++;
  }
  return n;
}

// ---------- Auto-act when a standing order covers a recommended action ----------

async function attemptAutoAction(
  inboxId: number,
  sig: DetectedSignal,
): Promise<{ acted: boolean; permId?: number; emergency?: boolean; error?: string }> {
  if (!sig.recommended_action) return { acted: false };

  // Emergency auto-pause: zero_leads + spend ≥ $300 bypasses the grant requirement.
  // A campaign burning $300+ with zero leads is unambiguously broken — pause first, investigate after.
  const todaySpend = typeof sig.data?.today_spend === 'number' ? (sig.data.today_spend as number) : 0;
  if (
    sig.signal_kind === 'zero_leads' &&
    sig.recommended_action.tool === 'pause_campaign' &&
    todaySpend >= 300
  ) {
    try {
      await pauseCampaign(sig.recommended_action.params.campaign_id);
      await supabase.from('agent_actions').insert({
        chat_id: null,
        user_handle: 'monitor:emergency',
        command: 'auto:pause_campaign',
        target_campaign_id: sig.recommended_action.params.campaign_id,
        target_campaign_name: sig.recommended_action.params.campaign_name,
        before_state: { signal_kind: sig.signal_kind, spend: todaySpend, leads: 0 },
        success: true,
        permission_id: null,
      });
      await supabase
        .from('agent_inbox')
        .update({
          resolved_at: new Date().toISOString(),
          resolved_by: 'auto:emergency_spend',
          resolution_note: `emergency auto-paused — $${todaySpend.toFixed(0)} spent with 0 leads`,
          auto_action_taken: true,
        })
        .eq('id', inboxId);
      return { acted: true, emergency: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error('[MONITOR] emergency auto-pause failed:', m);
      return { acted: false, error: m };
    }
  }

  const guard = await requirePermission(sig.recommended_action.kind, {
    campaign_id: sig.recommended_action.params.campaign_id,
    campaign_name: sig.recommended_action.params.campaign_name,
  });
  if (!guard.ok) return { acted: false };

  try {
    if (sig.recommended_action.tool === 'pause_campaign') {
      await pauseCampaign(sig.recommended_action.params.campaign_id);
    }
    await recordPermissionUsage(guard.permission_id);
    await supabase
      .from('agent_actions')
      .insert({
        chat_id: null,
        user_handle: 'monitor',
        command: `auto:${sig.recommended_action.tool}`,
        target_campaign_id: sig.recommended_action.params.campaign_id,
        target_campaign_name: sig.recommended_action.params.campaign_name,
        before_state: { signal_kind: sig.signal_kind, current: sig.current_value, baseline: sig.baseline_value },
        success: true,
        permission_id: guard.permission_id,
      });
    await supabase
      .from('agent_inbox')
      .update({
        resolved_at: new Date().toISOString(),
        resolved_by: `auto:permission_${guard.permission_id}`,
        resolution_note: `auto-paused under standing order #${guard.permission_id}`,
        auto_action_taken: true,
        auto_action_permission_id: guard.permission_id,
      })
      .eq('id', inboxId);
    return { acted: true, permId: guard.permission_id };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[MONITOR] auto action ${sig.recommended_action.tool} failed:`, m);
    return { acted: false, error: m };
  }
}

// ---------- Telegram surfacing ----------

const SEVERITY_PREFIX: Record<Severity, string> = {
  critical: '[CRITICAL]',
  alert: '[ALERT]',
  notice: '[notice]',
  info: '[info]',
};

async function notifyTelegram(text: string): Promise<void> {
  const recipients = await loadRecipientChatIds();
  for (const cid of recipients) {
    try {
      await bot.sendMessage(cid, text);
    } catch (err) {
      console.error('[MONITOR] telegram send failed:', err);
    }
  }
}

// Per-tick cap on expensive judgment-loop LLM calls so a chaotic tick can't
// spike costs. Reset on each runMonitorTick invocation.
const JUDGMENT_PER_TICK_CAP = 3;

async function surfaceItem(
  inboxId: number,
  sig: DetectedSignal,
  autoActed: { acted: boolean; permId?: number; emergency?: boolean; error?: string },
  tickJudgmentBudget: { remaining: number },
): Promise<void> {
  if (autoActed.acted) {
    const text = autoActed.emergency
      ? `[EMERGENCY PAUSED] ${sig.message}\nSpend exceeded $300 with 0 leads — paused automatically. Check pixel/funnel before re-activating.`
      : `${SEVERITY_PREFIX[sig.severity]} auto-resolved: ${sig.message}\nStanding order #${autoActed.permId} covered this — paused automatically.`;
    // Mark surfaced_at before sending so cooldown holds even if Telegram fails.
    const { error: markErr } = await supabase
      .from('agent_inbox')
      .update({ surfaced_to_telegram: true, surfaced_at: new Date().toISOString() })
      .eq('id', inboxId);
    if (markErr) console.error('[MONITOR] surfaced_at update failed (auto-act):', markErr.message);
    await notifyTelegram(text);
    return;
  }

  // Non-auto-act path. For alert/critical with budget remaining, run the
  // judgment loop and surface its rich output. Otherwise canned message.
  let text: string;
  if (
    (sig.severity === 'critical' || sig.severity === 'alert') &&
    tickJudgmentBudget.remaining > 0
  ) {
    tickJudgmentBudget.remaining -= 1;
    try {
      const r = await runJudgmentOnSignal(inboxId);
      if ('error' in r) {
        text = canonicalSurfaceText(inboxId, sig, autoActed.error);
      } else {
        text = formatJudgmentForTelegram(r.judgment, sig.severity);
        if (autoActed.error) {
          text += `\n\n⚠️ Auto-pause attempted but failed: ${autoActed.error}`;
        }
        await supabase
          .from('agent_judgments')
          .update({ surfaced_to_telegram: true, surfaced_at: new Date().toISOString() })
          .eq('id', r.saved_id ?? -1);
      }
    } catch (err) {
      console.error('[MONITOR] judgment loop failed:', err);
      text = canonicalSurfaceText(inboxId, sig, autoActed.error);
    }
  } else {
    text = canonicalSurfaceText(inboxId, sig, autoActed.error);
  }

  // Mark surfaced_at before sending so cooldown holds even if Telegram fails.
  const { error: markErr } = await supabase
    .from('agent_inbox')
    .update({ surfaced_to_telegram: true, surfaced_at: new Date().toISOString() })
    .eq('id', inboxId);
  if (markErr) console.error('[MONITOR] surfaced_at update failed:', markErr.message);
  await notifyTelegram(text);
}

function canonicalSurfaceText(inboxId: number, sig: DetectedSignal, autoActError?: string): string {
  const lines: string[] = [];
  lines.push(`${SEVERITY_PREFIX[sig.severity]} ${sig.message}`);

  if (autoActError) {
    lines.push(`⚠️ Auto-pause attempted but failed: ${autoActError}`);
    if (sig.recommended_action) {
      lines.push(
        `  Manual: /pause ${sig.recommended_action.params.campaign_name ?? sig.recommended_action.params.campaign_id}`,
      );
    }
  } else if (sig.recommended_action) {
    lines.push(
      `Suggested: pause ${sig.recommended_action.params.campaign_name ?? sig.recommended_action.params.campaign_id}.`,
    );
    lines.push(
      `  Authorize once: /pause ${sig.recommended_action.params.campaign_name ?? sig.recommended_action.params.campaign_id}`,
    );
    lines.push(
      `  Authorize ongoing: /grant pause campaign="${sig.recommended_action.params.campaign_name}" expires=24h`,
    );
  }
  lines.push(`(/inbox to see all open items, /inbox resolve ${inboxId} to dismiss)`);
  return lines.join('\n');
}

const RESURFACE_HOURS: Record<Severity, number> = {
  critical: 4,
  alert: 8,
  notice: Infinity,
  info: Infinity,
};

function shouldSurface(
  sig: DetectedSignal,
  isNew: boolean,
  lastSurfacedAt: string | null,
  lastSurfacedValue: number | null,
): boolean {
  if (sig.severity === 'notice' || sig.severity === 'info') return false;

  // First detection — always surface.
  if (isNew || !lastSurfacedAt) return true;

  const hoursSince = (Date.now() - new Date(lastSurfacedAt).getTime()) / 3_600_000;
  const cooldown = RESURFACE_HOURS[sig.severity];

  // Within cooldown window: only re-surface if spend has materially worsened (doubled).
  if (hoursSince < cooldown) {
    if (
      lastSurfacedValue !== null &&
      sig.current_value !== undefined &&
      (sig.current_value ?? 0) >= lastSurfacedValue * 2
    ) {
      return true;
    }
    return false;
  }

  return true;
}

// ---------- Main tick ----------

export async function runMonitorTick(): Promise<{
  detected: number;
  new_inbox: number;
  surfaced: number;
  auto_resolved_open: number;
  auto_acted: number;
}> {
  const contexts = await buildContexts();
  const signals = detectSignals(contexts);

  let newInbox = 0;
  let surfaced = 0;
  let autoActed = 0;
  const tickJudgmentBudget = { remaining: JUDGMENT_PER_TICK_CAP };

  for (const sig of signals) {
    const up = await upsertInboxItem(sig);
    if (!up) continue;
    if (up.isNew) newInbox++;

    // Try auto-act on every detection (even pre-existing rows) — a standing order
    // grant after the row was opened should still close it on the next tick.
    const autoActResult = await attemptAutoAction(up.id, sig);
    if (autoActResult.acted) {
      autoActed++;
      await surfaceItem(up.id, sig, autoActResult, tickJudgmentBudget);
      surfaced++;
      continue;
    }

    if (shouldSurface(sig, up.isNew, up.lastSurfacedAt, up.lastSurfacedValue)) {
      await surfaceItem(up.id, sig, autoActResult, tickJudgmentBudget);
      surfaced++;
    }
  }

  const autoResolvedOpen = await autoResolveSignalsThatStopped(signals);

  return { detected: signals.length, new_inbox: newInbox, surfaced, auto_resolved_open: autoResolvedOpen, auto_acted: autoActed };
}

// ---------- Inbox queries ----------

export async function listOpenInbox(limit = 50): Promise<InboxRow[]> {
  const { data, error } = await supabase
    .from('agent_inbox')
    .select('*')
    .is('resolved_at', null)
    .order('severity', { ascending: false })
    .order('last_seen_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[MONITOR] listOpenInbox failed:', error.message);
    return [];
  }
  return (data ?? []) as InboxRow[];
}

export async function listRecentInbox(hours = 24, limit = 100): Promise<InboxRow[]> {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('agent_inbox')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[MONITOR] listRecentInbox failed:', error.message);
    return [];
  }
  return (data ?? []) as InboxRow[];
}

export async function resolveInboxItem(
  id: number,
  resolvedBy: string,
  note: string | null = null,
): Promise<boolean> {
  const { error } = await supabase
    .from('agent_inbox')
    .update({ resolved_at: new Date().toISOString(), resolved_by: resolvedBy, resolution_note: note })
    .eq('id', id)
    .is('resolved_at', null);
  if (error) {
    console.error('[MONITOR] resolveInboxItem failed:', error.message);
    return false;
  }
  return true;
}

// CLI entry point: `tsx agents/monitor.ts` runs one tick.
import { fileURLToPath } from 'node:url';
const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  runMonitorTick()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
