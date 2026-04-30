import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import { runBriefing } from './briefing.js';
import { supabase } from './supabase.js';
import {
  listCampaigns,
  getCampaign,
  getCampaignInsights,
  extractLeads,
  pauseCampaign,
  setDailyBudget,
  listAdSets,
  listAds,
  getAd,
  getAdSetInsights,
  getAdInsights,
  listPixels,
  getPixelHealth,
  cloneAdWithNewCopy,
  createCampaign,
  createAdSet,
  createAd,
  getAdSetTargeting,
  updateAdSetTargeting,
  listCustomAudiences,
  createLookalikeAudience,
  AD_ACCOUNTS,
  type Campaign,
  type AdSet,
  type Ad,
  type AdInsight,
} from './meta.js';
import {
  loadRecentMessages,
  recordMessage,
  loadActiveObservations,
  noteObservation,
  loadActiveGoals,
  setGoal,
} from './memory.js';
import {
  loadActiveRules,
  createRule,
  setRuleActive,
} from './rules.js';
import {
  cioListSegments,
  cioCountSegment,
  cioFindCustomerByEmail,
  cioGetCustomerActivity,
  cioCountEvents,
  cioShowRate,
  cioSendEvent,
  CIO_CONFIGURED,
} from './customerio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7';
const ACCOUNT_TZ = process.env.ACCOUNT_TZ ?? 'America/Los_Angeles';

if (!TELEGRAM_TOKEN || !ANTHROPIC_KEY) {
  throw new Error('TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY must be set');
}

// Whitelist of Telegram users. A message is allowed if its sender's user_id
// matches TELEGRAM_ALLOWED_USER_IDS, OR its username matches TELEGRAM_ALLOWED_USERNAMES.
// Prefer user IDs — they never change. Usernames are a fallback for users whose ID
// you don't yet have on file.
const ALLOWED_USER_IDS = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '8219840935')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const ALLOWED_USERNAMES = new Set(
  (process.env.TELEGRAM_ALLOWED_USERNAMES ?? 'joshuatatum,pack87')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// Load AGENT.md once at startup. It's the system prompt for every Claude call.
const AGENT_MD_PATH = path.resolve(__dirname, 'AGENT.md');
const AGENT_MD = fs.readFileSync(AGENT_MD_PATH, 'utf-8');

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ---------- Pending action state ----------

type PendingAction =
  | { kind: 'pause'; campaignId: string; campaignName: string }
  | {
      kind: 'budget';
      campaignId: string;
      campaignName: string;
      newDailyBudgetCents: number;
      oldDailyBudgetCents: number | null;
    }
  | {
      kind: 'boost';
      campaignId: string;
      campaignName: string;
      newDailyBudgetCents: number;
      oldDailyBudgetCents: number | null;
      percent: number;
    };

const PENDING_TTL_MS = 5 * 60 * 1000;
// Key: `${chatId}:${userId}` — scopes confirmations to the user who started the
// action, so in group chats one person can't confirm another person's pending write.
const pending = new Map<string, { action: PendingAction; expiresAt: number }>();

function pendingKey(chatId: number, userId: number | string): string {
  return `${chatId}:${userId}`;
}

function setPending(chatId: number, userId: number | string, action: PendingAction): void {
  pending.set(pendingKey(chatId, userId), { action, expiresAt: Date.now() + PENDING_TTL_MS });
}

function takePending(chatId: number, userId: number | string): PendingAction | null {
  const k = pendingKey(chatId, userId);
  const entry = pending.get(k);
  if (!entry) return null;
  pending.delete(k);
  if (Date.now() > entry.expiresAt) return null;
  return entry.action;
}

function peekPending(chatId: number, userId: number | string): PendingAction | null {
  const k = pendingKey(chatId, userId);
  const entry = pending.get(k);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pending.delete(k);
    return null;
  }
  return entry.action;
}

// ---------- Guardrail helpers ----------

function isTiredFingersWindow(now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: ACCOUNT_TZ,
      hour: 'numeric',
      hour12: false,
    }).format(now),
  );
  // Intl can return "24" for midnight on some platforms; normalize to 0.
  const h = hour === 24 ? 0 : hour;
  return h >= 2 && h < 6;
}

// ---------- Formatting ----------

function fmtMoney(cents: number | null | undefined): string {
  if (cents == null) return '-';
  const dollars = cents / 100;
  if (dollars >= 10) return `$${Math.round(dollars)}`;
  return `$${dollars.toFixed(2)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  return `${n.toFixed(1)}%`;
}

// Telegram caps messages at 4096 chars. Be safe at 4000.
async function sendChunked(chatId: number, text: string): Promise<void> {
  if (!text) {
    await bot.sendMessage(chatId, '[empty response]');
    return;
  }
  for (let i = 0; i < text.length; i += 4000) {
    await bot.sendMessage(chatId, text.slice(i, i + 4000));
  }
}

// ---------- Slash commands: read-only ----------

async function handleReport(chatId: number): Promise<void> {
  await bot.sendChatAction(chatId, 'typing');
  const [campaigns, ydayInsights] = await Promise.all([
    listCampaigns(),
    getCampaignInsights('yesterday'),
  ]);
  const byId = new Map(campaigns.map((c) => [c.id, c] as const));

  if (ydayInsights.length === 0) {
    await bot.sendMessage(chatId, 'No spend data for yesterday.');
    return;
  }

  const lines: string[] = ['Yesterday', ''];
  let totalSpendCents = 0;
  let totalLeads = 0;

  const sorted = [...ydayInsights].sort((a, b) => Number(b.spend) - Number(a.spend));
  for (const i of sorted) {
    void byId.get(i.campaign_id);
    const spendCents = Math.round(Number(i.spend) * 100);
    const leads = extractLeads(i);
    const cplCents = leads > 0 ? Math.round(spendCents / leads) : null;
    totalSpendCents += spendCents;
    totalLeads += leads;
    lines.push(
      i.campaign_name,
      `  spend ${fmtMoney(spendCents)}  leads ${leads}  cpl ${fmtMoney(cplCents)}  ctr ${fmtPct(i.ctr ? Number(i.ctr) : null)}  cpm ${i.cpm ? '$' + Number(i.cpm).toFixed(2) : '-'}`,
      '',
    );
  }
  const totalCplCents = totalLeads > 0 ? Math.round(totalSpendCents / totalLeads) : null;
  lines.push(
    `TOTAL  spend ${fmtMoney(totalSpendCents)}  leads ${totalLeads}  cpl ${fmtMoney(totalCplCents)}`,
  );

  await sendChunked(chatId, lines.join('\n'));
}

async function handleStatus(chatId: number): Promise<void> {
  await bot.sendChatAction(chatId, 'typing');
  const [campaigns, todayInsights] = await Promise.all([
    listCampaigns(),
    getCampaignInsights('today'),
  ]);
  const todayById = new Map(todayInsights.map((i) => [i.campaign_id, i] as const));

  if (campaigns.length === 0) {
    await bot.sendMessage(chatId, 'No campaigns found.');
    return;
  }

  const rows = campaigns.map((c) => {
    const t = todayById.get(c.id);
    return {
      name: c.name,
      status: c.effective_status ?? c.status,
      spendCents: t?.spend ? Math.round(Number(t.spend) * 100) : 0,
      leads: t ? extractLeads(t) : 0,
      dailyBudgetCents: c.daily_budget ? Number(c.daily_budget) : null,
    };
  });
  rows.sort((a, b) => b.spendCents - a.spendCents);

  const lines: string[] = ['Today (live)', ''];
  for (const r of rows) {
    lines.push(
      `${r.name}  [${r.status}]`,
      `  spend ${fmtMoney(r.spendCents)}  leads ${r.leads}  daily ${fmtMoney(r.dailyBudgetCents)}`,
      '',
    );
  }
  await sendChunked(chatId, lines.join('\n'));
}

async function handleChanges(chatId: number): Promise<void> {
  await bot.sendChatAction(chatId, 'typing');
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: snapshots, error } = await supabase
    .from('campaign_snapshots')
    .select('campaign_id, campaign_name, status, daily_budget_cents, snapshot_at')
    .lte('snapshot_at', cutoff)
    .order('snapshot_at', { ascending: false })
    .limit(500);

  if (error) {
    await bot.sendMessage(chatId, `Couldn't read snapshots: ${error.message}`);
    return;
  }
  if (!snapshots || snapshots.length === 0) {
    await bot.sendMessage(chatId, 'No snapshot from ~24h ago. Sync may not have run yet.');
    return;
  }

  // Most-recent snapshot per campaign from "around 24h ago".
  const oldByCampaign = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) {
    if (!oldByCampaign.has(s.campaign_id)) oldByCampaign.set(s.campaign_id, s);
  }

  const currentCampaigns = await listCampaigns();
  const currentById = new Map(currentCampaigns.map((c) => [c.id, c] as const));

  const lines: string[] = ['Changes in the last ~24h', ''];
  let any = false;

  for (const [id, old] of oldByCampaign) {
    const cur = currentById.get(id);
    if (!cur) {
      lines.push(`REMOVED  ${old.campaign_name}`);
      any = true;
      continue;
    }
    const curStatus = cur.effective_status ?? cur.status;
    if (old.status && curStatus && old.status !== curStatus) {
      lines.push(`STATUS  ${cur.name}: ${old.status} -> ${curStatus}`);
      any = true;
    }
    const oldBudget = old.daily_budget_cents ?? null;
    const curBudget = cur.daily_budget ? Number(cur.daily_budget) : null;
    if (oldBudget !== curBudget && (oldBudget != null || curBudget != null)) {
      lines.push(`BUDGET  ${cur.name}: ${fmtMoney(oldBudget)} -> ${fmtMoney(curBudget)}`);
      any = true;
    }
  }

  for (const [id, cur] of currentById) {
    if (!oldByCampaign.has(id)) {
      lines.push(
        `NEW  ${cur.name}  daily ${fmtMoney(cur.daily_budget ? Number(cur.daily_budget) : null)}`,
      );
      any = true;
    }
  }

  if (!any) lines.push('No status, budget, or roster changes detected.');
  await sendChunked(chatId, lines.join('\n'));
}

// ---------- Slash commands: drill-downs (read-only) ----------

function fuzzyFind<T extends { id: string; name: string }>(list: T[], query: string): T | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  let m = list.find((c) => c.name.toLowerCase() === q || c.id === query.trim());
  if (m) return m;
  m = list.find((c) => c.name.toLowerCase().startsWith(q));
  if (m) return m;
  m = list.find((c) => c.name.toLowerCase().includes(q));
  return m ?? null;
}

async function findCampaignByQuery(query: string): Promise<Campaign | null> {
  return fuzzyFind(await listCampaigns(), query);
}

async function findAdSetByQuery(query: string): Promise<AdSet | null> {
  return fuzzyFind(await listAdSets(), query);
}

async function findAdByQuery(query: string): Promise<Ad | null> {
  return fuzzyFind(await listAds(), query);
}

async function handleAdSetsCmd(chatId: number, args: string): Promise<void> {
  await bot.sendChatAction(chatId, 'typing');
  let parentId: string | undefined;
  let parentLabel = 'account-wide';

  if (args.trim()) {
    const campaign = await findCampaignByQuery(args);
    if (!campaign) {
      await bot.sendMessage(chatId, `No campaign matched "${args}".`);
      return;
    }
    parentId = campaign.id;
    parentLabel = campaign.name;
  }

  const [adSets, todayInsights] = await Promise.all([
    listAdSets(parentId),
    parentId ? getAdSetInsights(parentId, 'today') : Promise.resolve([] as AdInsight[]),
  ]);
  const insightById = new Map(todayInsights.map((i) => [i.adset_id ?? '', i] as const));

  if (adSets.length === 0) {
    await bot.sendMessage(chatId, `No ad sets found under ${parentLabel}.`);
    return;
  }

  const lines: string[] = [`Ad sets under ${parentLabel} (${adSets.length}):`, ''];
  for (const a of adSets.slice(0, 50)) {
    const ins = insightById.get(a.id);
    const spend = ins?.spend ? Math.round(Number(ins.spend) * 100) : 0;
    const leads = ins ? extractLeads(ins as never) : 0;
    const budget = a.daily_budget
      ? `${fmtMoney(Number(a.daily_budget))}/day`
      : a.lifetime_budget
        ? `${fmtMoney(Number(a.lifetime_budget))} lifetime`
        : 'CBO (campaign budget)';
    lines.push(
      `${a.name}  [${a.effective_status ?? a.status}]`,
      `  ${a.optimization_goal ?? '-'}  |  ${budget}  |  today ${fmtMoney(spend)}  ${leads}L`,
      '',
    );
  }
  if (adSets.length > 50) lines.push(`...and ${adSets.length - 50} more.`);
  await sendChunked(chatId, lines.join('\n'));
}

async function handleAdsCmd(chatId: number, args: string): Promise<void> {
  await bot.sendChatAction(chatId, 'typing');
  let parentId: string | undefined;
  let parentLabel = 'account-wide';

  if (args.trim()) {
    // try campaign first, then ad set
    const campaign = await findCampaignByQuery(args);
    if (campaign) {
      parentId = campaign.id;
      parentLabel = `campaign "${campaign.name}"`;
    } else {
      const adSet = await findAdSetByQuery(args);
      if (adSet) {
        parentId = adSet.id;
        parentLabel = `ad set "${adSet.name}"`;
      } else {
        await bot.sendMessage(chatId, `No campaign or ad set matched "${args}".`);
        return;
      }
    }
  }

  const [ads, todayInsights] = await Promise.all([
    listAds(parentId),
    parentId ? getAdInsights(parentId, 'today') : Promise.resolve([] as AdInsight[]),
  ]);
  const insightByAdId = new Map(todayInsights.map((i) => [i.ad_id ?? '', i] as const));

  if (ads.length === 0) {
    await bot.sendMessage(chatId, `No ads found under ${parentLabel}.`);
    return;
  }

  const lines: string[] = [`Ads under ${parentLabel} (${ads.length}):`, ''];
  for (const a of ads.slice(0, 60)) {
    const ins = insightByAdId.get(a.id);
    const spend = ins?.spend ? Math.round(Number(ins.spend) * 100) : 0;
    const leads = ins ? extractLeads(ins as never) : 0;
    const ctr = ins?.ctr ? `${Number(ins.ctr).toFixed(2)}%` : '-';
    const objType = a.creative?.object_type ?? '-';
    lines.push(
      `${a.name}  [${a.effective_status ?? a.status}]`,
      `  ${objType}  |  today ${fmtMoney(spend)}  ${leads}L  ctr ${ctr}`,
      '',
    );
  }
  if (ads.length > 60) lines.push(`...and ${ads.length - 60} more.`);
  await sendChunked(chatId, lines.join('\n'));
}

async function handleCreativeCmd(chatId: number, args: string): Promise<void> {
  if (!args.trim()) {
    await bot.sendMessage(chatId, 'Usage: /creative <ad name or id>');
    return;
  }
  await bot.sendChatAction(chatId, 'typing');
  const ad = await findAdByQuery(args);
  if (!ad) {
    await bot.sendMessage(chatId, `No ad matched "${args}".`);
    return;
  }
  const full = await getAd(ad.id);
  const c = full.creative;

  const lines: string[] = [
    `Ad: ${full.name}`,
    `Status: ${full.effective_status ?? full.status}`,
    `Type: ${c?.object_type ?? '-'}`,
    `CTA: ${c?.call_to_action_type ?? '-'}`,
  ];
  if (c?.title) lines.push(`Headline: ${c.title}`);
  if (c?.body) lines.push('', 'Body:', c.body);
  if (full.preview_shareable_link) lines.push('', `Preview: ${full.preview_shareable_link}`);

  // If we have a thumbnail or image, send the photo + caption
  const imageUrl = c?.image_url ?? c?.thumbnail_url;
  if (imageUrl) {
    try {
      await bot.sendPhoto(chatId, imageUrl, { caption: lines.slice(0, 4).join('\n') });
      // Send the body separately so it isn't truncated by Telegram's 1024-char caption limit
      const rest = lines.slice(4).join('\n');
      if (rest.trim()) await sendChunked(chatId, rest);
      return;
    } catch (err) {
      // Meta CDN URLs sometimes 403 from Telegram's fetcher — fall back to text
      lines.push('', `(thumbnail at ${imageUrl})`);
    }
  }
  await sendChunked(chatId, lines.join('\n'));
}

// ---------- Slash commands: writes (build pending) ----------

async function handlePauseCmd(chatId: number, userId: number | string, args: string): Promise<void> {
  if (!args.trim()) {
    await bot.sendMessage(chatId, 'Usage: /pause <campaign name or id>');
    return;
  }
  const campaign = await findCampaignByQuery(args);
  if (!campaign) {
    await bot.sendMessage(chatId, `No campaign matched "${args}".`);
    return;
  }
  setPending(chatId, userId, {
    kind: 'pause',
    campaignId: campaign.id,
    campaignName: campaign.name,
  });
  await bot.sendMessage(
    chatId,
    `Pause this campaign?\n${campaign.name}\nstatus ${campaign.effective_status ?? campaign.status}\ndaily ${fmtMoney(campaign.daily_budget ? Number(campaign.daily_budget) : null)}\n\nReply confirm / yes / kill it to proceed, or anything else to cancel.`,
  );
}

async function handleBudgetCmd(chatId: number, userId: number | string, args: string): Promise<void> {
  const m = args.trim().match(/^(.+?)\s+\$?([\d.]+)$/);
  if (!m) {
    await bot.sendMessage(chatId, 'Usage: /budget <campaign> <new daily budget in dollars>');
    return;
  }
  const namePart = m[1];
  const newDollars = Number(m[2]);
  if (!Number.isFinite(newDollars) || newDollars <= 0) {
    await bot.sendMessage(chatId, 'Amount must be a positive number (dollars).');
    return;
  }
  if (newDollars < 5) {
    await bot.sendMessage(chatId, 'Floor is $5/day.');
    return;
  }
  if (newDollars > 500) {
    await bot.sendMessage(chatId, 'Ceiling is $500/day per single action. Do it in two steps if intentional.');
    return;
  }
  const newCents = Math.round(newDollars * 100);

  const campaign = await findCampaignByQuery(namePart);
  if (!campaign) {
    await bot.sendMessage(chatId, `No campaign matched "${namePart}".`);
    return;
  }
  const oldCents = campaign.daily_budget ? Number(campaign.daily_budget) : null;
  if (oldCents != null && oldCents > 0) {
    const ratio = newCents / oldCents;
    if (ratio > 1.5 || ratio < 0.5) {
      await bot.sendMessage(
        chatId,
        `Refused: change is ${(ratio * 100 - 100).toFixed(0)}% — exceeds ±50% per-action cap. Do this in two steps.`,
      );
      return;
    }
  }

  const deltaWeeklyCents = oldCents != null ? (newCents - oldCents) * 7 : newCents * 7;

  setPending(chatId, userId, {
    kind: 'budget',
    campaignId: campaign.id,
    campaignName: campaign.name,
    newDailyBudgetCents: newCents,
    oldDailyBudgetCents: oldCents,
  });
  await bot.sendMessage(
    chatId,
    `Set daily budget?\n${campaign.name}\n${fmtMoney(oldCents)} -> ${fmtMoney(newCents)}\n7-day spend impact: ~${fmtMoney(Math.abs(deltaWeeklyCents))} ${deltaWeeklyCents >= 0 ? 'increase' : 'decrease'}\n\nReply confirm to proceed, anything else to cancel.`,
  );
}

async function handleBoostCmd(chatId: number, userId: number | string, args: string): Promise<void> {
  const m = args.trim().match(/^(.+?)\s+(-?[\d.]+)\s*%?$/);
  if (!m) {
    await bot.sendMessage(chatId, 'Usage: /boost <campaign> <percent, e.g. 25 or -10>');
    return;
  }
  const namePart = m[1];
  const pct = Number(m[2]);
  if (!Number.isFinite(pct)) {
    await bot.sendMessage(chatId, 'Percent must be a number.');
    return;
  }
  if (Math.abs(pct) > 50) {
    await bot.sendMessage(chatId, 'Refused: ±50% cap per single action.');
    return;
  }
  const campaign = await findCampaignByQuery(namePart);
  if (!campaign) {
    await bot.sendMessage(chatId, `No campaign matched "${namePart}".`);
    return;
  }
  const oldCents = campaign.daily_budget ? Number(campaign.daily_budget) : null;
  if (oldCents == null || oldCents <= 0) {
    await bot.sendMessage(
      chatId,
      `${campaign.name} has no daily budget (lifetime or unset). /boost only supports daily-budget campaigns.`,
    );
    return;
  }
  const newCents = Math.max(500, Math.round(oldCents * (1 + pct / 100)));
  if (newCents > 50_000) {
    await bot.sendMessage(
      chatId,
      `Ceiling is $500/day per single action. Resulting amount ${fmtMoney(newCents)} exceeds it.`,
    );
    return;
  }

  setPending(chatId, userId, {
    kind: 'boost',
    campaignId: campaign.id,
    campaignName: campaign.name,
    newDailyBudgetCents: newCents,
    oldDailyBudgetCents: oldCents,
    percent: pct,
  });
  await bot.sendMessage(
    chatId,
    `Boost daily budget by ${pct > 0 ? '+' : ''}${pct}%?\n${campaign.name}\n${fmtMoney(oldCents)} -> ${fmtMoney(newCents)}\n\nReply confirm to proceed, anything else to cancel.`,
  );
}

// ---------- Confirmation classification ----------

const CONFIRM_REGEX =
  /\b(confirm|yes|yep|yeah|do it|go|go ahead|kill|kill it|stop|stop it|pause it|approve|approved|ok do|let'?s do|send it|fire|execute|proceed|scale it|boost it)\b/i;
const CANCEL_REGEX = /\b(no|cancel|nope|nvm|nevermind|never mind|abort|skip|don'?t|hold|wait)\b/i;

function classifyReply(text: string): 'confirm' | 'cancel' | 'unclear' {
  const t = text.trim();
  if (CANCEL_REGEX.test(t)) return 'cancel';
  if (CONFIRM_REGEX.test(t)) return 'confirm';
  return 'unclear';
}

// ---------- Execute pending ----------

async function executePending(
  chatId: number,
  action: PendingAction,
  userHandle: string,
  originalMessage: string,
): Promise<void> {
  const overrideRequested = /\bOVERRIDE\b/.test(originalMessage);
  if (isTiredFingersWindow() && !overrideRequested) {
    await bot.sendMessage(
      chatId,
      'Refused: 02:00–06:00 PT is the no-write window (tired-fingers protection). Add the word OVERRIDE to your reply to bypass.',
    );
    return;
  }

  const before = await getCampaign(action.campaignId).catch(() => null);

  // Pre-insert audit row. If this fails, we abort per AGENT.md guardrail #7.
  const auditPayload = {
    chat_id: String(chatId),
    user_handle: userHandle,
    command: action.kind,
    target_campaign_id: action.campaignId,
    target_campaign_name: action.campaignName,
    before_state: before as object | null,
    success: false as boolean,
  };
  const { data: audit, error: auditErr } = await supabase
    .from('agent_actions')
    .insert(auditPayload)
    .select()
    .single();
  if (auditErr || !audit) {
    await bot.sendMessage(
      chatId,
      `Audit log failed (${auditErr?.message ?? 'no row returned'}). Aborting write per guardrail #7.`,
    );
    return;
  }

  try {
    let metaResp: unknown;
    if (action.kind === 'pause') {
      metaResp = await pauseCampaign(action.campaignId);
    } else {
      metaResp = await setDailyBudget(action.campaignId, action.newDailyBudgetCents);
    }
    const after = await getCampaign(action.campaignId).catch(() => null);
    await supabase
      .from('agent_actions')
      .update({
        success: true,
        after_state: after as object | null,
        meta_response: metaResp as object,
      })
      .eq('id', audit.id);

    const summary =
      action.kind === 'pause'
        ? `Paused ${action.campaignName}.`
        : action.kind === 'budget'
          ? `Set ${action.campaignName} daily budget to ${fmtMoney(action.newDailyBudgetCents)}.`
          : `Boosted ${action.campaignName} by ${action.percent}%: ${fmtMoney(action.oldDailyBudgetCents)} -> ${fmtMoney(action.newDailyBudgetCents)}.`;
    await bot.sendMessage(chatId, summary);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const fbBody = (err as { response?: { data?: unknown } })?.response?.data;
    await supabase
      .from('agent_actions')
      .update({
        success: false,
        error_message: errMsg,
        meta_response: (fbBody as object | undefined) ?? null,
      })
      .eq('id', audit.id);
    const detail = fbBody ? `\n${JSON.stringify(fbBody).slice(0, 800)}` : '';
    await bot.sendMessage(chatId, `Meta API error:\n${errMsg}${detail}`);
  }
}

// ---------- Tools the agent can call (read + light-write + server-side) ----------

// Server-side tools execute on Anthropic's infra; no local handler needed.
// Listed first so they appear before custom tools in the array.
const SERVER_SIDE_TOOLS: unknown[] = [
  // Web search — Claude can look up current Meta policy, GLP-1 marketing trends, competitor research, etc.
  { type: 'web_search_20260209', name: 'web_search' },
  // Web fetch — pull a specific URL Claude wants to read.
  { type: 'web_fetch_20260209', name: 'web_fetch' },
];

const CUSTOM_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_campaigns',
    description:
      "List every campaign in the ad account with its current status, objective, daily budget. Call when you need a roster — to find a campaign by approximate name or to scan all of them. Cheap to call.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_campaign_insights',
    description:
      "Pull spend / impressions / clicks / CTR / CPM / leads at the campaign level over a chosen window. Use this for 'how did campaign X do' or 'what did we spend yesterday' questions.",
    input_schema: {
      type: 'object',
      properties: {
        date_preset: {
          type: 'string',
          enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d'],
          description: 'Time window to pull insights over',
        },
      },
      required: ['date_preset'],
    },
  },
  {
    name: 'list_ad_sets',
    description:
      "List ad sets — under a specific campaign if campaign_id is given, otherwise account-wide. Returns name, status, optimization_goal, daily_budget.",
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Optional campaign ID to scope under. Omit for account-wide.' },
      },
      required: [],
    },
  },
  {
    name: 'list_ads',
    description:
      "List ads — under a specific campaign or ad set if parent_id is given, otherwise account-wide. Returns name, status, creative type/headline, today's perf if any.",
    input_schema: {
      type: 'object',
      properties: {
        parent_id: { type: 'string', description: 'Optional campaign or ad set ID to scope under.' },
      },
      required: [],
    },
  },
  {
    name: 'get_ad_creative',
    description:
      "Pull a single ad's full creative: headline, body copy, CTA, thumbnail URL, video ID, preview link. Use when the user asks about specific ad copy or wants to QA before launch.",
    input_schema: {
      type: 'object',
      properties: { ad_id: { type: 'string', description: 'The ad ID' } },
      required: ['ad_id'],
    },
  },
  {
    name: 'get_ad_insights',
    description:
      "Pull spend / impressions / leads at the ad level under a parent (campaign or ad set). Use for 'which ad has the best CTR' or 'why is this ad set underperforming' questions.",
    input_schema: {
      type: 'object',
      properties: {
        parent_id: { type: 'string', description: 'Campaign or ad set ID' },
        date_preset: { type: 'string', enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d'] },
      },
      required: ['parent_id', 'date_preset'],
    },
  },
  {
    name: 'note_observation',
    description:
      "Save a durable note about the account, the user's preferences, or anything you've learned that future-you should remember. Examples: 'pixel was broken Aug-Oct 2025', 'user prefers we ask before pausing creative', 'campaign X audience is 25-34'. Topic should be a short tag like 'pixel', 'preference', 'campaign:Claya Images'.",
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        observation: { type: 'string' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['topic', 'observation'],
    },
  },
  {
    name: 'set_goal',
    description:
      "Save a goal the user has set, e.g. cpl_target=35, daily_spend_cap=300, weekly_spend_cap=2000. Stored as text. Use when the user says 'our target is X' or 'don't go above $Y/day'.",
    input_schema: {
      type: 'object',
      properties: {
        goal_key: { type: 'string', description: "Snake-case key, e.g. 'cpl_target', 'daily_spend_cap'" },
        goal_value: { type: 'string', description: 'The target value as a string (e.g. "35", "300")' },
      },
      required: ['goal_key', 'goal_value'],
    },
  },
  {
    name: 'list_rules',
    description: "List all currently active automation rules with their kind, params, and auto_execute flag.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_rule',
    description:
      "Create a pre-approved automation rule. Use when the user says 'auto-pause if X' or 'alert me when Y'. Default auto_execute to false (notify-only) unless the user is explicit about wanting the action taken automatically.\n\nSupported rule_kind values:\n- 'pause_high_cpl': params {cpl_threshold_dollars, min_spend_dollars?, window?: 'today'|'yesterday'|'last_7d'} — fires when a campaign's CPL over the window exceeds the threshold.\n- 'pause_zero_leads': params {min_spend_dollars, window?: 'today'|'yesterday'} — fires when an ACTIVE campaign has spent above min_spend with 0 leads.\n- 'cap_daily_spend': params {cap_dollars} — fires when total today's spend exceeds the cap. Notify-only in v1.\n- 'alert_anomaly': params {kind: 'spend_spike'|'cpl_spike', factor} — fires when today's spend or CPL is `factor`× the trailing-7 baseline.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short label, e.g. "Auto-pause CPL > 3x baseline"' },
        description: { type: 'string', description: 'Human-readable rule description' },
        rule_kind: { type: 'string', enum: ['pause_high_cpl', 'pause_zero_leads', 'cap_daily_spend', 'alert_anomaly'] },
        params: { type: 'object', description: 'Rule-kind-specific parameters' },
        auto_execute: { type: 'boolean', description: 'If true, execute the action automatically. If false (default), only notify.' },
      },
      required: ['name', 'description', 'rule_kind', 'params'],
    },
  },
  {
    name: 'disable_rule',
    description: "Disable a rule by ID. Use list_rules first to find the ID. The rule is preserved (active=false) so it can be re-enabled later.",
    input_schema: {
      type: 'object',
      properties: { rule_id: { type: 'integer', description: 'The rule ID' } },
      required: ['rule_id'],
    },
  },
  {
    name: 'list_pixels',
    description: "List all Meta Pixels attached to the ad account. Returns name, last_fired_time, is_unavailable. Use when the user asks about tracking, conversions, or the Pixel.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pixel_health',
    description: "Audit pixel health: how recently it fired, what events have been recorded, and a one-line diagnosis (live / warm / cold / unavailable). If pixel_id is omitted, audits every pixel on the account. Use when the user asks 'is the Pixel working' or when diagnosing zero-leads situations.",
    input_schema: {
      type: 'object',
      properties: {
        pixel_id: { type: 'string', description: 'Optional pixel ID. Omit to audit all pixels.' },
      },
      required: [],
    },
  },
  {
    name: 'list_accounts',
    description: "List the Meta ad account IDs this bot has access to. Useful when multiple accounts are configured.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'clone_ad_with_new_copy',
    description: "Clone an existing ad with new headline / body / CTA / link URL, save the new ad as PAUSED. The original is untouched. Use for A/B testing copy variants. Always returns the new ad ID so the user can publish from Ads Manager when ready. NEVER touches active ads — the new ad is always paused.",
    input_schema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string', description: 'Source ad ID to clone from' },
        new_headline: { type: 'string', description: 'Optional new headline' },
        new_body: { type: 'string', description: 'Optional new body copy' },
        new_cta: { type: 'string', description: "Optional new CTA type (e.g. 'LEARN_MORE','BOOK_NOW','SIGN_UP','SHOP_NOW','GET_OFFER')" },
        new_link_url: { type: 'string', description: 'Optional new landing URL' },
        new_ad_name: { type: 'string', description: 'Optional name for the new ad' },
      },
      required: ['ad_id'],
    },
  },
  {
    name: 'create_campaign',
    description: "Create a new campaign — always saved as PAUSED. Use when the user explicitly says 'create' or 'spin up' a campaign. Confirm campaign details with the user before calling. Daily budget hard-capped at $500 per single creation; floor $5.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        objective: {
          type: 'string',
          description: "Campaign objective: 'OUTCOME_LEADS','OUTCOME_SALES','OUTCOME_TRAFFIC','OUTCOME_AWARENESS','OUTCOME_ENGAGEMENT','OUTCOME_APP_PROMOTION'",
        },
        daily_budget_dollars: { type: 'number', description: 'Optional CBO daily budget at the campaign level' },
        special_ad_categories: { type: 'array', items: { type: 'string' }, description: "Special ad category codes if applicable, e.g. ['HOUSING','EMPLOYMENT','CREDIT','ISSUES_ELECTIONS_POLITICS']" },
      },
      required: ['name', 'objective'],
    },
  },
  {
    name: 'create_ad_set',
    description: "Create a new ad set under an existing campaign — always PAUSED. Use after create_campaign. Daily budget hard-capped at $500 per single creation; floor $5. Targeting must be a Meta API targeting object.",
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        name: { type: 'string' },
        daily_budget_dollars: { type: 'number' },
        optimization_goal: {
          type: 'string',
          description: "e.g. 'OFFSITE_CONVERSIONS','LEAD_GENERATION','LINK_CLICKS','REACH','IMPRESSIONS','POST_ENGAGEMENT','VIDEO_VIEWS'",
        },
        billing_event: { type: 'string', description: "Default 'IMPRESSIONS'. Other: 'LINK_CLICKS','PAGE_LIKES','POST_ENGAGEMENT'." },
        targeting: { type: 'object', description: 'Meta targeting spec — geo_locations, age_min/age_max, interests, custom_audiences, etc.' },
        promoted_object: {
          type: 'object',
          description: "For conversion goals: { pixel_id, custom_event_type } e.g. { pixel_id: '123', custom_event_type: 'LEAD' }",
        },
      },
      required: ['campaign_id', 'name', 'optimization_goal', 'targeting'],
    },
  },
  {
    name: 'create_ad',
    description: "Create a new ad under an existing ad set — always PAUSED. Requires a creative_id (use clone_ad_with_new_copy first if you need a new creative).",
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string' },
        name: { type: 'string' },
        creative_id: { type: 'string' },
      },
      required: ['adset_id', 'name', 'creative_id'],
    },
  },
  {
    name: 'get_ad_set_targeting',
    description: "Read the targeting JSON for an ad set. Returns geo_locations, age_min/max, interests, custom_audiences, etc.",
    input_schema: {
      type: 'object',
      properties: { ad_set_id: { type: 'string' } },
      required: ['ad_set_id'],
    },
  },
  {
    name: 'update_ad_set_targeting',
    description: "Replace the targeting on an ad set. **Only works on PAUSED ad sets** — refuses if ACTIVE. Always confirm the new targeting with the user before calling. Pass a complete Meta targeting spec.",
    input_schema: {
      type: 'object',
      properties: {
        ad_set_id: { type: 'string' },
        targeting: { type: 'object', description: 'Full Meta targeting spec to replace the existing targeting with' },
      },
      required: ['ad_set_id', 'targeting'],
    },
  },
  {
    name: 'list_custom_audiences',
    description: "List all custom audiences in the ad account — name, approximate_count, subtype (LOOKALIKE / CUSTOM / WEBSITE / etc).",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_lookalike_audience',
    description: "Create a Lookalike audience from an existing source audience. ratio is 0.01 (1%) to 0.20 (20%). Higher ratio = larger but lower-quality audience. Confirm with user before creating.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        source_audience_id: { type: 'string' },
        ratio: { type: 'number', description: 'Decimal 0.01 to 0.20' },
        country: { type: 'string', description: "Country code, e.g. 'US'" },
      },
      required: ['name', 'source_audience_id', 'ratio', 'country'],
    },
  },
  {
    name: 'cio_list_segments',
    description: "List all Customer.io segments (name, id, description, customer count). Use to find segment IDs for follow-up queries or to map a Meta audience to a CIO segment.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cio_count_segment',
    description: "Get the live customer count of one Customer.io segment by ID. Use after cio_list_segments.",
    input_schema: {
      type: 'object',
      properties: { segment_id: { type: 'integer' } },
      required: ['segment_id'],
    },
  },
  {
    name: 'cio_find_customer_by_email',
    description: "Find a Customer.io customer record by email. Returns id, attributes (utm_source, lead_source, etc.) — use to verify a Meta lead is in CIO and how it's tagged.",
    input_schema: {
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email'],
    },
  },
  {
    name: 'cio_get_customer_activity',
    description: "Pull the full event timeline for one customer (by email or CIO id). Returns events like form submits, page views, appointment_booked, etc. Use when investigating a specific lead's journey from Meta click to booking.",
    input_schema: {
      type: 'object',
      properties: {
        customer_id_or_email: { type: 'string' },
        limit: { type: 'integer', description: 'Default 100 most recent activities.' },
      },
      required: ['customer_id_or_email'],
    },
  },
  {
    name: 'cio_count_events',
    description: "Count events of a given name in Customer.io between two timestamps. Use to count leads / bookings / purchases over a time window. Event names are workspace-specific — common ones: 'lead', 'lead_captured', 'appointment_booked', 'consultation_booked', 'purchase', 'quiz_completed'. If unsure, call cio_get_customer_activity on a known customer first to discover event names.",
    input_schema: {
      type: 'object',
      properties: {
        event_name: { type: 'string' },
        start_iso: { type: 'string', description: "ISO 8601 datetime, e.g. '2026-04-29T00:00:00Z'" },
        end_iso: { type: 'string', description: "ISO 8601 datetime" },
      },
      required: ['event_name', 'start_iso', 'end_iso'],
    },
  },
  {
    name: 'cio_show_rate',
    description: "Compute the booking show rate over a time window: count of `booking_event_name` divided by count of `lead_event_name`. Returns lead count, booking count, show rate %. This is the closest thing to true CPB (cost per booking) when combined with Meta spend.",
    input_schema: {
      type: 'object',
      properties: {
        lead_event_name: { type: 'string' },
        booking_event_name: { type: 'string' },
        start_iso: { type: 'string' },
        end_iso: { type: 'string' },
      },
      required: ['lead_event_name', 'booking_event_name', 'start_iso', 'end_iso'],
    },
  },
  {
    name: 'cio_send_event',
    description: "Send an event INTO Customer.io for a specific customer. Use sparingly — the agent uses this to flag agent-detected milestones like 'agent_paused_campaign' or 'agent_flagged_pixel_issue' for downstream automation. Requires customer_id (CIO id) and event name.",
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'CIO customer id' },
        event_name: { type: 'string' },
        properties: { type: 'object', description: 'Optional event properties' },
      },
      required: ['customer_id', 'event_name'],
    },
  },
];

async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  chatId: number,
): Promise<unknown> {
  switch (name) {
    case 'list_campaigns': {
      const cs = await listCampaigns();
      return cs.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.effective_status ?? c.status,
        objective: c.objective ?? null,
        daily_budget_dollars: c.daily_budget ? Number(c.daily_budget) / 100 : null,
      }));
    }
    case 'get_campaign_insights': {
      const dp = (input.date_preset as 'today' | 'yesterday' | 'last_7d' | 'last_14d' | 'last_30d') ?? 'today';
      const ins = await getCampaignInsights(dp);
      return ins.map((i) => ({
        campaign_id: i.campaign_id,
        campaign_name: i.campaign_name,
        spend_dollars: Number(i.spend),
        leads: extractLeads(i),
        impressions: i.impressions ? Number(i.impressions) : 0,
        clicks: i.clicks ? Number(i.clicks) : 0,
        ctr_pct: i.ctr ? Number(i.ctr) : null,
        cpm_dollars: i.cpm ? Number(i.cpm) : null,
      }));
    }
    case 'list_ad_sets': {
      const ass = await listAdSets(input.campaign_id as string | undefined);
      return ass.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.effective_status ?? a.status,
        campaign_id: a.campaign_id ?? null,
        optimization_goal: a.optimization_goal ?? null,
        daily_budget_dollars: a.daily_budget ? Number(a.daily_budget) / 100 : null,
      }));
    }
    case 'list_ads': {
      const ads = await listAds(input.parent_id as string | undefined);
      return ads.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.effective_status ?? a.status,
        campaign_id: a.campaign_id ?? null,
        adset_id: a.adset_id ?? null,
        creative_type: a.creative?.object_type ?? null,
        headline: a.creative?.title ?? null,
      }));
    }
    case 'get_ad_creative': {
      const ad = await getAd(input.ad_id as string);
      return {
        id: ad.id,
        name: ad.name,
        status: ad.effective_status ?? ad.status,
        creative: ad.creative ?? null,
        preview: ad.preview_shareable_link ?? null,
      };
    }
    case 'get_ad_insights': {
      const dp = (input.date_preset as 'today' | 'yesterday' | 'last_7d' | 'last_14d' | 'last_30d') ?? 'last_7d';
      const ins = await getAdInsights(input.parent_id as string, dp);
      return ins.map((i) => ({
        ad_id: i.ad_id,
        ad_name: i.ad_name,
        spend_dollars: Number(i.spend),
        leads: extractLeads(i as never),
        ctr_pct: i.ctr ? Number(i.ctr) : null,
        cpm_dollars: i.cpm ? Number(i.cpm) : null,
      }));
    }
    case 'note_observation': {
      const id = await noteObservation(input.topic as string, input.observation as string, {
        chatId,
        confidence: input.confidence as 'low' | 'medium' | 'high' | undefined,
      });
      return { saved: id != null, id };
    }
    case 'set_goal': {
      await setGoal(input.goal_key as string, input.goal_value as string, chatId);
      return { saved: true };
    }
    case 'list_rules': {
      const rules = await loadActiveRules();
      return rules.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        rule_kind: r.rule_kind,
        params: r.params,
        auto_execute: r.auto_execute,
        trigger_count: r.trigger_count,
      }));
    }
    case 'create_rule': {
      const id = await createRule({
        chatId,
        name: input.name as string,
        description: input.description as string,
        rule_kind: input.rule_kind as string,
        params: (input.params as Record<string, unknown>) ?? {},
        auto_execute: (input.auto_execute as boolean) ?? false,
      });
      return { saved: id != null, id };
    }
    case 'disable_rule': {
      await setRuleActive(input.rule_id as number, false);
      return { disabled: true };
    }
    case 'list_pixels': {
      const pixels = await listPixels();
      return pixels.map((p) => ({
        id: p.id,
        name: p.name,
        last_fired_time: p.last_fired_time ?? null,
        is_unavailable: p.is_unavailable ?? false,
      }));
    }
    case 'get_pixel_health': {
      return await getPixelHealth(input.pixel_id as string | undefined);
    }
    case 'list_accounts': {
      return AD_ACCOUNTS.map((id) => ({ id, is_default: id === AD_ACCOUNTS[0] }));
    }
    case 'clone_ad_with_new_copy': {
      const result = await cloneAdWithNewCopy({
        ad_id: input.ad_id as string,
        new_headline: input.new_headline as string | undefined,
        new_body: input.new_body as string | undefined,
        new_cta: input.new_cta as string | undefined,
        new_link_url: input.new_link_url as string | undefined,
        new_ad_name: input.new_ad_name as string | undefined,
      });
      await logAgentAction(chatId, 'clone_ad_with_new_copy', result.source_ad_id, result.source_ad_name, result.changes, {
        new_ad_id: result.new_ad_id,
        new_creative_id: result.new_creative_id,
      });
      return result;
    }
    case 'create_campaign': {
      const dollars = input.daily_budget_dollars as number | undefined;
      const result = await createCampaign({
        name: input.name as string,
        objective: input.objective as string,
        special_ad_categories: input.special_ad_categories as string[] | undefined,
        daily_budget_cents: dollars != null ? Math.round(dollars * 100) : undefined,
      });
      await logAgentAction(chatId, 'create_campaign', result.id, input.name as string, null, result.payload);
      return result;
    }
    case 'create_ad_set': {
      const dollars = input.daily_budget_dollars as number | undefined;
      const result = await createAdSet({
        campaign_id: input.campaign_id as string,
        name: input.name as string,
        daily_budget_cents: dollars != null ? Math.round(dollars * 100) : undefined,
        optimization_goal: input.optimization_goal as string,
        billing_event: input.billing_event as string | undefined,
        targeting: (input.targeting as Record<string, unknown>) ?? {},
        promoted_object: input.promoted_object as Record<string, unknown> | undefined,
      });
      await logAgentAction(chatId, 'create_ad_set', result.id, input.name as string, null, result.payload);
      return result;
    }
    case 'create_ad': {
      const result = await createAd({
        adset_id: input.adset_id as string,
        name: input.name as string,
        creative_id: input.creative_id as string,
      });
      await logAgentAction(chatId, 'create_ad', result.id, input.name as string, null, { creative_id: input.creative_id });
      return result;
    }
    case 'get_ad_set_targeting': {
      return await getAdSetTargeting(input.ad_set_id as string);
    }
    case 'update_ad_set_targeting': {
      const before = await getAdSetTargeting(input.ad_set_id as string);
      const resp = await updateAdSetTargeting(
        input.ad_set_id as string,
        (input.targeting as Record<string, unknown>) ?? {},
      );
      await logAgentAction(chatId, 'update_ad_set_targeting', input.ad_set_id as string, null, before, input.targeting);
      return resp;
    }
    case 'list_custom_audiences': {
      const aud = await listCustomAudiences();
      return aud.map((a) => ({
        id: a.id,
        name: a.name,
        approximate_count: a.approximate_count ?? null,
        subtype: a.subtype ?? null,
      }));
    }
    case 'create_lookalike_audience': {
      const result = await createLookalikeAudience({
        name: input.name as string,
        source_audience_id: input.source_audience_id as string,
        ratio: input.ratio as number,
        country: input.country as string,
      });
      await logAgentAction(chatId, 'create_lookalike_audience', result.id, input.name as string, null, input);
      return result;
    }
    case 'cio_list_segments': {
      const segs = await cioListSegments();
      return segs.map((s) => ({ id: s.id, name: s.name, description: s.description ?? null, type: s.type ?? null }));
    }
    case 'cio_count_segment': {
      return { count: await cioCountSegment(input.segment_id as number) };
    }
    case 'cio_find_customer_by_email': {
      const c = await cioFindCustomerByEmail(input.email as string);
      return c ?? { found: false };
    }
    case 'cio_get_customer_activity': {
      const acts = await cioGetCustomerActivity(
        input.customer_id_or_email as string,
        (input.limit as number | undefined) ?? 100,
      );
      return acts.map((a) => ({
        id: a.id,
        type: a.type,
        name: a.name ?? null,
        timestamp: a.timestamp ?? null,
        timestamp_iso: a.timestamp ? new Date(a.timestamp * 1000).toISOString() : null,
        delivery_type: a.delivery_type ?? null,
        data: a.data ?? null,
      }));
    }
    case 'cio_count_events': {
      const start = Math.floor(new Date(input.start_iso as string).getTime() / 1000);
      const end = Math.floor(new Date(input.end_iso as string).getTime() / 1000);
      return { count: await cioCountEvents(input.event_name as string, start, end) };
    }
    case 'cio_show_rate': {
      const start = Math.floor(new Date(input.start_iso as string).getTime() / 1000);
      const end = Math.floor(new Date(input.end_iso as string).getTime() / 1000);
      return await cioShowRate({
        lead_event_name: input.lead_event_name as string,
        booking_event_name: input.booking_event_name as string,
        start_unix: start,
        end_unix: end,
      });
    }
    case 'cio_send_event': {
      await cioSendEvent({
        customer_id: input.customer_id as string,
        name: input.event_name as string,
        data: input.properties as Record<string, unknown> | undefined,
      });
      return { sent: true };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function logAgentAction(
  chatId: number,
  command: string,
  targetId: string | null,
  targetName: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  try {
    await supabase.from('agent_actions').insert({
      chat_id: String(chatId),
      user_handle: 'agent',
      command,
      target_campaign_id: targetId,
      target_campaign_name: targetName,
      before_state: before as object | null,
      after_state: after as object | null,
      success: true,
    });
  } catch (err) {
    console.warn('logAgentAction failed:', err);
  }
}

// ---------- Free-form ask Claude (memory + tool-using agent loop) ----------

// Maps Telegram user IDs / usernames to first-name display labels Clayton uses.
const USER_DISPLAY: Record<string, { first_name: string; full_name: string; role: string }> = {
  '8219840935': { first_name: 'Pack', full_name: 'Jaron Baston', role: 'account owner' },
  '519600114': { first_name: 'Josh', full_name: 'Joshua Tatum', role: 'co-operator' },
};

function identifySender(userId?: number | string, username?: string | null): { id: string; first_name: string; full_name: string; role: string } {
  if (userId != null) {
    const found = USER_DISPLAY[String(userId)];
    if (found) return { id: String(userId), ...found };
  }
  // Fallback: username-based for cases where ID isn't passed
  if (username) {
    if (username.toLowerCase() === 'pack87') return { id: 'unknown', ...USER_DISPLAY['8219840935'] };
    if (username.toLowerCase() === 'joshuatatum') return { id: 'unknown', ...USER_DISPLAY['519600114'] };
  }
  return { id: 'unknown', first_name: 'unknown', full_name: 'unknown', role: 'unknown' };
}

async function askClaude(
  userText: string,
  chatId: number,
  sender?: { userId?: number | string; username?: string | null; chatType?: string },
): Promise<void> {
  await bot.sendChatAction(chatId, 'typing');

  // 1. Persist this user turn immediately so it's part of memory even if the call fails.
  await recordMessage(chatId, 'user', userText);

  // 2. Pull context: rolling conversation, persistent observations, active goals.
  const [history, observations, goals] = await Promise.all([
    loadRecentMessages(chatId),
    loadActiveObservations(),
    loadActiveGoals(),
  ]);

  // Drop the just-recorded message off the end of history; we'll add it as the live user turn.
  const priorHistory = history.slice(0, -1);

  const who = identifySender(sender?.userId, sender?.username);
  const chatLabel =
    sender?.chatType === 'group' || sender?.chatType === 'supergroup'
      ? 'group chat (Meta Ads — both Pack and Josh present)'
      : 'direct message';

  const sessionContext = [
    `You are Clayton.`,
    `Current message is from: ${who.first_name} (${who.full_name}, ${who.role}, telegram_id=${who.id})`,
    `Conversation surface: ${chatLabel}`,
    `Current server time (UTC): ${new Date().toISOString()}`,
    `Account-local timezone: ${ACCOUNT_TZ}`,
    `Ad account: ${process.env.META_AD_ACCOUNT}`,
    '',
    observations.length > 0
      ? `Persistent observations you've previously saved (most recent first):\n${observations
          .map((o) => `- [${o.topic}] ${o.observation} (confidence: ${o.confidence ?? 'medium'})`)
          .join('\n')}`
      : 'No persistent observations yet.',
    '',
    goals.length > 0
      ? `Active goals the user has set:\n${goals.map((g) => `- ${g.goal_key}: ${g.goal_value}`).join('\n')}`
      : 'No goals set yet.',
    '',
    `Address ${who.first_name} by their first name when natural. You have tools to query the live ad account directly — call them when you need fresh data, do not assume. Use note_observation to remember anything important for future conversations. Use set_goal when the user states a target.`,
  ].join('\n');

  // 3. Build the message array: rolling history + a session-context turn + the current user turn.
  const messages: Anthropic.MessageParam[] = [
    ...priorHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: `[session context]\n${sessionContext}` },
    { role: 'user', content: userText },
  ];

  // 4. Tool-use loop: keep calling Claude until it stops asking for tools.
  let assistantText = '';
  const MAX_HOPS = 8;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: [{ type: 'text', text: AGENT_MD, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixing custom + server-side tool types
      tools: [...SERVER_SIDE_TOOLS, ...CUSTOM_TOOLS] as any,
      messages,
    });

    // Append the full assistant turn (preserves tool_use blocks for the next iteration).
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      assistantText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    // Execute every tool_use in this turn and feed results back.
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      try {
        const result = await dispatchTool(tu.name, tu.input as Record<string, unknown>, chatId);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result).slice(0, 12_000),
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `error: ${m}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  if (!assistantText) assistantText = '[no response]';

  // 5. Persist the assistant reply so future turns can see it.
  await recordMessage(chatId, 'assistant', assistantText);

  await sendChunked(chatId, assistantText);
}

// ---------- Router ----------

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim();
  const handle = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? 'unknown');

  if (!text) return;

  // Auth: allow if user_id is whitelisted OR username is whitelisted.
  const senderId = msg.from?.id != null ? String(msg.from.id) : null;
  const senderUsername = msg.from?.username?.toLowerCase() ?? null;
  const idMatch = senderId != null && ALLOWED_USER_IDS.has(senderId);
  const nameMatch = senderUsername != null && ALLOWED_USERNAMES.has(senderUsername);
  if (!idMatch && !nameMatch) {
    console.warn(
      `[unauthorized] from id=${senderId ?? '?'} username=@${msg.from?.username ?? '<none>'} text=${text.slice(0, 80)}`,
    );
    return;
  }

  // Per-user pending action: in groups, only the same user who started the
  // /pause /budget /boost can confirm it.
  const userKey = senderId ?? senderUsername ?? '';

  try {
    // If a pending action is waiting and the user did NOT start a new slash command,
    // try to interpret their reply as confirm/cancel.
    if (peekPending(chatId, userKey) && !text.startsWith('/')) {
      const verdict = classifyReply(text);
      if (verdict === 'confirm') {
        const action = takePending(chatId, userKey);
        if (action) await executePending(chatId, action, handle, text);
        return;
      }
      if (verdict === 'cancel') {
        takePending(chatId, userKey);
        await bot.sendMessage(chatId, 'Cancelled.');
        return;
      }
      // unclear → fall through to Claude
    }

    if (text.startsWith('/')) {
      const firstSpace = text.indexOf(' ');
      const cmdRaw = (firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace)).toLowerCase();
      const args = firstSpace === -1 ? '' : text.slice(firstSpace + 1).trim();

      switch (cmdRaw) {
        case 'start':
        case 'help':
          await bot.sendMessage(
            chatId,
            [
              'Read:',
              '/status — live today',
              '/report — yesterday vs benchmarks',
              '/changes — last 24h diff',
              '/adsets [campaign] — ad sets in a campaign (omit for account-wide)',
              '/ads [campaign or ad set] — ads under a parent (omit for account-wide)',
              '/creative <ad> — pull headline, body, thumbnail, CTA into Telegram',
              '/pixel — Pixel health audit (last fire, events, diagnosis)',
              '/accounts — list ad accounts this bot has access to',
              '/journey <email> — full Customer.io journey for one lead',
              '',
              'Daily rhythm:',
              '/briefing — fire morning briefing now',
              '/recap — fire end-of-day recap now',
              '',
              'Write (gated, requires confirm reply):',
              '/pause <campaign>',
              '/budget <campaign> <amount>',
              '/boost <campaign> <percent>',
              '',
              'Or ask anything in plain English. The agent has web search, can drill into ads, save observations, set goals, and create rules.',
            ].join('\n'),
          );
          return;
        case 'report':
          await handleReport(chatId);
          return;
        case 'status':
          await handleStatus(chatId);
          return;
        case 'changes':
          await handleChanges(chatId);
          return;
        case 'adsets':
        case 'adset':
          await handleAdSetsCmd(chatId, args);
          return;
        case 'ads':
          await handleAdsCmd(chatId, args);
          return;
        case 'creative':
        case 'ad':
          await handleCreativeCmd(chatId, args);
          return;
        case 'journey': {
          if (!CIO_CONFIGURED) {
            await bot.sendMessage(chatId, 'Customer.io not configured (CIO_APP_API_KEY missing).');
            return;
          }
          if (!args.trim()) {
            await bot.sendMessage(chatId, 'Usage: /journey <email>');
            return;
          }
          await bot.sendChatAction(chatId, 'typing');
          try {
            const customer = await cioFindCustomerByEmail(args.trim());
            if (!customer) {
              await bot.sendMessage(chatId, `No Customer.io record found for ${args.trim()}.`);
              return;
            }
            const acts = await cioGetCustomerActivity(args.trim(), 50);
            const lines: string[] = [
              `Customer: ${customer.email ?? args.trim()}`,
              `CIO id: ${customer.cio_id ?? customer.id}`,
              '',
              `Events (${acts.length}):`,
              '',
            ];
            for (const a of acts.slice(0, 50)) {
              const t = a.timestamp ? new Date(a.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 16) : '?';
              lines.push(`${t}  ${a.type}${a.name ? ' / ' + a.name : ''}`);
            }
            await sendChunked(chatId, lines.join('\n'));
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            await bot.sendMessage(chatId, `Couldn't pull journey: ${m}`);
          }
          return;
        }
        case 'pixel':
        case 'pixels': {
          await bot.sendChatAction(chatId, 'typing');
          const health = await getPixelHealth();
          if (health.length === 0) {
            await bot.sendMessage(chatId, 'No Pixels attached to this account.');
            return;
          }
          const lines: string[] = ['Pixel health:', ''];
          for (const h of health) {
            lines.push(
              `${h.pixel_name} (${h.pixel_id})`,
              `  ${h.diagnosis}`,
              `  last_fired: ${h.last_fired_time ?? 'never'}`,
              h.events_seen.length > 0
                ? `  events seen: ${h.events_seen.slice(0, 8).map((e) => `${e.event}(${e.count})`).join(', ')}`
                : '  events seen: none',
              '',
            );
          }
          await sendChunked(chatId, lines.join('\n'));
          return;
        }
        case 'accounts': {
          const lines = ['Ad accounts this bot can see:', ''];
          for (const id of AD_ACCOUNTS) {
            lines.push(`  ${id}${id === AD_ACCOUNTS[0] ? '  (default)' : ''}`);
          }
          await bot.sendMessage(chatId, lines.join('\n'));
          return;
        }
        case 'briefing':
        case 'runbriefing':
          await bot.sendMessage(chatId, 'Running morning briefing now...');
          runBriefing('morning')
            .then(() => bot.sendMessage(chatId, 'Briefing run complete.'))
            .catch((err) => bot.sendMessage(chatId, `Briefing failed: ${err instanceof Error ? err.message : String(err)}`));
          return;
        case 'recap':
        case 'runrecap':
          await bot.sendMessage(chatId, 'Running end-of-day recap now...');
          runBriefing('recap')
            .then(() => bot.sendMessage(chatId, 'Recap run complete.'))
            .catch((err) => bot.sendMessage(chatId, `Recap failed: ${err instanceof Error ? err.message : String(err)}`));
          return;
        case 'pause':
          await handlePauseCmd(chatId, userKey, args);
          return;
        case 'budget':
          await handleBudgetCmd(chatId, userKey, args);
          return;
        case 'boost':
          await handleBoostCmd(chatId, userKey, args);
          return;
        default:
          await bot.sendMessage(chatId, `Unknown command /${cmdRaw}. /help to list.`);
          return;
      }
    }

    await askClaude(text, chatId, {
      userId: senderId ?? undefined,
      username: senderUsername,
      chatType: msg.chat.type,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error('handler error:', err);
    await bot.sendMessage(chatId, `Error: ${m}`);
  }
});

bot.on('polling_error', (err) => {
  console.error('polling error:', err);
});

// ---------- Daily cron schedules (in-process) ----------
// Eliminates the need for GitHub Actions secrets — bot is already on
// Railway with all env vars. Same Claude/Meta/Supabase/Telegram clients
// the chat handler already uses. Schedules are in account-local TZ.

const ENABLE_CRON = (process.env.ENABLE_CRON ?? 'true').toLowerCase() !== 'false';

if (ENABLE_CRON) {
  // 9:00 AM account-local — morning briefing
  cron.schedule(
    '0 9 * * *',
    () => {
      console.log(`[cron] morning briefing firing at ${new Date().toISOString()}`);
      runBriefing('morning').catch((err) => console.error('morning briefing failed:', err));
    },
    { timezone: ACCOUNT_TZ },
  );

  // 6:00 PM account-local — end-of-day recap
  cron.schedule(
    '0 18 * * *',
    () => {
      console.log(`[cron] end-of-day recap firing at ${new Date().toISOString()}`);
      runBriefing('recap').catch((err) => console.error('recap failed:', err));
    },
    { timezone: ACCOUNT_TZ },
  );

  console.log(`[cron] scheduled morning 9:00 + recap 18:00 in tz=${ACCOUNT_TZ}`);
}

console.log(
  `Facebook ad agent running. model=${MODEL} account=${process.env.META_AD_ACCOUNT} tz=${ACCOUNT_TZ}`,
);
