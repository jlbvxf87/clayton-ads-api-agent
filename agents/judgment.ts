import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from './supabase.js';
import {
  getCampaign,
  getCampaignInsights,
  listAdSets,
  getAdSetInsights,
  type CampaignInsight,
} from './meta.js';
import { loadActiveObservations, loadActiveGoals } from './memory.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7';
const ACCOUNT_ID = process.env.META_AD_ACCOUNT;

if (!ANTHROPIC_KEY) {
  throw new Error('ANTHROPIC_API_KEY must be set for judgment module');
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ---------- Types ----------

export type JudgmentAction = 'pause' | 'reduce_budget' | 'wait' | 'escalate' | 'noop';
export type Confidence = 'low' | 'medium' | 'high';

export interface RecommendedAction {
  action: JudgmentAction;
  target_id?: string;
  target_name?: string;
  budget_change_pct?: number;
  wait_hours?: number;
  permission_kind?: 'pause' | 'budget' | null;
  reversibility?: 'easy' | 'medium' | 'hard';
}

export interface Judgment {
  id?: number;
  inbox_id: number | null;
  signal_kind: string | null;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  primary_hypothesis: string;
  alternative_hypotheses: string[];
  evidence: string[];
  caveats: string[];
  recommended_action: RecommendedAction;
  confidence: Confidence;
  rationale: string;
}

interface InboxSignalRow {
  id: number;
  signal_kind: string;
  severity: string;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  current_value: number | null;
  baseline_value: number | null;
  delta_pct: number | null;
  message: string;
  data: Record<string, unknown> | null;
  created_at: string;
  last_seen_at: string;
}

// ---------- Context gathering ----------

interface JudgmentContext {
  signal: InboxSignalRow;
  campaign: { id: string; name: string; status: string; daily_budget_dollars: number | null } | null;
  today: CampaignInsight | null;
  yesterday: CampaignInsight | null;
  last_7d: CampaignInsight | null;
  recent_actions: Array<{ command: string; created_at: string; success: boolean; meta: unknown }>;
  recent_snapshots: Array<{ snapshot_at: string; spend_today_cents: number; leads_today: number; ctr_today: number | null }>;
  related_observations: Array<{ topic: string; observation: string; confidence: string }>;
  goals: Array<{ goal_key: string; goal_value: string }>;
  related_open_signals: Array<{ id: number; signal_kind: string; severity: string; target_name: string | null; message: string }>;
  ad_sets_summary: Array<{ id: string; name: string; status: string; spend_today: number; leads_today: number; ctr_today: number | null }>;
}

async function loadInboxSignal(id: number): Promise<InboxSignalRow | null> {
  const { data, error } = await supabase.from('agent_inbox').select('*').eq('id', id).maybeSingle();
  if (error) {
    console.error('[JUDGMENT] loadInboxSignal failed:', error.message);
    return null;
  }
  return data as InboxSignalRow | null;
}

async function gatherContext(signal: InboxSignalRow): Promise<JudgmentContext> {
  const targetId = signal.target_id;
  const ctx: JudgmentContext = {
    signal,
    campaign: null,
    today: null,
    yesterday: null,
    last_7d: null,
    recent_actions: [],
    recent_snapshots: [],
    related_observations: [],
    goals: [],
    related_open_signals: [],
    ad_sets_summary: [],
  };

  if (signal.target_type === 'campaign' && targetId) {
    try {
      const c = await getCampaign(targetId);
      ctx.campaign = {
        id: c.id,
        name: c.name,
        status: c.effective_status ?? c.status ?? 'UNKNOWN',
        daily_budget_dollars: c.daily_budget != null ? Number(c.daily_budget) / 100 : null,
      };
    } catch (err) {
      console.warn('[JUDGMENT] getCampaign failed:', err);
    }
    const [today, yest, wk] = await Promise.all([
      getCampaignInsights('today').then((rows) => rows.find((r) => r.campaign_id === targetId) ?? null).catch(() => null),
      getCampaignInsights('yesterday').then((rows) => rows.find((r) => r.campaign_id === targetId) ?? null).catch(() => null),
      getCampaignInsights('last_7d').then((rows) => rows.find((r) => r.campaign_id === targetId) ?? null).catch(() => null),
    ]);
    ctx.today = today;
    ctx.yesterday = yest;
    ctx.last_7d = wk;

    // Ad-set level summary so the judgment can spot which ad set is dragging.
    try {
      const adSets = await listAdSets(targetId);
      const adSetInsights = await getAdSetInsights(targetId, 'today').catch(() => []);
      const idx = new Map(adSetInsights.map((i) => [i.adset_id, i] as const));
      ctx.ad_sets_summary = adSets.slice(0, 8).map((a) => {
        const ins = idx.get(a.id);
        const leadAction = ins?.actions?.find((act) => act.action_type === 'lead');
        return {
          id: a.id,
          name: a.name,
          status: a.effective_status ?? a.status ?? 'UNKNOWN',
          spend_today: ins?.spend ? Number(ins.spend) : 0,
          leads_today: leadAction ? Number(leadAction.value) : 0,
          ctr_today: ins?.ctr ? Number(ins.ctr) : null,
        };
      });
    } catch (err) {
      console.warn('[JUDGMENT] ad set fetch failed:', err);
    }

    const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const { data: actions } = await supabase
      .from('agent_actions')
      .select('command, created_at, success, meta_response, before_state, after_state')
      .eq('target_campaign_id', targetId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(15);
    ctx.recent_actions =
      actions?.map((a) => ({
        command: a.command as string,
        created_at: a.created_at as string,
        success: Boolean(a.success),
        meta: { before: a.before_state, after: a.after_state },
      })) ?? [];

    const { data: snaps } = await supabase
      .from('campaign_snapshots')
      .select('snapshot_at, spend_today_cents, leads_today, ctr_today')
      .eq('campaign_id', targetId)
      .order('snapshot_at', { ascending: false })
      .limit(48);
    ctx.recent_snapshots =
      snaps?.map((s) => ({
        snapshot_at: s.snapshot_at as string,
        spend_today_cents: Number(s.spend_today_cents ?? 0),
        leads_today: Number(s.leads_today ?? 0),
        ctr_today: s.ctr_today != null ? Number(s.ctr_today) : null,
      })) ?? [];
  }

  // Related observations: prefix-match by campaign name + signal kind.
  const obsTopics = [
    `campaign:${ctx.campaign?.name ?? signal.target_name ?? ''}`,
    `signal:${signal.signal_kind}`,
    `kind:cpl`,
    `kind:funnel`,
  ];
  for (const t of obsTopics) {
    if (!t) continue;
    const obs = await loadActiveObservations(t).catch(() => []);
    for (const o of obs.slice(0, 5)) {
      ctx.related_observations.push({ topic: o.topic, observation: o.observation, confidence: o.confidence ?? 'medium' });
    }
  }

  ctx.goals = await loadActiveGoals().catch(() => []);

  const { data: openOther } = await supabase
    .from('agent_inbox')
    .select('id, signal_kind, severity, target_name, message')
    .is('resolved_at', null)
    .neq('id', signal.id)
    .order('last_seen_at', { ascending: false })
    .limit(10);
  ctx.related_open_signals = (openOther ?? []) as JudgmentContext['related_open_signals'];

  return ctx;
}

// ---------- The reasoning call ----------

const JUDGMENT_SYSTEM = `You are Clayton, a senior media buyer triaging a single anomaly signal.

You are NOT executing actions in this turn — you are producing a structured judgment that will either auto-execute (if you assign HIGH confidence and a standing order covers it) or surface to the human with your full reasoning.

The user (Pack and Josh) trusts you to think like a tenured media buyer, not a rule engine. They want hypotheses + evidence cited from the data, ranked by likelihood. They want you to acknowledge uncertainty.

Rules:
- Anchor every hypothesis to specific numbers in the context block. No generic "could be audience fatigue" — say "frequency hit 4.2 (up from 2.8 last week), audience saturation likely."
- If the evidence is thin (e.g., $20 spend, 3 leads), say so and recommend WAIT, not action. Healthcare optimization with low volume is noise more than signal.
- Reversibility matters: pausing is reversible, budget changes are reversible, but burning the day on a misdiagnosis is not. Lean toward 'wait' when confidence is low and spend is bounded.
- 'pause' should be the recommendation when: (a) confidence is high, (b) the issue is actively burning money, and (c) reversal cost is small (you can resume immediately tomorrow).
- 'reduce_budget' is the soft-pause: if CPL is up 50-80% and spend is bounded, recommend a 25-50% cut rather than a full pause.
- 'escalate' means "I see something I don't fully understand — surface it to the user with the data and let them decide."
- 'noop' / 'wait' is also a valid answer. Don't manufacture action.

You MUST emit your judgment by calling the submit_judgment tool exactly once. Do not respond with prose; the tool call IS your response.`;

const SUBMIT_JUDGMENT_TOOL: Anthropic.Tool = {
  name: 'submit_judgment',
  description:
    'Emit your structured judgment for this signal. Required: every field. Numeric/categorical answers only — no free-form essays except in rationale and caveats.',
  input_schema: {
    type: 'object',
    properties: {
      primary_hypothesis: {
        type: 'string',
        description: 'The single most likely cause for the signal, anchored to specific data points.',
      },
      alternative_hypotheses: {
        type: 'array',
        items: { type: 'string' },
        description: '2-4 plausible alternative explanations, ranked by likelihood.',
      },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific data points from the context block that support the primary hypothesis.',
      },
      caveats: {
        type: 'array',
        items: { type: 'string' },
        description: 'What could change your mind — what additional data would flip the call.',
      },
      recommended_action: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['pause', 'reduce_budget', 'wait', 'escalate', 'noop'],
          },
          budget_change_pct: { type: 'number', description: 'Negative for cuts. Required when action=reduce_budget.' },
          wait_hours: { type: 'number', description: 'How long to wait before re-evaluating. Required when action=wait.' },
          permission_kind: {
            type: 'string',
            enum: ['pause', 'budget'],
            description: 'Which permission kind would auto-execute this. Null for wait/escalate/noop.',
          },
          reversibility: { type: 'string', enum: ['easy', 'medium', 'hard'] },
        },
        required: ['action'],
      },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      rationale: {
        type: 'string',
        description: 'A 2-4 sentence summary the user will see. Lead with the recommendation, then evidence.',
      },
    },
    required: [
      'primary_hypothesis',
      'alternative_hypotheses',
      'evidence',
      'caveats',
      'recommended_action',
      'confidence',
      'rationale',
    ],
  },
};

function formatContextForLLM(ctx: JudgmentContext): string {
  const sig = ctx.signal;
  const lines: string[] = [];
  lines.push(`# Signal under review`);
  lines.push(`kind: ${sig.signal_kind} | severity: ${sig.severity}`);
  lines.push(`target: ${sig.target_type}/${sig.target_id} (${sig.target_name})`);
  lines.push(`message: ${sig.message}`);
  lines.push(`current=${sig.current_value} baseline=${sig.baseline_value} delta_pct=${sig.delta_pct}`);
  lines.push(`first_seen=${sig.created_at} last_seen=${sig.last_seen_at}`);
  if (sig.data) lines.push(`raw_data: ${JSON.stringify(sig.data)}`);

  if (ctx.campaign) {
    lines.push('');
    lines.push(`# Campaign`);
    lines.push(JSON.stringify(ctx.campaign));
  }
  if (ctx.today || ctx.yesterday || ctx.last_7d) {
    lines.push('');
    lines.push(`# Insights`);
    lines.push(`today: ${ctx.today ? JSON.stringify(ctx.today) : 'null'}`);
    lines.push(`yesterday: ${ctx.yesterday ? JSON.stringify(ctx.yesterday) : 'null'}`);
    lines.push(`last_7d: ${ctx.last_7d ? JSON.stringify(ctx.last_7d) : 'null'}`);
  }
  if (ctx.ad_sets_summary.length > 0) {
    lines.push('');
    lines.push(`# Ad sets (today snapshot)`);
    for (const a of ctx.ad_sets_summary) {
      lines.push(
        `  ${a.name} (${a.status}): spend=$${a.spend_today.toFixed(0)} leads=${a.leads_today} ctr=${a.ctr_today != null ? a.ctr_today.toFixed(2) + '%' : '?'}`,
      );
    }
  }
  if (ctx.recent_snapshots.length > 0) {
    lines.push('');
    lines.push(`# Last ${ctx.recent_snapshots.length} hourly snapshots (most recent first)`);
    for (const s of ctx.recent_snapshots.slice(0, 12)) {
      lines.push(
        `  ${s.snapshot_at}  spend_today=$${(s.spend_today_cents / 100).toFixed(0)}  leads=${s.leads_today}  ctr=${s.ctr_today != null ? s.ctr_today.toFixed(2) + '%' : '?'}`,
      );
    }
  }
  if (ctx.recent_actions.length > 0) {
    lines.push('');
    lines.push(`# Recent agent_actions on this target (last 7d)`);
    for (const a of ctx.recent_actions.slice(0, 10)) {
      lines.push(`  ${a.created_at}  ${a.command}  success=${a.success}`);
    }
  }
  if (ctx.related_observations.length > 0) {
    lines.push('');
    lines.push(`# Related observations from memory`);
    for (const o of ctx.related_observations.slice(0, 8)) {
      lines.push(`  [${o.topic}] (${o.confidence}) ${o.observation}`);
    }
  }
  if (ctx.goals.length > 0) {
    lines.push('');
    lines.push(`# Active goals`);
    for (const g of ctx.goals) lines.push(`  ${g.goal_key}: ${g.goal_value}`);
  }
  if (ctx.related_open_signals.length > 0) {
    lines.push('');
    lines.push(`# Other open inbox signals (cross-signal context)`);
    for (const s of ctx.related_open_signals.slice(0, 6)) {
      lines.push(`  #${s.id} [${s.severity}] ${s.signal_kind}: ${s.message}`);
    }
  }
  return lines.join('\n');
}

interface JudgmentToolInput {
  primary_hypothesis: string;
  alternative_hypotheses: string[];
  evidence: string[];
  caveats: string[];
  recommended_action: RecommendedAction;
  confidence: Confidence;
  rationale: string;
}

export interface RunJudgmentResult {
  judgment: Judgment;
  saved_id: number | null;
  raw_response: Anthropic.Message;
  input_tokens: number;
  output_tokens: number;
}

export async function runJudgmentOnSignal(
  inboxId: number,
): Promise<RunJudgmentResult | { error: string }> {
  const signal = await loadInboxSignal(inboxId);
  if (!signal) return { error: `inbox #${inboxId} not found` };

  const ctx = await gatherContext(signal);
  const prompt = formatContextForLLM(ctx);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: JUDGMENT_SYSTEM,
    thinking: { type: 'adaptive' },
    tools: [SUBMIT_JUDGMENT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_judgment' },
    messages: [{ role: 'user', content: prompt }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_judgment',
  );
  if (!toolUse) {
    return { error: 'LLM did not call submit_judgment tool' };
  }
  const j = toolUse.input as unknown as JudgmentToolInput;

  const judgment: Judgment = {
    inbox_id: signal.id,
    signal_kind: signal.signal_kind,
    target_type: signal.target_type,
    target_id: signal.target_id,
    target_name: signal.target_name,
    primary_hypothesis: j.primary_hypothesis,
    alternative_hypotheses: j.alternative_hypotheses ?? [],
    evidence: j.evidence ?? [],
    caveats: j.caveats ?? [],
    recommended_action: j.recommended_action,
    confidence: j.confidence,
    rationale: j.rationale,
  };

  const { data: saved, error: saveErr } = await supabase
    .from('agent_judgments')
    .insert({
      inbox_id: judgment.inbox_id,
      signal_kind: judgment.signal_kind,
      target_type: judgment.target_type,
      target_id: judgment.target_id,
      target_name: judgment.target_name,
      primary_hypothesis: judgment.primary_hypothesis,
      alternative_hypotheses: judgment.alternative_hypotheses,
      evidence: judgment.evidence,
      caveats: judgment.caveats,
      recommended_action: judgment.recommended_action,
      confidence: judgment.confidence,
      rationale: judgment.rationale,
      model: MODEL,
      input_tokens: response.usage?.input_tokens ?? null,
      output_tokens: response.usage?.output_tokens ?? null,
      raw_llm_response: response,
    })
    .select('id')
    .single();
  if (saveErr) console.error('[JUDGMENT] save failed:', saveErr.message);

  return {
    judgment: { ...judgment, id: (saved?.id as number | undefined) ?? undefined },
    saved_id: (saved?.id as number | undefined) ?? null,
    raw_response: response,
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
  };
}

// ---------- Read helpers ----------

export async function listRecentJudgments(limit = 25): Promise<Judgment[]> {
  const { data, error } = await supabase
    .from('agent_judgments')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[JUDGMENT] listRecentJudgments failed:', error.message);
    return [];
  }
  return (data ?? []) as Judgment[];
}

// ---------- Format judgment for Telegram ----------

export function formatJudgmentForTelegram(j: Judgment, signalSeverity: string): string {
  const sevTag = signalSeverity.toUpperCase();
  const lines: string[] = [];
  lines.push(`[${sevTag}] ${j.target_name ?? j.target_id ?? '?'} — ${j.signal_kind}`);
  lines.push('');
  lines.push(`Recommendation: ${j.recommended_action.action.toUpperCase()}${j.recommended_action.budget_change_pct != null ? ` ${j.recommended_action.budget_change_pct}%` : ''}${j.recommended_action.wait_hours ? ` for ${j.recommended_action.wait_hours}h` : ''} (${j.confidence} confidence)`);
  lines.push('');
  lines.push(`Why I think so: ${j.primary_hypothesis}`);
  if (j.evidence.length > 0) {
    lines.push('');
    lines.push('Evidence:');
    for (const e of j.evidence.slice(0, 5)) lines.push(`  • ${e}`);
  }
  if (j.alternative_hypotheses.length > 0) {
    lines.push('');
    lines.push('Other possibilities:');
    for (const h of j.alternative_hypotheses.slice(0, 3)) lines.push(`  • ${h}`);
  }
  if (j.caveats.length > 0) {
    lines.push('');
    lines.push('What would change my mind:');
    for (const c of j.caveats.slice(0, 3)) lines.push(`  • ${c}`);
  }
  lines.push('');
  lines.push(j.rationale);
  if (j.recommended_action.action === 'pause' && j.recommended_action.permission_kind === 'pause') {
    lines.push('');
    lines.push(`To approve once: reply "yes" (after I stage the pending pause), or grant standing:`);
    lines.push(`  /grant pause campaign="${j.target_name}" expires=24h`);
  }
  return lines.join('\n');
}

// CLI entry point: `tsx agents/judgment.ts <inbox_id>` runs one judgment.
import { fileURLToPath } from 'node:url';
const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  const id = Number(process.argv[2]);
  if (!Number.isFinite(id) || id <= 0) {
    console.error('Usage: tsx agents/judgment.ts <inbox_id>');
    process.exit(1);
  }
  runJudgmentOnSignal(id)
    .then((r) => {
      if ('error' in r) {
        console.error(r.error);
        process.exit(1);
      }
      console.log(JSON.stringify(r.judgment, null, 2));
      console.log('---\nFormatted for Telegram:\n');
      console.log(formatJudgmentForTelegram(r.judgment, 'alert'));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
void ACCOUNT_ID; // reserved for future per-account scoping
