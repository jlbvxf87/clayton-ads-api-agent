import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';
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
  type Campaign,
  type AdSet,
  type Ad,
  type AdInsight,
} from './meta.js';

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
const pending = new Map<number, { action: PendingAction; expiresAt: number }>();

function setPending(chatId: number, action: PendingAction): void {
  pending.set(chatId, { action, expiresAt: Date.now() + PENDING_TTL_MS });
}

function takePending(chatId: number): PendingAction | null {
  const entry = pending.get(chatId);
  if (!entry) return null;
  pending.delete(chatId);
  if (Date.now() > entry.expiresAt) return null;
  return entry.action;
}

function peekPending(chatId: number): PendingAction | null {
  const entry = pending.get(chatId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pending.delete(chatId);
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

async function handlePauseCmd(chatId: number, args: string): Promise<void> {
  if (!args.trim()) {
    await bot.sendMessage(chatId, 'Usage: /pause <campaign name or id>');
    return;
  }
  const campaign = await findCampaignByQuery(args);
  if (!campaign) {
    await bot.sendMessage(chatId, `No campaign matched "${args}".`);
    return;
  }
  setPending(chatId, {
    kind: 'pause',
    campaignId: campaign.id,
    campaignName: campaign.name,
  });
  await bot.sendMessage(
    chatId,
    `Pause this campaign?\n${campaign.name}\nstatus ${campaign.effective_status ?? campaign.status}\ndaily ${fmtMoney(campaign.daily_budget ? Number(campaign.daily_budget) : null)}\n\nReply confirm / yes / kill it to proceed, or anything else to cancel.`,
  );
}

async function handleBudgetCmd(chatId: number, args: string): Promise<void> {
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

  setPending(chatId, {
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

async function handleBoostCmd(chatId: number, args: string): Promise<void> {
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

  setPending(chatId, {
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

// ---------- Free-form ask Claude ----------

async function askClaude(userText: string, chatId: number): Promise<void> {
  await bot.sendChatAction(chatId, 'typing');

  const [campaigns, todayInsights, ydayInsights] = await Promise.all([
    listCampaigns(),
    getCampaignInsights('today'),
    getCampaignInsights('yesterday'),
  ]);
  const todayById = new Map(todayInsights.map((i) => [i.campaign_id, i] as const));
  const ydayById = new Map(ydayInsights.map((i) => [i.campaign_id, i] as const));

  const liveContext = campaigns.map((c) => {
    const t = todayById.get(c.id);
    const y = ydayById.get(c.id);
    return {
      id: c.id,
      name: c.name,
      status: c.effective_status ?? c.status,
      objective: c.objective ?? null,
      daily_budget_dollars: c.daily_budget ? Number(c.daily_budget) / 100 : null,
      today: t
        ? {
            spend_dollars: Number(t.spend),
            leads: extractLeads(t),
            ctr_pct: t.ctr ? Number(t.ctr) : null,
            cpc_dollars: t.cpc ? Number(t.cpc) : null,
            cpm_dollars: t.cpm ? Number(t.cpm) : null,
            frequency: t.frequency ? Number(t.frequency) : null,
          }
        : null,
      yesterday: y
        ? {
            spend_dollars: Number(y.spend),
            leads: extractLeads(y),
            ctr_pct: y.ctr ? Number(y.ctr) : null,
            cpm_dollars: y.cpm ? Number(y.cpm) : null,
          }
        : null,
    };
  });

  const dataBlock = `Live campaign snapshot for ${process.env.META_AD_ACCOUNT}.\n\nCurrent server time (UTC): ${new Date().toISOString()}\nAccount-local timezone: ${ACCOUNT_TZ}\n\nCampaigns (today + yesterday):\n${JSON.stringify(liveContext, null, 2)}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: [
      {
        type: 'text',
        text: AGENT_MD,
        cache_control: { type: 'ephemeral' },
      },
    ],
    thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: dataBlock },
      { role: 'user', content: userText },
    ],
  });

  const out = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  await sendChunked(chatId, out);
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

  try {
    // If a pending action is waiting and the user did NOT start a new slash command,
    // try to interpret their reply as confirm/cancel.
    if (peekPending(chatId) && !text.startsWith('/')) {
      const verdict = classifyReply(text);
      if (verdict === 'confirm') {
        const action = takePending(chatId);
        if (action) await executePending(chatId, action, handle, text);
        return;
      }
      if (verdict === 'cancel') {
        takePending(chatId);
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
              '',
              'Write (gated, requires confirm reply):',
              '/pause <campaign>',
              '/budget <campaign> <amount>',
              '/boost <campaign> <percent>',
              '',
              'Or ask anything in plain English.',
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
        case 'pause':
          await handlePauseCmd(chatId, args);
          return;
        case 'budget':
          await handleBudgetCmd(chatId, args);
          return;
        case 'boost':
          await handleBoostCmd(chatId, args);
          return;
        default:
          await bot.sendMessage(chatId, `Unknown command /${cmdRaw}. /help to list.`);
          return;
      }
    }

    await askClaude(text, chatId);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error('handler error:', err);
    await bot.sendMessage(chatId, `Error: ${m}`);
  }
});

bot.on('polling_error', (err) => {
  console.error('polling error:', err);
});

console.log(
  `Facebook ad agent running. model=${MODEL} account=${process.env.META_AD_ACCOUNT} tz=${ACCOUNT_TZ}`,
);
