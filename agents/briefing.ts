import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from './supabase.js';
import {
  listCampaigns,
  getCampaignInsights,
  extractLeads,
  type Campaign,
  type CampaignInsight,
} from './meta.js';
import { evaluateAllRules, executeAutoTriggers, type RuleTrigger } from './rules.js';
import { loadActiveObservations, loadActiveGoals } from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7';
const ACCOUNT_TZ = process.env.ACCOUNT_TZ ?? 'America/Los_Angeles';
const ACCOUNT_ID = process.env.META_AD_ACCOUNT;

if (!TELEGRAM_TOKEN || !ANTHROPIC_KEY || !ACCOUNT_ID) {
  throw new Error('TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, META_AD_ACCOUNT must be set');
}

const AGENT_MD = fs.readFileSync(path.resolve(__dirname, 'AGENT.md'), 'utf-8');

// Recipient chat IDs come from env (comma-separated). For v1 we DM each whitelisted user.
// The bot's message handler caches the chat_id per user when they DM the bot — for now
// we look up distinct chat_ids from chat_messages as a side-effect-free way to find them.
async function loadRecipientChatIds(): Promise<string[]> {
  // Prefer explicit env var
  const env = (process.env.BRIEFING_CHAT_IDS ?? '').trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);

  // Fallback: any chat_id we've seen the bot talk to
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

interface CampaignRow {
  campaign: Campaign;
  today?: CampaignInsight;
  yesterday?: CampaignInsight;
  last7d?: CampaignInsight;
}

async function gatherSnapshot(): Promise<{
  rows: CampaignRow[];
  totals: {
    today_spend: number;
    today_leads: number;
    yesterday_spend: number;
    yesterday_leads: number;
    week_spend: number;
    week_leads: number;
    active_count: number;
    paused_count: number;
  };
}> {
  const [campaigns, today, yesterday, last7d] = await Promise.all([
    listCampaigns(),
    getCampaignInsights('today'),
    getCampaignInsights('yesterday'),
    getCampaignInsights('last_7d'),
  ]);
  const idx = <T extends { campaign_id: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.campaign_id, r] as const));
  const t = idx(today),
    y = idx(yesterday),
    w = idx(last7d);
  const rows: CampaignRow[] = campaigns.map((c) => ({
    campaign: c,
    today: t.get(c.id),
    yesterday: y.get(c.id),
    last7d: w.get(c.id),
  }));

  const totals = {
    today_spend: rows.reduce((s, r) => s + Number(r.today?.spend ?? 0), 0),
    today_leads: rows.reduce((s, r) => s + (r.today ? extractLeads(r.today) : 0), 0),
    yesterday_spend: rows.reduce((s, r) => s + Number(r.yesterday?.spend ?? 0), 0),
    yesterday_leads: rows.reduce((s, r) => s + (r.yesterday ? extractLeads(r.yesterday) : 0), 0),
    week_spend: rows.reduce((s, r) => s + Number(r.last7d?.spend ?? 0), 0),
    week_leads: rows.reduce((s, r) => s + (r.last7d ? extractLeads(r.last7d) : 0), 0),
    active_count: rows.filter((r) => (r.campaign.effective_status ?? r.campaign.status) === 'ACTIVE').length,
    paused_count: rows.filter((r) => (r.campaign.effective_status ?? r.campaign.status) !== 'ACTIVE').length,
  };

  return { rows, totals };
}

function summarizeRows(rows: CampaignRow[]): unknown[] {
  return rows.map((r) => {
    const t = r.today;
    const y = r.yesterday;
    const w = r.last7d;
    return {
      id: r.campaign.id,
      name: r.campaign.name,
      status: r.campaign.effective_status ?? r.campaign.status,
      daily_budget_dollars: r.campaign.daily_budget ? Number(r.campaign.daily_budget) / 100 : null,
      today: t
        ? {
            spend: Number(t.spend),
            leads: extractLeads(t),
            ctr: t.ctr ? Number(t.ctr) : null,
            cpm: t.cpm ? Number(t.cpm) : null,
          }
        : null,
      yesterday: y
        ? {
            spend: Number(y.spend),
            leads: extractLeads(y),
            ctr: y.ctr ? Number(y.ctr) : null,
          }
        : null,
      last_7d: w
        ? {
            spend: Number(w.spend),
            leads: extractLeads(w),
          }
        : null,
    };
  });
}

async function generateBriefingText(
  mode: 'morning' | 'recap',
  snapshot: Awaited<ReturnType<typeof gatherSnapshot>>,
  triggers: RuleTrigger[],
): Promise<string> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const observations = await loadActiveObservations();
  const goals = await loadActiveGoals();

  const prompt =
    mode === 'morning'
      ? `Write the morning briefing for the user. The user reads this on their phone before they look at Ads Manager. Cover, in this order:
1) One-line headline of yesterday's outcome (spend, leads, blended CPL, vs. their goal/historical).
2) Today's pacing so far (spend, leads, on-track or off).
3) Anything that needs their attention TODAY (rule-triggered alerts, anomalies, broken-tracking suspicions).
4) One specific recommended action for today, with the exact slash command they can run.

Tight, numbers-first, no fluff. Plain text. Max 15 lines.`
      : `Write the end-of-day recap for the user. They are about to wrap for the day. Cover:
1) Today's outcome vs. their goal (spend, leads, CPL, % of cap used).
2) The single best ad/campaign of the day, by leads or CPL.
3) The single worst, with a specific reason if you can identify it from the data.
4) Anything to do tomorrow morning.

Tight, plain text, max 15 lines.`;

  const triggerSummary =
    triggers.length === 0
      ? 'No active rules fired this run.'
      : `Rule triggers this run:\n${triggers
          .map(
            (t) =>
              `- [${t.rule.name}${t.rule.auto_execute ? ' AUTO' : ''}] ${t.reason}${
                t.executed ? ' — EXECUTED' : t.execution_error ? ` — FAILED: ${t.execution_error}` : ' — notify only'
              }`,
          )
          .join('\n')}`;

  const dataBlock = [
    `Mode: ${mode}`,
    `Server time UTC: ${new Date().toISOString()}`,
    `Account TZ: ${ACCOUNT_TZ}`,
    `Account: ${ACCOUNT_ID}`,
    '',
    `Account totals:`,
    `  Today: spend $${snapshot.totals.today_spend.toFixed(2)}, leads ${snapshot.totals.today_leads}`,
    `  Yesterday: spend $${snapshot.totals.yesterday_spend.toFixed(2)}, leads ${snapshot.totals.yesterday_leads}`,
    `  Last 7d: spend $${snapshot.totals.week_spend.toFixed(2)}, leads ${snapshot.totals.week_leads}`,
    `  ACTIVE campaigns: ${snapshot.totals.active_count}, PAUSED: ${snapshot.totals.paused_count}`,
    '',
    goals.length > 0 ? `Active goals: ${goals.map((g) => `${g.goal_key}=${g.goal_value}`).join(', ')}` : 'No goals set.',
    '',
    observations.length > 0
      ? `Persistent observations:\n${observations
          .slice(0, 20)
          .map((o) => `- [${o.topic}] ${o.observation}`)
          .join('\n')}`
      : 'No observations yet.',
    '',
    triggerSummary,
    '',
    `Per-campaign data:\n${JSON.stringify(summarizeRows(snapshot.rows), null, 2)}`,
  ].join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: [{ type: 'text', text: AGENT_MD, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: dataBlock },
      { role: 'user', content: prompt },
    ],
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function deliver(text: string, mode: 'morning' | 'recap', triggerIds: number[]): Promise<void> {
  const recipients = await loadRecipientChatIds();
  if (recipients.length === 0) {
    console.warn('No recipient chat IDs found. Set BRIEFING_CHAT_IDS or DM the bot once first.');
    console.log('--- briefing content (would have sent) ---');
    console.log(text);
    return;
  }

  const bot = new TelegramBot(TELEGRAM_TOKEN!, { polling: false });
  const header = mode === 'morning' ? 'Morning briefing' : 'End-of-day recap';
  const body = `${header}\n\n${text}`;

  for (const chatId of recipients) {
    try {
      // Send in chunks if needed
      for (let i = 0; i < body.length; i += 4000) {
        await bot.sendMessage(chatId, body.slice(i, i + 4000));
      }
      await supabase.from('agent_briefings').insert({
        briefing_kind: mode,
        chat_id: chatId,
        content: text,
        triggered_rule_ids: triggerIds.length > 0 ? triggerIds : null,
      });
    } catch (err) {
      console.warn(`Failed to send briefing to chat ${chatId}:`, err);
    }
  }
}

async function snapshotIntoSupabase(rows: CampaignRow[]): Promise<void> {
  // Reuse the same shape as sync.ts so /changes can diff against this snapshot too.
  const inserts = rows.map((r) => {
    const c = r.campaign;
    const t = r.today;
    const y = r.yesterday;
    return {
      account_id: ACCOUNT_ID,
      campaign_id: c.id,
      campaign_name: c.name,
      status: c.effective_status ?? c.status,
      daily_budget_cents: c.daily_budget ? Number(c.daily_budget) : null,
      lifetime_budget_cents: c.lifetime_budget ? Number(c.lifetime_budget) : null,
      objective: c.objective ?? null,
      spend_today_cents: t?.spend ? Math.round(Number(t.spend) * 100) : 0,
      leads_today: t ? extractLeads(t) : 0,
      impressions_today: t?.impressions ? Number(t.impressions) : 0,
      clicks_today: t?.clicks ? Number(t.clicks) : 0,
      ctr_today: t?.ctr ? Number(t.ctr) : null,
      cpc_today: t?.cpc ? Number(t.cpc) : null,
      cpm_today: t?.cpm ? Number(t.cpm) : null,
      spend_yesterday_cents: y?.spend ? Math.round(Number(y.spend) * 100) : 0,
      leads_yesterday: y ? extractLeads(y) : 0,
      raw: { campaign: c, today: t ?? null, yesterday: y ?? null },
    };
  });
  if (inserts.length === 0) return;
  const { error } = await supabase.from('campaign_snapshots').insert(inserts);
  if (error) console.warn('snapshot insert failed:', error.message);
}

async function run(mode: 'morning' | 'recap'): Promise<void> {
  console.log(`Briefing run: mode=${mode} at ${new Date().toISOString()}`);

  const snapshot = await gatherSnapshot();
  await snapshotIntoSupabase(snapshot.rows);

  const triggers = await evaluateAllRules();
  await executeAutoTriggers(triggers);

  const text = await generateBriefingText(mode, snapshot, triggers);
  const triggerIds = triggers.map((t) => t.rule.id);
  await deliver(text, mode, triggerIds);

  console.log(`Briefing run complete. ${triggers.length} rule trigger(s).`);
}

const mode = (process.argv[2] ?? 'morning') as 'morning' | 'recap';
if (mode !== 'morning' && mode !== 'recap') {
  console.error(`Unknown mode: ${mode}. Use 'morning' or 'recap'.`);
  process.exit(1);
}

run(mode).catch((err) => {
  console.error('Briefing failed:', err);
  process.exit(1);
});
