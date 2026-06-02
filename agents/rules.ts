import { supabase } from './supabase.js';
import {
  listCampaigns,
  getCampaignInsights,
  extractLeads,
  pauseCampaign,
  type Campaign,
  type CampaignInsight,
} from './meta.js';
import { loadActiveObservations } from './memory.js';

export interface AgentRule {
  id: number;
  name: string;
  description: string;
  rule_kind: string;
  params: Record<string, unknown>;
  auto_execute: boolean;
  active: boolean;
  trigger_count: number;
}

export interface RuleTrigger {
  rule: AgentRule;
  reason: string;            // human-readable why-this-fired
  target_campaign_id?: string;
  target_campaign_name?: string;
  proposed_action?: string;  // human-readable what-would-happen
  executed?: boolean;
  execution_error?: string;
}

export async function loadActiveRules(): Promise<AgentRule[]> {
  const { data, error } = await supabase
    .from('agent_rules')
    .select('id, name, description, rule_kind, params, auto_execute, active, trigger_count')
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('loadActiveRules failed:', error.message);
    return [];
  }
  return (data ?? []) as AgentRule[];
}

export async function createRule(args: {
  chatId?: number | string;
  name: string;
  description: string;
  rule_kind: string;
  params: Record<string, unknown>;
  auto_execute?: boolean;
}): Promise<number | null> {
  const { data, error } = await supabase
    .from('agent_rules')
    .insert({
      chat_id: args.chatId != null ? String(args.chatId) : null,
      name: args.name,
      description: args.description,
      rule_kind: args.rule_kind,
      params: args.params,
      auto_execute: args.auto_execute ?? false,
    })
    .select('id')
    .single();
  if (error) {
    console.warn('createRule failed:', error.message);
    return null;
  }
  return (data?.id as number) ?? null;
}

export async function setRuleActive(id: number, active: boolean): Promise<void> {
  await supabase.from('agent_rules').update({ active }).eq('id', id);
}

async function bumpRuleEvaluation(id: number, triggered: boolean): Promise<void> {
  const update: Record<string, unknown> = { last_evaluated_at: new Date().toISOString() };
  if (triggered) {
    update.last_triggered_at = new Date().toISOString();
    // Use raw RPC trick: increment by reading + writing
    const { data } = await supabase
      .from('agent_rules')
      .select('trigger_count')
      .eq('id', id)
      .single();
    update.trigger_count = (data?.trigger_count ?? 0) + 1;
  }
  await supabase.from('agent_rules').update(update).eq('id', id);
}

// ---------- Rule evaluation ----------

interface CampaignContext {
  campaign: Campaign;
  today?: CampaignInsight;
  yesterday?: CampaignInsight;
  last7d?: CampaignInsight;
}

async function buildCampaignContexts(): Promise<CampaignContext[]> {
  const [campaigns, today, yesterday, last7d] = await Promise.all([
    listCampaigns(),
    getCampaignInsights('today'),
    getCampaignInsights('yesterday'),
    getCampaignInsights('last_7d'),
  ]);
  const idx = <T extends { campaign_id: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.campaign_id, r] as const));
  const todayById = idx(today);
  const ydayById = idx(yesterday);
  const week = idx(last7d);
  return campaigns.map((c) => ({
    campaign: c,
    today: todayById.get(c.id),
    yesterday: ydayById.get(c.id),
    last7d: week.get(c.id),
  }));
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/**
 * Evaluate every active rule against the current account state.
 * Returns a list of triggers (without executing). Caller decides whether to execute.
 */
export async function evaluateAllRules(): Promise<RuleTrigger[]> {
  const rules = await loadActiveRules();
  if (rules.length === 0) return [];

  const contexts = await buildCampaignContexts();
  const triggers: RuleTrigger[] = [];

  for (const rule of rules) {
    let triggered = false;
    try {
      const ruleTriggers = await evaluateRule(rule, contexts);
      for (const t of ruleTriggers) {
        triggers.push(t);
        triggered = true;
      }
    } catch (err) {
      console.warn(`rule ${rule.id} (${rule.name}) failed:`, err);
    }
    await bumpRuleEvaluation(rule.id, triggered);
  }
  return triggers;
}

async function evaluateRule(rule: AgentRule, contexts: CampaignContext[]): Promise<RuleTrigger[]> {
  const out: RuleTrigger[] = [];

  switch (rule.rule_kind) {
    case 'pause_high_cpl': {
      // params: { cpl_threshold_dollars: number, min_spend_dollars?: number, window?: 'today'|'yesterday'|'last_7d' }
      const threshold = num(rule.params.cpl_threshold_dollars, 999);
      const minSpend = num(rule.params.min_spend_dollars, 50);
      const window = (rule.params.window as 'today' | 'yesterday' | 'last_7d') ?? 'last_7d';

      for (const c of contexts) {
        const ins = c[window === 'today' ? 'today' : window === 'yesterday' ? 'yesterday' : 'last7d'];
        if (!ins) continue;
        const spend = num(ins.spend);
        if (spend < minSpend) continue;
        const leads = extractLeads(ins);
        if (leads === 0) continue;
        const cpl = spend / leads;
        if (cpl > threshold) {
          out.push({
            rule,
            reason: `${c.campaign.name}: CPL $${cpl.toFixed(2)} over ${window} (spend $${spend.toFixed(0)}, leads ${leads}) exceeds threshold $${threshold}`,
            target_campaign_id: c.campaign.id,
            target_campaign_name: c.campaign.name,
            proposed_action: `pause campaign "${c.campaign.name}"`,
          });
        }
      }
      return out;
    }

    case 'pause_zero_leads': {
      // params: { min_spend_dollars: number, window?: 'today'|'yesterday' }
      const minSpend = num(rule.params.min_spend_dollars, 100);
      const window = (rule.params.window as 'today' | 'yesterday') ?? 'today';

      for (const c of contexts) {
        const status = c.campaign.effective_status ?? c.campaign.status;
        if (status !== 'ACTIVE') continue;
        const ins = c[window === 'today' ? 'today' : 'yesterday'];
        if (!ins) continue;
        const spend = num(ins.spend);
        const leads = extractLeads(ins);
        if (spend >= minSpend && leads === 0) {
          out.push({
            rule,
            reason: `${c.campaign.name}: spent $${spend.toFixed(0)} ${window} with 0 leads`,
            target_campaign_id: c.campaign.id,
            target_campaign_name: c.campaign.name,
            proposed_action: `pause campaign "${c.campaign.name}" — likely tracking issue or weak creative`,
          });
        }
      }
      return out;
    }

    case 'cap_daily_spend': {
      // params: { cap_dollars: number }
      const cap = num(rule.params.cap_dollars, 500);
      const totalToday = contexts.reduce((s, c) => s + num(c.today?.spend), 0);
      if (totalToday > cap) {
        out.push({
          rule,
          reason: `Total today's spend $${totalToday.toFixed(0)} exceeds daily cap $${cap}`,
          proposed_action: 'pause every ACTIVE campaign until tomorrow',
        });
      }
      return out;
    }

    case 'alert_anomaly': {
      // params: { kind: 'spend_spike'|'cpl_spike', factor: number }
      // Compares today vs trailing 7-day daily average. Notify only.
      const kind = (rule.params.kind as 'spend_spike' | 'cpl_spike') ?? 'spend_spike';
      const factor = num(rule.params.factor, 2);
      for (const c of contexts) {
        const t = c.today;
        const w = c.last7d;
        if (!t || !w) continue;
        const todaySpend = num(t.spend);
        const weekDaily = num(w.spend) / 7;
        if (kind === 'spend_spike' && weekDaily > 0 && todaySpend > weekDaily * factor) {
          out.push({
            rule,
            reason: `${c.campaign.name}: today spend $${todaySpend.toFixed(0)} is ${(todaySpend / weekDaily).toFixed(1)}× the trailing-7 daily average $${weekDaily.toFixed(0)}`,
            target_campaign_id: c.campaign.id,
            target_campaign_name: c.campaign.name,
          });
        }
        if (kind === 'cpl_spike') {
          const todayLeads = extractLeads(t);
          const weekLeads = extractLeads(w);
          const todayCpl = todayLeads > 0 ? todaySpend / todayLeads : null;
          const weekCpl = weekLeads > 0 ? num(w.spend) / weekLeads : null;
          if (todayCpl != null && weekCpl != null && weekCpl > 0 && todayCpl > weekCpl * factor) {
            out.push({
              rule,
              reason: `${c.campaign.name}: today CPL $${todayCpl.toFixed(2)} is ${(todayCpl / weekCpl).toFixed(1)}× the trailing-7 CPL $${weekCpl.toFixed(2)}`,
              target_campaign_id: c.campaign.id,
              target_campaign_name: c.campaign.name,
            });
          }
        }
      }
      return out;
    }

    case 'burn_rate_circuit_breaker': {
      // params: { daily_cap_dollars: number }
      // Projects today's spend to EOD; targets worst ACTIVE campaign as the relief valve.
      const cap = num(rule.params.daily_cap_dollars, 300);
      const tzStr = process.env.ACCOUNT_TZ ?? 'America/Los_Angeles';
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tzStr, hour: 'numeric', minute: 'numeric', hour12: false,
      });
      const parts = fmt.formatToParts(new Date());
      const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 12);
      const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
      const hoursIn = Math.max(0.5, (h === 24 ? 0 : h) + m / 60);
      const totalToday = contexts.reduce((s, c) => s + num(c.today?.spend), 0);
      const projected = (totalToday / hoursIn) * 24;

      if (projected > cap) {
        let worst: CampaignContext | null = null;
        let worstScore = -1;
        for (const c of contexts) {
          const status = c.campaign.effective_status ?? c.campaign.status;
          if (status !== 'ACTIVE') continue;
          const spend = num(c.today?.spend);
          if (spend <= 0) continue;
          const leads = c.today ? extractLeads(c.today) : 0;
          // 0-lead campaigns penalized heavily; otherwise score by CPL
          const score = leads === 0 ? spend * 100 : spend / leads;
          if (score > worstScore) { worstScore = score; worst = c; }
        }
        if (worst) {
          out.push({
            rule,
            reason: `Projected daily spend $${projected.toFixed(0)} ($${totalToday.toFixed(0)} in ${hoursIn.toFixed(1)}h) exceeds cap $${cap}`,
            target_campaign_id: worst.campaign.id,
            target_campaign_name: worst.campaign.name,
            proposed_action: `pause "${worst.campaign.name}" to control burn rate`,
          });
        }
      }
      return out;
    }

    case 'winner_consecutive_cycles': {
      // params: { min_cycles: number }
      // Fires when a campaign has been a winner for N consecutive rebalance cycles.
      // Always notify-only — human decides whether to scale or duplicate.
      const minCycles = num(rule.params.min_cycles, 2);
      const obs = await loadActiveObservations('rebalance:winner_cycles:');
      for (const o of obs) {
        try {
          const parsed = JSON.parse(o.observation) as { cycles: number; campaign_name: string };
          if (parsed.cycles >= minCycles) {
            const campaignId = o.topic.replace('rebalance:winner_cycles:', '');
            out.push({
              rule,
              reason: `${parsed.campaign_name}: winner for ${parsed.cycles} consecutive rebalance cycles`,
              target_campaign_id: campaignId,
              target_campaign_name: parsed.campaign_name,
              proposed_action: `raise budget 50%+ or duplicate winning ad set for "${parsed.campaign_name}"`,
            });
          }
        } catch {}
      }
      return out;
    }

    default:
      return [];
  }
}

/**
 * Seeds a starter rule set on first run. No-ops if any active rules already exist.
 * Returns the number of rules created.
 */
export async function seedDefaultRules(): Promise<number> {
  const existing = await loadActiveRules();
  if (existing.length > 0) return 0;

  const defaults: Array<Parameters<typeof createRule>[0]> = [
    {
      name: 'Zero-lead kill switch',
      description: 'Alert when a campaign spends $150+ today with 0 leads',
      rule_kind: 'pause_zero_leads',
      params: { min_spend_dollars: 150, window: 'today' },
      auto_execute: false,
    },
    {
      name: 'Spend spike alert',
      description: "Alert when today's spend is 2× the 7-day daily average",
      rule_kind: 'alert_anomaly',
      params: { kind: 'spend_spike', factor: 2 },
      auto_execute: false,
    },
    {
      name: 'Burn rate circuit breaker',
      description: 'Alert when projected daily spend exceeds $300 — targets worst performer',
      rule_kind: 'burn_rate_circuit_breaker',
      params: { daily_cap_dollars: 300 },
      auto_execute: false,
    },
    {
      name: 'High CPL alert',
      description: '7-day CPL over $120 with $100+ spend',
      rule_kind: 'pause_high_cpl',
      params: { cpl_threshold_dollars: 120, min_spend_dollars: 100, window: 'last_7d' },
      auto_execute: false,
    },
    {
      name: 'Winner scale-up alert',
      description: 'Notify when a campaign is a winner for 2+ consecutive rebalance cycles',
      rule_kind: 'winner_consecutive_cycles',
      params: { min_cycles: 2 },
      auto_execute: false,
    },
  ];

  let seeded = 0;
  for (const r of defaults) {
    const id = await createRule(r);
    if (id != null) seeded++;
  }
  console.log(`[RULES] seeded ${seeded} default rules`);
  return seeded;
}

/**
 * For triggers whose rule has auto_execute=true, perform the action.
 * Logs to agent_actions. Mutates the trigger object with executed/error.
 */
export async function executeAutoTriggers(triggers: RuleTrigger[]): Promise<void> {
  for (const t of triggers) {
    if (!t.rule.auto_execute) continue;
    if (!t.target_campaign_id) continue; // cap_daily_spend would need fanout — not auto-executing for safety in v1

    try {
      // pre-insert audit row
      const { data: audit } = await supabase
        .from('agent_actions')
        .insert({
          chat_id: null,
          user_handle: `rule:${t.rule.name}`,
          command: `rule_auto:${t.rule.rule_kind}`,
          target_campaign_id: t.target_campaign_id,
          target_campaign_name: t.target_campaign_name ?? null,
          before_state: { reason: t.reason },
          success: false,
        })
        .select()
        .single();

      const resp = await pauseCampaign(t.target_campaign_id);

      if (audit?.id) {
        await supabase
          .from('agent_actions')
          .update({ success: true, meta_response: resp as object })
          .eq('id', audit.id);
      }
      t.executed = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      t.execution_error = m;
    }
  }
}
