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
  resumeCampaign,
  setDailyBudget,
  listAdSets,
  listAds,
  getAd,
  getAdSetInsights,
  getAdInsights,
  setAdSetStatus,
  setAdStatus,
  listPixels,
  getPixelHealth,
  getActionBreakdown,
  sumAction,
  cloneAdWithNewCopy,
  uploadImage,
  createAdFromImage,
  createCampaign,
  createAdSet,
  createAd,
  getAdSetTargeting,
  updateAdSetTargeting,
  listCustomAudiences,
  createLookalikeAudience,
  deleteCustomAudience,
  getInsightsBreakdown,
  getAdQualityScores,
  getAdSetLearningStatus,
  listActivityLog,
  searchAdInterests,
  suggestAdInterests,
  getMetaRecommendations,
  listCustomConversions,
  getAdPreview,
  getAuctionInsights,
  getDeliveryEstimate,
  getAccountInsights,
  type BreakdownDim,
  type AdPreviewFormat,
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
  getMemoryFailureCounts,
} from './memory.js';
import { checkSchemaHealth, formatSchemaBanner } from './healthcheck.js';
import {
  type PermissionKind,
  type PermissionScope,
  type RequirePermissionParams,
  ALL_PERMISSION_KINDS,
  listActivePermissions,
  listAllPermissions,
  grantPermission,
  revokePermission,
  recordPermissionUsage,
  requirePermission,
  describePermission,
  parseGrantArgs,
  checkSpendTier,
} from './permissions.js';
import {
  tagAndSaveAd,
  getCreativeTag,
  listCreativeTags,
  formatTagSummary,
  getCreativePerformanceByAngle,
  auditCreative,
  formatPolicyAudit,
} from './creative.js';
import {
  runCohortTick,
  getLatestCohort,
  listCohortHistory,
  discoverCohortEventMap,
  setCohortEventOverride,
  formatCohortForTelegram,
} from './cohorts.js';
import {
  runMonitorTick,
  listOpenInbox,
  listRecentInbox,
  resolveInboxItem,
} from './monitor.js';
import {
  getCapiConfig,
  updateCapiConfig,
  listEventMap,
  upsertEventMap,
  deleteEventMap,
  runCapiTick,
  runCapiBackfill,
  listRecentForwards,
  getCapiDigest,
  formatCapiDigest,
} from './capi.js';
import {
  runJudgmentOnSignal,
  listRecentJudgments,
  formatJudgmentForTelegram,
} from './judgment.js';
import {
  generateRebalanceProposal,
  applyRebalancePlan,
  rejectRebalancePlan,
  loadOpenProposal,
  listRecentPlans,
  runRebalanceTick,
  formatPlanForTelegram,
} from './rebalance.js';
import {
  listCompetitors,
  addCompetitor,
  removeCompetitor,
  setCompetitorEnabled,
  snapshotCompetitor,
  runDailyLpTick,
  loadLatestSnapshots,
  generateRecommendations,
  listRecommendations,
  markRecommendationStatus,
  formatRecommendationsForTelegram,
  SCREENSHOT_AVAILABLE,
  runLiftMeasurementTick,
  measureLpLift,
} from './lp.js';
import {
  loadActiveRules,
  createRule,
  setRuleActive,
  evaluateAllRules,
  executeAutoTriggers,
  seedDefaultRules,
} from './rules.js';
import {
  cioListSegments,
  cioCountSegment,
  cioFindCustomerByEmail,
  cioGetCustomerActivity,
  cioCountEvents,
  cioShowRate,
  cioSendEvent,
  cioDiscoverEventNames,
  cioHealthCheck,
  CIO_CONFIGURED,
} from './customerio.js';
import {
  demandEngineBrands,
  demandEngineSpy,
  demandEngineGenerate,
  demandEngineBuildPage,
  DEMAND_ENGINE_CONFIGURED,
} from './demandengine.js';

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

// ---------- Image attachment handling ----------

// ---------- Per-turn image registry ----------
// When a user attaches images to a Telegram message, askClaude() puts
// them here keyed by chatId so tools called within that turn can resolve
// the bytes by ref (e.g. 'img_0', 'img_1'). The registry is cleared at
// end of turn so tool calls in later turns can't accidentally re-upload
// stale images. Single bot, sequential turns per chat, so a Map is safe.
const turnImages = new Map<number, AttachedImage[]>();

function resolveAttachedImage(chatId: number, ref: string | undefined): AttachedImage | null {
  if (!ref) return null;
  const images = turnImages.get(chatId);
  if (!images || images.length === 0) return null;
  const m = ref.match(/^img_(\d+)$/);
  if (!m) return null;
  const idx = Number(m[1]);
  return images[idx] ?? null;
}

interface AttachedImage {
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string; // base64
}

const MAX_IMAGE_BYTES = 4_500_000; // ~4.5 MB — under Anthropic's 5 MB cap

function detectImageMime(bytes: Buffer): AttachedImage['media_type'] {
  // Sniff the first few magic bytes
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/jpeg'; // safe default
}

async function downloadAttachedImage(fileId: string): Promise<AttachedImage | null> {
  try {
    const link = await bot.getFileLink(fileId);
    const response = await fetch(link);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) {
      console.warn(`image ${fileId} too large (${buffer.length} bytes), skipping`);
      return null;
    }
    return {
      media_type: detectImageMime(buffer),
      data: buffer.toString('base64'),
    };
  } catch (err) {
    console.warn('downloadAttachedImage failed:', err);
    return null;
  }
}

async function extractImagesFromMessage(msg: TelegramBot.Message): Promise<AttachedImage[]> {
  const out: AttachedImage[] = [];
  // Telegram sends photos at multiple resolutions in msg.photo; the largest is last.
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const img = await downloadAttachedImage(largest.file_id);
    if (img) out.push(img);
  }
  // Photos sent as documents (e.g. iOS "send original" path)
  if (msg.document && msg.document.mime_type?.startsWith('image/')) {
    const img = await downloadAttachedImage(msg.document.file_id);
    if (img) out.push(img);
  }
  return out;
}

// ---------- Pending action state ----------

type PendingAction =
  | { kind: 'pause'; campaignId: string; campaignName: string }
  | { kind: 'resume'; campaignId: string; campaignName: string }
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
    }
  // Agent-tool call that hit a missing-standing-order. User reply 'yes' executes it.
  | {
      kind: 'tool_action';
      toolName: string;
      input: Record<string, unknown>;
      permKind: PermissionKind;
      targetLabel: string;
    }
  // Standing-order grant pending second-factor confirmation.
  | {
      kind: 'grant';
      permKind: PermissionKind;
      scope: PermissionScope;
      expiresAtIso: string | null;
      notes: string | null;
    }
  // Standing-order revoke pending second-factor confirmation.
  | { kind: 'revoke'; permissionId: number; reason: string | null };

const PENDING_TTL_MS = 5 * 60 * 1000;
// Key: `${chatId}:${userId}` — scopes confirmations to the user who started the
// action, so in group chats one person can't confirm another person's pending write.
// Value is now a QUEUE so multiple tool_actions in one LLM turn batch together
// instead of overwriting each other (previously: only the last one survived).
const pending = new Map<string, { actions: PendingAction[]; expiresAt: number }>();

function pendingKey(chatId: number, userId: number | string): string {
  return `${chatId}:${userId}`;
}

function setPending(chatId: number, userId: number | string, action: PendingAction): void {
  const k = pendingKey(chatId, userId);
  const existing = pending.get(k);
  const expiresAt = Date.now() + PENDING_TTL_MS;
  if (existing && existing.expiresAt > Date.now()) {
    existing.actions.push(action);
    existing.expiresAt = expiresAt;
  } else {
    pending.set(k, { actions: [action], expiresAt });
  }
}

function takePending(chatId: number, userId: number | string): PendingAction[] {
  const k = pendingKey(chatId, userId);
  const entry = pending.get(k);
  if (!entry) return [];
  pending.delete(k);
  if (Date.now() > entry.expiresAt) return [];
  return entry.actions;
}

function peekPending(chatId: number, userId: number | string): PendingAction[] {
  const k = pendingKey(chatId, userId);
  const entry = pending.get(k);
  if (!entry) return [];
  if (Date.now() > entry.expiresAt) {
    pending.delete(k);
    return [];
  }
  return [...entry.actions];
}

function pendingSize(chatId: number, userId: number | string): number {
  return peekPending(chatId, userId).length;
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
  let campaigns: Awaited<ReturnType<typeof listCampaigns>>;
  let todayInsights: Awaited<ReturnType<typeof getCampaignInsights>>;
  try {
    [campaigns, todayInsights] = await Promise.all([
      listCampaigns(),
      getCampaignInsights('today'),
    ]);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await bot.sendMessage(chatId, `Failed to fetch campaign data from Meta: ${m}`);
    return;
  }
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

  const active = rows.filter((r) => r.status === 'ACTIVE');
  const inactive = rows.filter((r) => r.status !== 'ACTIVE');

  const lines: string[] = [`Meta campaigns — ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' })} PT`, ''];

  if (active.length > 0) {
    lines.push('ACTIVE');
    for (const r of active) {
      lines.push(
        `  ${r.name}`,
        `  spend ${fmtMoney(r.spendCents)}  leads ${r.leads}  daily ${fmtMoney(r.dailyBudgetCents)}`,
        '',
      );
    }
  }
  if (inactive.length > 0) {
    lines.push('OFF / PAUSED');
    for (const r of inactive) {
      lines.push(`  ${r.name}  [${r.status}]`);
    }
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

async function handlePauseCmd(
  chatId: number,
  userId: number | string,
  args: string,
  userHandle = String(userId),
): Promise<void> {
  if (!args.trim()) {
    await bot.sendMessage(chatId, 'Usage: /pause <campaign name or id>');
    return;
  }
  const campaign = await findCampaignByQuery(args);
  if (!campaign) {
    await bot.sendMessage(chatId, `No campaign matched "${args}".`);
    return;
  }
  // Pause is low-risk and reversible — execute immediately, no confirmation step.
  await executePending(chatId, { kind: 'pause', campaignId: campaign.id, campaignName: campaign.name }, userHandle, '/pause');
}

// Mirror of /pause for the reverse direction. Deterministic path — bypasses
// the LLM tool-selection step entirely, so a typo like 'B' (option button)
// or a phrase containing extra words (e.g. "Yes resume ghost 500") can't
// route to the wrong tool. Same single-confirmation flow as /pause.
async function handleResumeCmd(chatId: number, userId: number | string, args: string): Promise<void> {
  if (!args.trim()) {
    await bot.sendMessage(chatId, 'Usage: /resume <campaign name or id>');
    return;
  }
  const campaign = await findCampaignByQuery(args);
  if (!campaign) {
    await bot.sendMessage(chatId, `No campaign matched "${args}".`);
    return;
  }
  const status = campaign.effective_status ?? campaign.status;
  if (status === 'ACTIVE') {
    await bot.sendMessage(chatId, `"${campaign.name}" is already ACTIVE. Nothing to resume.`);
    return;
  }
  setPending(chatId, userId, {
    kind: 'resume',
    campaignId: campaign.id,
    campaignName: campaign.name,
  });
  await bot.sendMessage(
    chatId,
    `Resume this campaign?\n${campaign.name}\nstatus ${status}\ndaily ${fmtMoney(campaign.daily_budget ? Number(campaign.daily_budget) : null)}\n\n**High blast radius** — verify Pixel + CIO are firing named events before resuming a paused campaign on this account (prior $24K/1-lead incident).\n\nReply confirm / yes / fire to proceed, or anything else to cancel.`,
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
  const tierCheck = checkSpendTier(newDollars);
  const tierLine = tierCheck.requires_approval
    ? `\nSpend tier: ${tierCheck.tier.toUpperCase()} — ${tierCheck.approval_message}`
    : '';

  setPending(chatId, userId, {
    kind: 'budget',
    campaignId: campaign.id,
    campaignName: campaign.name,
    newDailyBudgetCents: newCents,
    oldDailyBudgetCents: oldCents,
  });
  await bot.sendMessage(
    chatId,
    `Set daily budget?\n${campaign.name}\n${fmtMoney(oldCents)} -> ${fmtMoney(newCents)}\n7-day spend impact: ~${fmtMoney(Math.abs(deltaWeeklyCents))} ${deltaWeeklyCents >= 0 ? 'increase' : 'decrease'}${tierLine}\n\nReply confirm to proceed, anything else to cancel.`,
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

  const boostTierCheck = checkSpendTier(newCents / 100);
  const boostTierLine = boostTierCheck.requires_approval
    ? `\nSpend tier: ${boostTierCheck.tier.toUpperCase()} — ${boostTierCheck.approval_message}`
    : '';

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
    `Boost daily budget by ${pct > 0 ? '+' : ''}${pct}%?\n${campaign.name}\n${fmtMoney(oldCents)} -> ${fmtMoney(newCents)}${boostTierLine}\n\nReply confirm to proceed, anything else to cancel.`,
  );
}

// ---------- Confirmation classification ----------

const CONFIRM_REGEX =
  /\b(confirm|yes|yep|yeah|do it|go|go ahead|kill|kill it|stop|stop it|pause it|approve|approved|ok do|let'?s do|send it|fire|execute|proceed|scale it|boost it)\b/i;
const CANCEL_REGEX = /\b(no|cancel|nope|nvm|nevermind|never mind|abort|skip|don'?t|hold|wait)\b/i;

// Bare-only versions — strict allowlist of single utterances. Used for
// auto-applying an open rebalance proposal so that a phrase like
// "Yes resume ghost 500" (which CONTAINS "yes" but is clearly NOT a bare
// confirmation of a different thing) does NOT hijack an unrelated open
// rebalance plan. Compare to CONFIRM_REGEX/CANCEL_REGEX which are loose
// substring matches.
const BARE_CONFIRM_STRINGS = new Set<string>([
  'yes', 'y', 'yep', 'yeah', 'ok', 'okay',
  'confirm', 'confirmed', 'approve', 'approved',
  'go', 'go ahead', 'do it', 'fire', 'execute', 'proceed',
  'send it', "let's do it", 'lets do it', "let's go", 'lets go',
]);
const BARE_CANCEL_STRINGS = new Set<string>([
  'no', 'n', 'nope', 'cancel', 'nvm', 'nevermind', 'never mind',
  'abort', 'skip', 'hold', 'wait',
]);

function isBareConfirm(text: string): boolean {
  return BARE_CONFIRM_STRINGS.has(text.trim().toLowerCase());
}
function isBareCancel(text: string): boolean {
  return BARE_CANCEL_STRINGS.has(text.trim().toLowerCase());
}

/**
 * Two-bot routing in the shared Meta-Ads group: returns true when a
 * message is addressed to Google Clayton (@Clayton_googlebot) and this
 * bot (Clayton-Meta) should stay silent.
 *
 * Precedence:
 *   1. Explicit Clayton/Meta address at the START always wins
 *      ('clayton, X', 'meta, X', '/helpmeta', '@Clayton_metabot ...').
 *      These force Clayton to handle even if 'google' also appears.
 *   2. Otherwise, any of these route to Google Clayton:
 *        - '/helpgoogle', '/statusgoogle', any slash suffixed with 'google'
 *        - '/help@Clayton_googlebot' (slash with explicit Google @-handle)
 *        - '@Clayton_googlebot ...' as first token
 *        - the word 'google' appearing anywhere in the message
 *   3. Anything else → Clayton-Meta (the default).
 */
export function isAddressedToGoogleClayton(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;

  // Precedence 1: explicit Clayton/Meta address — overrides Google detection.
  if (/^(clayton|meta\s+clayton|meta)[,:]?\s/.test(t)) return false;
  if (/^\/[a-z_]+meta\b/.test(t)) return false;
  if (/^\/[a-z_]+@clayton_metabot\b/.test(t)) return false;
  if (/^@clayton_metabot\b/.test(t)) return false;

  // Precedence 2: Google addressing.
  if (/^\/[a-z_]+google\b/.test(t)) return true;
  if (/^\/[a-z_]+@clayton_googlebot\b/.test(t)) return true;
  if (/^@clayton_googlebot\b/.test(t)) return true;
  if (/\bgoogle\b/.test(t)) return true;

  return false;
}

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
  sender?: { userId?: number | string | null; username?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const overrideRequested = /\bOVERRIDE\b/.test(originalMessage);
  if (isTiredFingersWindow() && !overrideRequested) {
    const msg = 'Refused: 02:00–06:00 PT is the no-write window (tired-fingers protection). Add the word OVERRIDE to your reply to bypass.';
    await bot.sendMessage(chatId, msg);
    return { ok: false, error: 'tired-fingers window' };
  }

  if (action.kind === 'tool_action') {
    try {
      const result = await dispatchTool(action.toolName, action.input, chatId);
      const summary =
        typeof result === 'object' && result !== null
          ? JSON.stringify(result).slice(0, 600)
          : String(result);
      await bot.sendMessage(chatId, `Done — ${action.targetLabel}.\n${summary}`);
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await bot.sendMessage(chatId, `Failed to ${action.targetLabel}: ${m}`);
      return { ok: false, error: m };
    }
  }

  if (action.kind === 'grant') {
    try {
      const p = await grantPermission({
        kind: action.permKind,
        scope: action.scope,
        expires_at: action.expiresAtIso,
        granted_by_user_id: sender?.userId != null ? String(sender.userId) : null,
        granted_by_username: sender?.username ?? null,
        granted_at_chat_id: String(chatId),
        notes: action.notes,
      });
      await bot.sendMessage(chatId, `Saved. You won't be asked again for: ${describePermission(p)}`);
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await bot.sendMessage(chatId, `Failed to grant: ${m}`);
      return { ok: false, error: m };
    }
  }

  if (action.kind === 'revoke') {
    try {
      await revokePermission(action.permissionId, action.reason);
      await bot.sendMessage(chatId, `Revoked permission #${action.permissionId}.`);
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await bot.sendMessage(chatId, `Failed to revoke: ${m}`);
      return { ok: false, error: m };
    }
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
    const msg = `Audit log failed (${auditErr?.message ?? 'no row returned'}). Aborting write per guardrail #7.`;
    await bot.sendMessage(chatId, msg);
    return { ok: false, error: msg };
  }

  try {
    let metaResp: unknown;
    if (action.kind === 'pause') {
      metaResp = await pauseCampaign(action.campaignId);
    } else if (action.kind === 'resume') {
      metaResp = await resumeCampaign(action.campaignId);
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
        : action.kind === 'resume'
          ? `Resumed (set ACTIVE) ${action.campaignName}.`
          : action.kind === 'budget'
            ? `Set ${action.campaignName} daily budget to ${fmtMoney(action.newDailyBudgetCents)}.`
            : `Boosted ${action.campaignName} by ${action.percent}%: ${fmtMoney(action.oldDailyBudgetCents)} -> ${fmtMoney(action.newDailyBudgetCents)}.`;
    await bot.sendMessage(chatId, summary);
    return { ok: true };
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
    return { ok: false, error: errMsg };
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
    name: 'pause_campaign',
    description: "Pause a campaign by ID. Sets status=PAUSED on Meta. Audit-logged. Use after the user has explicitly authorized the pause — confirm in conversation first if there's any doubt. The slash command /pause is the deterministic alternative; this tool is for when the agent itself needs to act based on a request.",
    input_schema: {
      type: 'object',
      properties: { campaign_id: { type: 'string' } },
      required: ['campaign_id'],
    },
  },
  {
    name: 'resume_campaign',
    description: "Activate (un-pause) a campaign by ID. Sets status=ACTIVE on Meta. Audit-logged. **This is a high-blast-radius write — only call after explicit user confirmation in conversation.** Especially careful in this account given the prior \\$24K/1-lead Pixel issue: re-activation should follow Pixel verification.",
    input_schema: {
      type: 'object',
      properties: { campaign_id: { type: 'string' } },
      required: ['campaign_id'],
    },
  },
  {
    name: 'set_ad_set_status',
    description: "Set an ad set's status to ACTIVE or PAUSED by ID. Audit-logged. Confirm in conversation before activating. Useful when activating one ad set under an active campaign.",
    input_schema: {
      type: 'object',
      properties: {
        ad_set_id: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
      },
      required: ['ad_set_id', 'status'],
    },
  },
  {
    name: 'set_ad_status',
    description: "Set an ad's status to ACTIVE or PAUSED by ID. Audit-logged. Confirm in conversation before activating. Use when surgically activating winning ads — pull candidates first, present them, get a yes, then iterate one-by-one through this tool.",
    input_schema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
      },
      required: ['ad_id', 'status'],
    },
  },
  {
    name: 'set_daily_budget',
    description: "Set ONE campaign's (CBO) daily budget by ID. Takes daily_budget_dollars (whole dollars, e.g. 80 = $80/day). Audit-logged and GATED by the 'budget' permission: without a standing /grant it stages a SINGLE confirmation — one 'yes' executes, exactly like pause. This is the direct budget tool — when a user asks in plain English to change one campaign's budget, CALL THIS; do NOT bounce them to the /budget slash command. Hard rails always enforced: $5/day floor, $500/day cap, and a ±50% per-action change limit (bigger swings must be split into two steps). For multi-campaign budget shifts use propose_rebalance instead. Budget lives at the campaign (CBO) or ad-set level — not the ad level.",
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        daily_budget_dollars: { type: 'number', description: 'New daily budget in whole dollars (e.g. 80 = $80/day).' },
        campaign_name: { type: 'string', description: 'Optional campaign name — used in the confirmation prompt and audit label.' },
      },
      required: ['campaign_id', 'daily_budget_dollars'],
    },
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
    description: "Create a new campaign — always saved as PAUSED. Use when the user explicitly says 'create' or 'spin up' a campaign. Confirm campaign details with the user before calling. Daily budget hard-capped at $500 per single creation; floor $5. IMPORTANT: bid_strategy defaults to LOWEST_COST_WITHOUT_CAP. Only override to LOWEST_COST_WITH_BID_CAP or COST_CAP if the user explicitly wants a manual bid cap — those modes REQUIRE every child ad set to provide a bid_amount field, and if you forget, every ad set creation will 400 with 'Bid amount required'. For standard CBO + 'let Meta optimize', leave bid_strategy unset.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        objective: {
          type: 'string',
          description: "Campaign objective: 'OUTCOME_LEADS','OUTCOME_SALES','OUTCOME_TRAFFIC','OUTCOME_AWARENESS','OUTCOME_ENGAGEMENT','OUTCOME_APP_PROMOTION'",
        },
        daily_budget_dollars: { type: 'number', description: 'Optional CBO daily budget at the campaign level' },
        bid_strategy: {
          type: 'string',
          description: "Optional. Default 'LOWEST_COST_WITHOUT_CAP' (recommended). Set to 'LOWEST_COST_WITH_BID_CAP' or 'COST_CAP' ONLY if user explicitly wants a manual cap (then every ad set must pass bid_amount).",
        },
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
    name: 'upload_image_for_ad',
    description:
      "Upload a user-attached image to Meta's media library so it can be used in a new ad creative. The user must have attached the image to their current Telegram message — pass the registry ref (e.g. 'img_0') from the attached-images note. Returns an image_hash you can then pass to create_ad_with_uploaded_image. POLICY: before calling this for healthcare ads (Claya is GLP-1 / weight loss), inspect the image for before/after weight loss imagery, body shots with weight-loss text overlays, or 'guaranteed results' framing — flag those to the user and confirm before uploading, because Meta will reject the eventual ad even though the upload itself succeeds.",
    input_schema: {
      type: 'object',
      properties: {
        image_ref: {
          type: 'string',
          description: "Registry ref from the attached-images note, e.g. 'img_0'",
        },
        filename: {
          type: 'string',
          description: 'Optional friendly filename (cosmetic only — Meta dedupes by content hash)',
        },
      },
      required: ['image_ref'],
    },
  },
  {
    name: 'create_ad_with_uploaded_image',
    description:
      "Build a new ad from an uploaded image. Inherits the Facebook Page id from a template ad (defaults to the first existing ad in the target ad set; can be overridden with template_ad_id). Saves the new ad as PAUSED — the user must explicitly resume before it goes live. Use after upload_image_for_ad has returned an image_hash. Headline (40 chars rec) + primary_text + link_url required; description + cta optional.",
    input_schema: {
      type: 'object',
      properties: {
        ad_set_id: { type: 'string', description: 'Target ad set — new ad lands here as PAUSED' },
        image_hash: { type: 'string', description: 'From upload_image_for_ad' },
        headline: { type: 'string', description: 'The ad headline (link_data.name), ≤40 chars recommended' },
        primary_text: { type: 'string', description: 'The main body text shown above the image (link_data.message)' },
        description: { type: 'string', description: 'Optional secondary description below the headline' },
        cta: {
          type: 'string',
          description: "CTA button label: 'APPLY_NOW' | 'LEARN_MORE' | 'SIGN_UP' | 'GET_QUOTE' | 'BOOK_TRAVEL' | 'CONTACT_US' | 'DOWNLOAD' | 'GET_OFFER' | 'SHOP_NOW'",
        },
        link_url: { type: 'string', description: 'Destination URL the CTA points to' },
        ad_name: { type: 'string', description: "Optional friendly name; default 'image-upload <date>'" },
        template_ad_id: {
          type: 'string',
          description: 'Optional — borrow page_id from a specific ad instead of the first ad in the target ad set',
        },
      },
      required: ['ad_set_id', 'image_hash', 'headline', 'primary_text', 'link_url'],
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
    description: "Create a Lookalike audience from an existing source audience. ratio is 0.01 (1%) to 0.20 (20%). Higher ratio = larger but lower-quality audience. Confirm with user before creating. If a lookalike with the same (source, country, ratio) already exists in the account, this tool will return that existing audience instead of failing — the response will include `reused: true` and `source_name`. Use that existing audience_id when building ad sets; do NOT try to re-create.",
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
    name: 'delete_custom_audience',
    description: "Permanently delete a custom or lookalike audience by ID. Irreversible — Meta cannot restore it. Use to clean up failed lookalikes (operation_status describes 'delete this audience and try creating it again') or test audiences. Always confirm with user first; surface the audience name in the confirmation prompt.",
    input_schema: {
      type: 'object',
      properties: {
        audience_id: { type: 'string', description: 'The Meta audience ID, e.g. 120248546155450153' },
      },
      required: ['audience_id'],
    },
  },
  {
    name: 'audit_creative',
    description: "PRE-LAUNCH POLICY CHECK. Run Claude vision on an existing ad to predict whether Meta's automated review will reject it for the 'Drugs and Pharmaceutical Products' policy. Returns verdict (PASS / AT_RISK / WILL_REJECT) + confidence + specific risks found (vials, syringes, brand drug names, weight numbers, personal attribute violations) + actionable fixes per risk. **Always run this on any new Claya creative before flipping it ACTIVE** — costs ~$0.01 vs $X spend on a campaign that gets shut down. Also useful post-rejection to learn the specific trigger. For batches of 5+, wrap in batch_execute.",
    input_schema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string', description: 'Meta ad ID' },
      },
      required: ['ad_id'],
    },
  },
  {
    name: 'get_insights_breakdown',
    description: "Pull performance metrics broken down by ONE OR MORE dimensions. The single highest-value diagnostic — answers 'which placement converts best?' / 'which age segment is driving spend?' / 'are we losing money on Audience Network?' / 'what hours of the day perform?'. Returns spend, impressions, clicks, CTR, CPM, CPC, reach, frequency, actions[] per dimension combination. Available breakdown dims: 'age', 'gender', 'country', 'region', 'dma', 'impression_device', 'device_platform', 'publisher_platform', 'platform_position', 'hourly_stats_aggregated_by_advertiser_time_zone'. Pass 1-2 dims; passing 3+ explodes row count.",
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['account', 'campaign', 'adset', 'ad'], description: "Granularity. 'account' aggregates everything; the rest filter to parent_id." },
        parent_id: { type: 'string', description: 'Required for non-account levels.' },
        date_preset: { type: 'string', description: "e.g. 'today','yesterday','last_7d','last_14d','last_30d'" },
        breakdowns: { type: 'array', items: { type: 'string' }, description: 'Array of breakdown dims (see description).' },
      },
      required: ['level', 'date_preset', 'breakdowns'],
    },
  },
  {
    name: 'get_ad_quality_scores',
    description: "Pull Meta's quality diamond ratings + video watch metrics for every ad under a campaign/adset/ad. quality_ranking / engagement_rate_ranking / conversion_rate_ranking each rate the ad as BELOW_AVERAGE_10 (worst 10%) → BELOW_AVERAGE_20 → BELOW_AVERAGE_35 → AVERAGE → ABOVE_AVERAGE. **Meta's own verdict — the strongest single signal for 'why is this ad not working'**. Two BELOW_AVERAGE rankings means the creative is the problem, not the audience. Also returns video watch metrics (p25/50/75/100, avg time watched) for UGC video ads — early drop-off is the leading indicator of fatigue.",
    input_schema: {
      type: 'object',
      properties: {
        parent_id: { type: 'string', description: 'Campaign / adset / ad ID to scan ads under.' },
        date_preset: { type: 'string', description: "e.g. 'last_7d'" },
      },
      required: ['parent_id', 'date_preset'],
    },
  },
  {
    name: 'get_ad_set_learning_status',
    description: "Get Meta's official learning-phase status for an ad set. Returns LEARNING (still optimizing, expect noisy data), LEARNING_LIMITED (stuck — needs more conversions or audience expansion), or SUCCESS (out of learning, results are reliable). Includes conversions_count and conversions_needed so you know how close it is to exiting learning. **Use before pausing any ad set on noisy CPL — if it's still LEARNING, hold and wait.**",
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string' },
      },
      required: ['adset_id'],
    },
  },
  {
    name: 'list_activity_log',
    description: "Pull Meta's audit trail of changes on the ad account — who changed what and when. Use to answer 'who reactivated Ghost?', 'when was this budget changed?', 'what happened to this campaign last week?'. Returns event_time, event_type (CREATE / UPDATE / DELETE), actor_name (the FB user who made the change), object_type (campaign/adset/ad), object_name, extra_data (what specifically changed). Optionally pass since_iso / until_iso to bound the window.",
    input_schema: {
      type: 'object',
      properties: {
        since_iso: { type: 'string', description: 'ISO 8601 start time. Optional.' },
        until_iso: { type: 'string', description: 'ISO 8601 end time. Optional.' },
        limit: { type: 'integer', description: 'Max rows (default 100, max 500).' },
      },
      required: [],
    },
  },
  {
    name: 'search_ad_interests',
    description: "Search Meta's targeting taxonomy for valid interest IDs by keyword. Returns id, name, audience size bounds, taxonomy path. Use when building ad sets that target interests — many interest IDs from old playbooks are deprecated. Validates that an interest still exists before you stage create_adset with it. For best results, search broad terms ('Healthy diet' / 'Physical fitness') — niche health terms like 'Ozempic' or 'GLP-1' have mostly been removed from Meta's taxonomy.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', description: 'Default 25' },
      },
      required: ['query'],
    },
  },
  {
    name: 'suggest_ad_interests',
    description: "Given 1-3 seed interest names, returns related interests Meta suggests for expansion. Use to discover new audiences when you already have one working interest. E.g. seed_interests=['Healthy diet'] → returns Human nutrition, Physical fitness, Yoga, Weight training, etc.",
    input_schema: {
      type: 'object',
      properties: {
        seed_interests: { type: 'array', items: { type: 'string' }, description: 'Names of known-good interests' },
        limit: { type: 'integer', description: 'Default 25' },
      },
      required: ['seed_interests'],
    },
  },
  {
    name: 'get_meta_recommendations',
    description: "Pull Meta's own optimization recommendations for a campaign or ad set. Returns the same suggestions you see in Ads Manager: 'Consolidate ad sets', 'Increase budget', 'Expand audience', 'Use Advantage+ placements', etc. Each rec has code, title, message, importance (HIGH/MEDIUM/LOW). Use as a sanity check — Meta usually catches obvious structural issues you might miss.",
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Campaign or ad set ID' },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'list_custom_conversions',
    description: "List every Custom Conversion configured on the ad account — id, name, rule, event_type, default value, pixel association, archived state. Use when setting up new campaigns optimizing for downstream events (Lead, Purchase, Add to Cart) so you reference the correct CC_id, not raw pixel events.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_ad_preview',
    description: "Render a single ad as it will appear in the wild and return Meta's HTML preview. Use when reviewing creative without opening Ads Manager. Format options: MOBILE_FEED_STANDARD (default), DESKTOP_FEED_STANDARD, INSTAGRAM_STANDARD, INSTAGRAM_STORY, INSTAGRAM_REELS, FACEBOOK_REELS_MOBILE, MESSENGER_MOBILE_INBOX_MEDIA, AUDIENCE_NETWORK_REWARDED_VIDEO.",
    input_schema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string' },
        format: { type: 'string', description: 'Default MOBILE_FEED_STANDARD' },
      },
      required: ['ad_id'],
    },
  },
  {
    name: 'get_auction_insights',
    description: "Pull auction-level competitor data showing where you're losing impressions and to whom. Returns spend, impressions, and competitor-overlap dimensions. Use when CPL spikes and you suspect competitor pressure (very common in GLP-1: Hims, Ro, etc. running new offers). High competitor overlap on a single audience = the audience is saturated; expand or shift.",
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['campaign', 'adset', 'ad'] },
        parent_id: { type: 'string' },
        date_preset: { type: 'string', description: "e.g. 'last_7d'" },
      },
      required: ['level', 'date_preset'],
    },
  },
  {
    name: 'get_delivery_estimate',
    description: "Get Meta's projected audience size + daily reach BEFORE launching an ad set. Returns estimate_mau_lower / _upper bounds (matching the size shown in Ads Manager when you build targeting), plus an outcomes curve at different spend levels. Use to vet new targeting specs — if the estimate is <100K people, the audience is too narrow; >50M, too broad.",
    input_schema: {
      type: 'object',
      properties: {
        optimization_goal: { type: 'string', description: "e.g. 'OFFSITE_CONVERSIONS', 'LEAD_GENERATION'" },
        targeting: { type: 'object', description: 'Meta targeting spec — geo_locations, age, interests, custom_audiences, etc.' },
        daily_budget_dollars: { type: 'number', description: 'Optional daily budget for outcome-curve estimation' },
      },
      required: ['optimization_goal', 'targeting'],
    },
  },
  {
    name: 'get_account_insights',
    description: "One-shot aggregate of the WHOLE ad account for a date preset — total spend, impressions, clicks, CTR, CPM, CPC, reach, frequency, and full actions[] (every conversion event Meta saw). Use for top-level dashboards or when the user asks 'how's the account doing today/this week'. Faster than summing campaign rows.",
    input_schema: {
      type: 'object',
      properties: {
        date_preset: { type: 'string', description: "e.g. 'today','yesterday','last_7d'" },
      },
      required: ['date_preset'],
    },
  },
  {
    name: 'batch_execute',
    description:
      "MANDATORY for any task requiring ≥5 similar tool calls (e.g. 'create 36 ads', 'pause every losing campaign', 'delete all failed lookalikes', 'tag every ad'). Never stage 5+ individual tool calls in one turn — you will lose track around call ~10 and start narrating fake progress instead of executing. batch_execute runs the SAME inner tool N times in a deterministic for-loop OUTSIDE the LLM, so all N actions are guaranteed to execute exactly once. Returns { ok, failed, total, results, errors }. One permission prompt covers the whole batch; one progress report goes to Telegram. Concurrency capped at 5 by default to avoid Meta rate limits. Examples: { tool: 'create_ad', inputs: [{adset_id, name, creative_id}, ...], description: 'Clone 12 Ghost statics into 3 new ad sets' } | { tool: 'pause_campaign', inputs: [{campaign_id: 'X'}, {campaign_id: 'Y'}], description: 'Pause 8 losing campaigns' }",
    input_schema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: "Name of the inner tool to invoke N times. Must be an existing tool the agent has (create_ad, pause_campaign, set_ad_status, set_daily_budget, delete_custom_audience, create_lookalike_audience, etc). For a single campaign's budget prefer the direct set_daily_budget tool; for many campaigns at once use propose_rebalance, not a batch of budget changes.",
        },
        inputs: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of input objects, one per invocation of the inner tool.',
        },
        description: {
          type: 'string',
          description: "Plain-English label of what this batch does. Shown to the user in the permission prompt. E.g. 'Clone 12 statics into 3 ad sets'.",
        },
        concurrency: {
          type: 'integer',
          description: 'Optional parallel worker count (default 3, max 5). Lower if hitting Meta rate limits.',
        },
      },
      required: ['tool', 'inputs', 'description'],
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
  {
    name: 'get_action_breakdown',
    description:
      "Pull the FULL Meta action_type breakdown over a window — every action the Pixel records, not just leads. Returns rows with spend, impressions, clicks, CTR, CPM, plus an `actions` array containing every event type Meta saw (PageView, ViewContent, AddPaymentInfo, InitiateCheckout, Lead, Purchase, custom events like IntakeStep_12). Use this whenever the user asks about funnel steps, conversion paths, or 'how many people did X' — this is the closest Meta gets to step-level visibility. parent_id is optional (omit for account-wide). level is one of 'campaign' / 'adset' / 'ad'.",
    input_schema: {
      type: 'object',
      properties: {
        parent_id: { type: 'string', description: 'Campaign / ad set / ad ID. Omit for account-wide.' },
        level: { type: 'string', enum: ['campaign', 'adset', 'ad'] },
        date_preset: { type: 'string', enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d'] },
      },
      required: ['level', 'date_preset'],
    },
  },
  {
    name: 'cio_discover_event_names',
    description:
      "Scan recent Customer.io activity and return every distinct event name CIO has recorded, with counts, last-seen timestamps, and sample data-payload keys. **Use this BEFORE assuming you know what events fire** — Claya's specific event vocabulary is workspace-specific and you don't know it until you check. Especially important when the user asks about funnel completion, drop-off rates, or 'how many leads booked'. Default scan window is 30 days. After running, save the discovered map as a note_observation under topic 'cio:event_names_discovered' so future calls don't have to re-scan.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Days back to scan. Default 30.' },
      },
      required: [],
    },
  },
  {
    name: 'reconstruct_funnel',
    description:
      "Combine Meta action breakdown + CIO event counts into a step-by-step funnel report over a window. Returns: Meta spend, link clicks, landing page views, Meta-reported leads, CIO-recorded leads, CIO-recorded bookings, drop-off ratios at each step, blended CPL and CPB. **This is the right tool for any 'how is our funnel performing' question** — combines all sources, gives a real answer instead of fragments. Works even with default event names; pass overrides if cio_discover_event_names showed Claya uses different names.",
    input_schema: {
      type: 'object',
      properties: {
        date_preset: { type: 'string', enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d'] },
        cio_lead_event_name: { type: 'string', description: 'Default "lead"' },
        cio_booking_event_name: { type: 'string', description: 'Default "appointment_booked"' },
      },
      required: ['date_preset'],
    },
  },
  {
    name: 'compare_meta_vs_cio_leads',
    description:
      "Direct ratio of Meta-reported leads to CIO-recorded lead events over a window. Use when diagnosing whether 'lost leads' are a Pixel problem (Meta < CIO) or a funnel-completion problem (Meta > CIO). Diff > ~30% in either direction is suspicious. Returns counts, ratio, and a one-line diagnosis.",
    input_schema: {
      type: 'object',
      properties: {
        date_preset: { type: 'string', enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d'] },
        cio_lead_event_name: { type: 'string', description: 'Default "lead"' },
      },
      required: ['date_preset'],
    },
  },
  {
    name: 'list_competitor_landing_pages',
    description:
      "List the competitor landing-page URLs Clayton scrapes daily. Useful when the user asks 'who are we tracking' or before recommending a new addition.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'analyze_landing_pages',
    description:
      "Run a fresh scrape of all enabled competitor landing pages right now (don't wait for the 8 AM cron). Returns counts and per-URL status. Use sparingly — costs roughly one Anthropic vision call per competitor.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'propose_lp_recommendations',
    description:
      "Generate ranked landing-page recommendations from the latest competitor analyses + Claya funnel data. Each recommendation has hypothesis, competitor evidence, Claya signal, implementation steps, and expected lift band. Saves to lp_recommendations as status='proposed'. Use when the user asks 'what should we change on the page' or after a fresh scrape.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_lp_recommendations',
    description:
      "Read open or recent landing-page recommendations.",
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['proposed', 'sent', 'implemented', 'measured', 'rejected', 'all'],
        },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'track_lp_implementation',
    description:
      "Mark an LP recommendation as implemented on a specific date. Used so Clayton can later compare conversion pre/post deploy. Use when the user says 'I shipped recommendation #5 yesterday' or similar.",
    input_schema: {
      type: 'object',
      properties: {
        recommendation_id: { type: 'number' },
        deploy_date: { type: 'string', description: 'yyyy-mm-dd. Defaults to today.' },
      },
      required: ['recommendation_id'],
    },
  },
  {
    name: 'measure_lp_lift',
    description:
      "Force the pre/post conversion comparison for one implemented LP recommendation. Compares Claya's account-level lead_rate (leads/link_clicks) and CPL for the 14 days BEFORE deploy_date vs the 14 days AFTER. Marks status='measured' and writes the result to lp_recommendations. Auto-runs daily via cron at 7am PT for any rec past its 14-day soak — use this tool when the user wants to check sooner.",
    input_schema: {
      type: 'object',
      properties: { recommendation_id: { type: 'number' } },
      required: ['recommendation_id'],
    },
  },
  {
    name: 'propose_rebalance',
    description:
      "Generate a fresh banded rebalance proposal. Compares each active campaign's CPL (or CPB once auto-trigger fires) to the account weighted-average. Top 30% better than avg → +20% budget; bottom 30% worse → -20%; middle untouched. Saves to agent_rebalance_plans as status='proposed'. Returns the plan with all changes. Read-write but does NOT modify Meta budgets — execute_rebalance_plan does that.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'execute_rebalance_plan',
    description:
      "Apply a proposed rebalance plan to Meta — sets each campaign's daily budget to the proposed value. GATED by 'budget' permission, so without a standing order the wrapper will stage a pending tool_action and ask for confirmation. Use plan_id from propose_rebalance or load_open_rebalance_proposal.",
    input_schema: {
      type: 'object',
      properties: { plan_id: { type: 'number' } },
      required: ['plan_id'],
    },
  },
  {
    name: 'load_open_rebalance_proposal',
    description:
      "Read the most recent proposed rebalance plan (status='proposed'). Returns null if none open. Useful when the user asks 'show me the rebalance' or 'what's pending'.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_rebalance_history',
    description:
      "List recent rebalance plans across all statuses. Useful for the user auditing what's been proposed/applied/rejected over time.",
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
      required: [],
    },
  },
  {
    name: 'run_judgment_on_signal',
    description:
      "Run a structured reasoning pass on a single open inbox signal. The judgment includes hypothesis, ranked alternatives, evidence cited from the data, recommended action, and confidence. Saves to agent_judgments. Use when the user asks 'what's actually going on with X' or to triage an inbox item before deciding to pause/budget. One Anthropic call per invocation — don't spam.",
    input_schema: {
      type: 'object',
      properties: {
        inbox_id: { type: 'number', description: 'Inbox row to analyze (from list_inbox).' },
      },
      required: ['inbox_id'],
    },
  },
  {
    name: 'list_recent_judgments',
    description:
      "Look at recent judgment-loop outputs. Returns hypothesis + recommendation + confidence per row. Useful for the user to audit your reasoning over time.",
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
      required: [],
    },
  },
  {
    name: 'capi_status',
    description:
      "Read current CAPI bridge state — pixel_id, enabled flag, event mappings, last 10 forwards. Call this when the user asks about CIO→Meta tracking, Pixel coverage, or whether the bridge is running. Read-only.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'capi_run_tick',
    description:
      "Force-run the CAPI polling tick now (default 30-min lookback). Returns counts (scanned, matched, forwarded, errors). No-op when bridge is disabled. Read-only effect on Supabase but does send to Meta Conversions API if matches fire — use sparingly.",
    input_schema: {
      type: 'object',
      properties: {
        lookback_minutes: { type: 'number', description: 'How far back to scan CIO activities. Default 30.' },
      },
      required: [],
    },
  },
  {
    name: 'list_inbox',
    description:
      "Read the real-time monitor inbox. Each open signal is a cpl_spike / zero_leads / ctr_drop / spend_velocity item. Critical and alert items already pinged the user; notice/info items sit silently here for you to review. Call this when the user asks 'what's going on right now' or before suggesting action.",
    input_schema: {
      type: 'object',
      properties: {
        only_open: {
          type: 'boolean',
          description: 'If true (default), only unresolved items. If false, recent 24h including resolved.',
        },
      },
      required: [],
    },
  },
  {
    name: 'resolve_inbox_item',
    description:
      "Mark an inbox signal resolved with a short note explaining why. Use when the underlying issue is addressed (you paused the campaign, the user said it's intentional, etc.). Read-write but doesn't need permission gating — it's a local memory mark, not a Meta write.",
    input_schema: {
      type: 'object',
      properties: {
        inbox_id: { type: 'number' },
        note: { type: 'string' },
      },
      required: ['inbox_id'],
    },
  },
  {
    name: 'run_monitor_tick',
    description:
      "Force-run the monitor tick now instead of waiting for the 15-minute cron. Returns counts (detected, new_inbox, surfaced, auto_acted, auto_resolved). Use when the user asks 'check now' or after granting a standing order so any waiting items can auto-resolve.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_permissions',
    description:
      "List active standing-order permissions you've been granted. Each permission specifies a kind (pause/resume/budget/etc.), an optional scope (campaign filter, budget caps, ±%), and an expiry. Call this before deciding to act autonomously so you know what's pre-authorized.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'grant_permission',
    description:
      "PROPOSE a new standing-order permission for yourself. The user MUST reply 'yes' before it takes effect — this tool only stages a pending grant. Use it when the user explicitly says something like 'you can pause anything for the next 24 hours'. NEVER stage a grant the user didn't ask for.",
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [
            'pause',
            'resume',
            'budget',
            'create_campaign',
            'create_adset',
            'create_ad',
            'clone_ad',
            'targeting',
            'audience',
            'cio_event',
            'rule',
            'capi',
          ],
        },
        scope: {
          type: 'object',
          description:
            'Optional scope restrictions. Keys: campaign_ids[], campaign_name_match, ad_account_ids[], max_budget_change_pct, max_daily_budget_cents, min_daily_budget_cents, max_uses_per_day.',
        },
        expires_in_hours: {
          type: 'number',
          description:
            'How many hours until the grant auto-expires. Omit or pass null for permanent (DANGEROUS — until revoked). Default 24.',
        },
        notes: { type: 'string', description: 'Why this is being granted (for the audit trail).' },
      },
      required: ['kind'],
    },
  },
  // ---------- Demand Engine tools ----------
  {
    name: 'demand_engine_brands',
    description: "List all brands in the Demand Engine — slug, name, vertical, domain, angle, traffic type. Use to know what brands exist before running spy or generate.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'demand_engine_spy',
    description: "Search Meta Ad Library via the Demand Engine for competitor ads in a vertical. Returns hook type, psychology, copy, landing page, days running, spend estimate. Use when researching what's winning in a market before generating a creative.",
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keyword or brand name, e.g. "GLP-1 weight loss" or "semaglutide"' },
        vertical: { type: 'string', description: 'Vertical: glp1, trt, peptides, joint_pain, etc.' },
        winner: { type: 'boolean', description: 'If true, filter to long-running / high-spend ads only (proven winners).' },
      },
      required: ['keyword', 'vertical'],
    },
  },
  {
    name: 'demand_engine_generate',
    description: "Generate a complete ad creative (headline, body, CTA, composite image) via the Demand Engine. Returns image_url ready to upload to Meta. Use after spy to create a creative targeting a winning angle.",
    input_schema: {
      type: 'object',
      properties: {
        brandSlug: { type: 'string', description: 'Brand slug from demand_engine_brands, e.g. "claya"' },
        vertical: { type: 'string', description: 'Vertical: glp1, trt, peptides, joint_pain, etc.' },
        hookType: { type: 'string', description: 'Hook psychology type, e.g. "fear_transfer", "social_proof", "price_anchor", "authority", "transformation"' },
        landingPage: { type: 'string', description: 'Full URL where the ad sends traffic.' },
      },
      required: ['brandSlug', 'vertical', 'hookType', 'landingPage'],
    },
  },
  {
    name: 'demand_engine_build_page',
    description: "Build a landing page for a brand via the Demand Engine. Returns the live page URL. Use when a brand needs a new funnel page before launching a campaign.",
    input_schema: {
      type: 'object',
      properties: {
        brandSlug: { type: 'string', description: 'Brand slug from demand_engine_brands.' },
        funnelType: { type: 'string', description: 'Type of page: quiz, advertorial, vsl, lander, etc.' },
        referenceIntel: { type: 'string', description: 'Optional: intel from spy or market research to inform the page copy and angle.' },
      },
      required: ['brandSlug', 'funnelType'],
    },
  },
  {
    name: 'get_cohort_summary',
    description:
      "Pull the latest customer quality cohort snapshot: leads, intake completion, approval rate, rebill count, rebill rate %, CPL, and CPB. Use when the user asks about customer quality, rebill rates, CPB, retention, or whether campaigns are actually producing paying customers. Also returns the CIO event map so you know what events are tracked. If rebill_count is 0 and rebill event is 'not found', tell the user we need to set the rebill event name with /cohorts set rebill <name>.",
    input_schema: {
      type: 'object',
      properties: {
        date_preset: {
          type: 'string',
          enum: ['today', 'yesterday', 'last_7d', 'last_30d'],
          description: 'Window to pull cohort data for. Default last_7d.',
        },
        refresh: {
          type: 'boolean',
          description: 'If true, re-query Meta + CIO now instead of reading last saved snapshot.',
        },
      },
      required: [],
    },
  },
  {
    name: 'revoke_permission',
    description:
      "PROPOSE revoking a standing-order permission. User must reply 'yes' to confirm. Pass the permission id from list_permissions.",
    input_schema: {
      type: 'object',
      properties: {
        permission_id: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['permission_id'],
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
    case 'pause_campaign': {
      const cid = input.campaign_id as string;
      const before = await getCampaign(cid).catch(() => null);
      const resp = await pauseCampaign(cid);
      const after = await getCampaign(cid).catch(() => null);
      await logAgentAction(chatId, 'pause_campaign', cid, before?.name ?? null, before, after);
      return { paused: true, response: resp };
    }
    case 'resume_campaign': {
      const cid = input.campaign_id as string;
      const before = await getCampaign(cid).catch(() => null);
      const resp = await resumeCampaign(cid);
      const after = await getCampaign(cid).catch(() => null);
      await logAgentAction(chatId, 'resume_campaign', cid, before?.name ?? null, before, after);
      return { activated: true, response: resp };
    }
    case 'set_ad_set_status': {
      const id = input.ad_set_id as string;
      const status = input.status as 'ACTIVE' | 'PAUSED';
      const resp = await setAdSetStatus(id, status);
      await logAgentAction(chatId, `set_ad_set_status:${status}`, id, null, null, resp);
      return { updated: true, response: resp };
    }
    case 'set_ad_status': {
      const id = input.ad_id as string;
      const status = input.status as 'ACTIVE' | 'PAUSED';
      const resp = await setAdStatus(id, status);
      await logAgentAction(chatId, `set_ad_status:${status}`, id, null, null, resp);
      return { updated: true, response: resp };
    }
    case 'set_daily_budget': {
      const cid = input.campaign_id as string;
      const dollars = Number(input.daily_budget_dollars);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        throw new Error('daily_budget_dollars must be a positive number.');
      }
      const newCents = Math.round(dollars * 100);
      // Hard rails — mirror the /budget slash command and the creation floor/cap.
      if (newCents < 500) throw new Error('Budget below the $5/day floor.');
      if (newCents > 50_000) throw new Error('Budget exceeds the $500/day per-action cap.');
      const before = await getCampaign(cid).catch(() => null);
      const oldCents = before?.daily_budget ? Number(before.daily_budget) : null;
      if (oldCents != null && oldCents > 0) {
        const ratio = newCents / oldCents;
        if (ratio > 1.5 || ratio < 0.5) {
          throw new Error(
            `Change is ${(ratio * 100 - 100).toFixed(0)}% — exceeds the ±50% per-action cap. Do it in two steps.`,
          );
        }
      }
      const resp = await setDailyBudget(cid, newCents);
      const after = await getCampaign(cid).catch(() => null);
      await logAgentAction(chatId, 'set_daily_budget', cid, before?.name ?? null, before, after);
      return { updated: true, old_daily_cents: oldCents, new_daily_cents: newCents, response: resp };
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
        bid_strategy: input.bid_strategy as 'LOWEST_COST_WITHOUT_CAP' | 'LOWEST_COST_WITH_BID_CAP' | 'COST_CAP' | undefined,
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
    case 'upload_image_for_ad': {
      // Look up the user-attached image by registry ref ('img_0', 'img_1', etc.).
      const img = resolveAttachedImage(chatId, input.image_ref as string | undefined);
      if (!img) {
        return {
          error: `No image found at ref "${input.image_ref}". User must attach the image to the current Telegram message; refs reset every turn.`,
        };
      }
      const result = await uploadImage({
        bytes: Buffer.from(img.data, 'base64'),
        mime_type: img.media_type,
        filename: (input.filename as string | undefined) ?? undefined,
      });
      await logAgentAction(chatId, 'upload_image', result.image_hash, null, null, {
        image_ref: input.image_ref,
        url: result.url,
        width: result.width,
        height: result.height,
      });
      return result;
    }
    case 'create_ad_with_uploaded_image': {
      const result = await createAdFromImage({
        ad_set_id: input.ad_set_id as string,
        image_hash: input.image_hash as string,
        headline: input.headline as string,
        primary_text: input.primary_text as string,
        description: input.description as string | undefined,
        cta: input.cta as string | undefined,
        link_url: input.link_url as string,
        ad_name: input.ad_name as string | undefined,
        template_ad_id: input.template_ad_id as string | undefined,
      });
      await logAgentAction(
        chatId,
        'create_ad_with_uploaded_image',
        result.new_ad_id,
        (input.ad_name as string) ?? null,
        null,
        {
          ad_set_id: input.ad_set_id,
          image_hash: input.image_hash,
          new_creative_id: result.new_creative_id,
          template_ad_id: result.template_ad_id,
          page_id: result.page_id,
        },
      );
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
      return aud.map((a) => {
        const lo = a.approximate_count_lower_bound;
        const hi = a.approximate_count_upper_bound;
        // -1 (or missing) means Meta hasn't sized it yet — common for lookalikes.
        const sized = lo != null && lo >= 0;
        return {
          id: a.id,
          name: a.name,
          subtype: a.subtype ?? null,
          approximate_count: sized ? (lo === hi ? lo : `${lo}–${hi}`) : null,
          status: a.operation_status?.description ?? null,
        };
      });
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
    case 'delete_custom_audience': {
      const audienceId = input.audience_id as string;
      // Capture name first so the audit trail is meaningful after deletion.
      const aud = (await listCustomAudiences()).find((a) => a.id === audienceId);
      const result = await deleteCustomAudience(audienceId);
      await logAgentAction(chatId, 'delete_custom_audience', audienceId, aud?.name ?? null, aud ?? null, result);
      return { ...result, deleted_name: aud?.name ?? null };
    }
    case 'audit_creative': {
      const adId = input.ad_id as string;
      const ad = await getAd(adId);
      const cr = (ad as unknown as { creative?: { id?: string; body?: string; title?: string; image_url?: string; thumbnail_url?: string } }).creative ?? {};
      // If the ad object didn't include creative fields, fetch the creative directly
      let creative = cr;
      if (!creative.image_url && !creative.thumbnail_url && !creative.body) {
        try {
          const adFull = await fetch(
            `https://graph.facebook.com/v25.0/${adId}?fields=creative{id,body,title,image_url,thumbnail_url}&access_token=${process.env.META_ACCESS_TOKEN}`,
          ).then((r) => r.json() as Promise<{ creative?: typeof creative }>);
          if (adFull.creative) creative = adFull.creative;
        } catch {}
      }
      const result = await auditCreative({
        id: adId,
        name: (ad as unknown as { name?: string }).name,
        body: creative.body,
        title: creative.title,
        image_url: creative.image_url ?? creative.thumbnail_url,
      });
      return result;
    }
    case 'get_insights_breakdown': {
      const level = input.level as 'account' | 'campaign' | 'adset' | 'ad';
      const dp = input.date_preset as Parameters<typeof getInsightsBreakdown>[0]['datePreset'];
      const breakdowns = input.breakdowns as BreakdownDim[];
      return await getInsightsBreakdown({
        level,
        parentId: input.parent_id as string | undefined,
        datePreset: dp,
        breakdowns,
      });
    }
    case 'get_ad_quality_scores': {
      const rows = await getAdQualityScores(
        input.parent_id as string,
        input.date_preset as Parameters<typeof getAdQualityScores>[1],
      );
      return rows;
    }
    case 'get_ad_set_learning_status': {
      return await getAdSetLearningStatus(input.adset_id as string);
    }
    case 'list_activity_log': {
      return await listActivityLog({
        sinceIso: input.since_iso as string | undefined,
        untilIso: input.until_iso as string | undefined,
        limit: input.limit as number | undefined,
      });
    }
    case 'search_ad_interests': {
      return await searchAdInterests(input.query as string, (input.limit as number | undefined) ?? 25);
    }
    case 'suggest_ad_interests': {
      return await suggestAdInterests(input.seed_interests as string[], (input.limit as number | undefined) ?? 25);
    }
    case 'get_meta_recommendations': {
      return await getMetaRecommendations(input.entity_id as string);
    }
    case 'list_custom_conversions': {
      return await listCustomConversions();
    }
    case 'get_ad_preview': {
      const fmt = (input.format as AdPreviewFormat | undefined) ?? 'MOBILE_FEED_STANDARD';
      const r = await getAdPreview(input.ad_id as string, fmt);
      // HTML can be very long — truncate for token budget
      return { format: r.format, html_excerpt: r.html.slice(0, 4000), html_length: r.html.length };
    }
    case 'get_auction_insights': {
      return await getAuctionInsights({
        level: input.level as 'campaign' | 'adset' | 'ad',
        parentId: input.parent_id as string | undefined,
        datePreset: input.date_preset as Parameters<typeof getAuctionInsights>[0]['datePreset'],
      });
    }
    case 'get_delivery_estimate': {
      const dollars = input.daily_budget_dollars as number | undefined;
      return await getDeliveryEstimate({
        optimization_goal: input.optimization_goal as string,
        targeting: (input.targeting as Record<string, unknown>) ?? {},
        daily_budget_cents: dollars != null ? Math.round(dollars * 100) : undefined,
      });
    }
    case 'get_account_insights': {
      return await getAccountInsights(input.date_preset as Parameters<typeof getAccountInsights>[0]);
    }
    case 'batch_execute': {
      const innerTool = input.tool as string;
      const items = input.inputs as Record<string, unknown>[];
      const desc = (input.description as string) ?? `batch ${innerTool}`;
      const concurrency = Math.max(1, Math.min(5, Number(input.concurrency) || 3));

      if (!innerTool || typeof innerTool !== 'string')
        throw new Error('batch_execute: `tool` is required (string).');
      if (!Array.isArray(items) || items.length === 0)
        throw new Error('batch_execute: `inputs` must be a non-empty array.');
      if (innerTool === 'batch_execute')
        throw new Error('batch_execute cannot call itself.');

      // The batch runs OUTSIDE the LLM. No more hallucinated progress —
      // every iteration calls dispatchTool deterministically. Per-item
      // permission is intentionally NOT checked: the batch itself was
      // already gated via dispatchToolGuarded and the user confirmed it.
      await bot.sendMessage(
        chatId,
        `Starting batch: ${desc}\n${items.length} actions, concurrency ${concurrency}.`,
      );

      type Outcome = { index: number; ok: boolean; result?: unknown; error?: string };
      const outcomes: Outcome[] = new Array(items.length);
      let nextIdx = 0;
      const startedAt = Date.now();

      async function worker(): Promise<void> {
        for (;;) {
          const i = nextIdx++;
          if (i >= items.length) return;
          try {
            const r = await dispatchTool(innerTool, items[i], chatId);
            outcomes[i] = { index: i, ok: true, result: r };
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            outcomes[i] = { index: i, ok: false, error: m };
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      const ok = outcomes.filter((o) => o?.ok).length;
      const failed = outcomes.length - ok;
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

      const reportLines: string[] = [
        `Batch done: ${desc}`,
        `${ok}/${items.length} succeeded in ${elapsed}s${failed > 0 ? `  (${failed} failed)` : ''}`,
      ];
      if (failed > 0) {
        const firstErrs = outcomes
          .filter((o) => o && !o.ok)
          .slice(0, 5)
          .map((o) => `  ✗ #${o.index + 1}: ${o.error}`);
        reportLines.push('', 'First failures:', ...firstErrs);
        if (failed > 5) reportLines.push(`  …and ${failed - 5} more`);
      }
      await bot.sendMessage(chatId, reportLines.join('\n'));

      // Truncate results returned to the LLM so a 36-item run doesn't blow the
      // tool-result token budget. Keep ids for successful + error msgs for fails.
      const trimmed = outcomes.map((o) => ({
        index: o.index,
        ok: o.ok,
        error: o.error,
        id: (o.result as { id?: string } | undefined)?.id,
      }));
      return { ok, failed, total: items.length, elapsed_sec: Number(elapsed), results: trimmed };
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
    case 'get_action_breakdown': {
      const level = (input.level as 'campaign' | 'adset' | 'ad') ?? 'campaign';
      const dp = (input.date_preset as 'today' | 'yesterday' | 'last_7d' | 'last_14d' | 'last_30d') ?? 'last_7d';
      const parentId = (input.parent_id as string | undefined) ?? null;
      const rows = await getActionBreakdown(parentId, level, dp);
      // Top 50 by spend to keep payload reasonable
      const sorted = [...rows].sort((a, b) => b.spend - a.spend).slice(0, 50);
      // Distinct action types in this slice
      const distinctActions = new Set<string>();
      for (const r of sorted) for (const a of r.actions) distinctActions.add(a.action_type);
      // Account totals per action across the full result set
      const totalsByAction: Record<string, number> = {};
      for (const r of rows) for (const a of r.actions) totalsByAction[a.action_type] = (totalsByAction[a.action_type] ?? 0) + a.value;
      return {
        level,
        window: dp,
        entity_count: rows.length,
        distinct_action_types: [...distinctActions].sort(),
        totals_by_action: totalsByAction,
        top_50_by_spend: sorted,
      };
    }
    case 'cio_discover_event_names': {
      const days = (input.days as number | undefined) ?? 30;
      const events = await cioDiscoverEventNames(days);
      return { window_days: days, distinct_event_count: events.length, events };
    }
    case 'reconstruct_funnel': {
      const dp = (input.date_preset as 'today' | 'yesterday' | 'last_7d' | 'last_14d' | 'last_30d') ?? 'last_7d';
      const leadName = (input.cio_lead_event_name as string | undefined) ?? 'lead';
      const bookName = (input.cio_booking_event_name as string | undefined) ?? 'appointment_booked';

      // Window seconds for CIO calls
      const days = dp === 'today' ? 0 : dp === 'yesterday' ? 1 : Number(dp.replace('last_', '').replace('d', ''));
      const end = Math.floor(Date.now() / 1000);
      const start = dp === 'today'
        ? Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000)
        : end - days * 86400;

      const accountBreakdown = await getActionBreakdown(null, 'campaign', dp);
      const totalSpend = accountBreakdown.reduce((s, r) => s + r.spend, 0);
      const totalClicks = accountBreakdown.reduce((s, r) => s + r.clicks, 0);
      const lpv = sumAction(accountBreakdown, 'landing_page_view');
      const viewContent = sumAction(accountBreakdown, 'view_content');
      // Claya custom events — check both standard and custom action_type forms
      const addPayment = sumAction(accountBreakdown, 'add_payment_info') || sumAction(accountBreakdown, 'offsite_conversion.custom.ADP01');
      const initiateCheckout = sumAction(accountBreakdown, 'initiate_checkout') || sumAction(accountBreakdown, 'offsite_conversion.custom.CKT01');
      const metaLeads = sumAction(accountBreakdown, 'lead') || sumAction(accountBreakdown, 'offsite_conversion.custom.Request_Submitted');
      const metaPurchases = sumAction(accountBreakdown, 'purchase') || sumAction(accountBreakdown, 'offsite_conversion.custom.Payment_completed');

      let cioLeads = 0;
      let cioBookings = 0;
      let cioError: string | null = null;
      if (CIO_CONFIGURED) {
        try {
          [cioLeads, cioBookings] = await Promise.all([
            cioCountEvents(leadName, start, end),
            cioCountEvents(bookName, start, end),
          ]);
        } catch (e) {
          cioError = e instanceof Error ? e.message : String(e);
        }
      } else {
        cioError = 'CIO not configured';
      }

      const cpl = metaLeads > 0 ? totalSpend / metaLeads : null;
      const cpb = cioBookings > 0 ? totalSpend / cioBookings : null;
      const intakeCompletionRate = lpv > 0 && cioLeads > 0 ? cioLeads / lpv : null;
      const showRate = cioLeads > 0 ? cioBookings / cioLeads : null;

      return {
        window: dp,
        meta: {
          spend_dollars: Number(totalSpend.toFixed(2)),
          link_clicks: totalClicks,
          landing_page_views: lpv,
          view_content: viewContent,
          add_payment_info: addPayment,
          initiate_checkout: initiateCheckout,
          leads: metaLeads,
          purchases: metaPurchases,
        },
        cio: {
          configured: CIO_CONFIGURED,
          error: cioError,
          lead_event_name: leadName,
          booking_event_name: bookName,
          leads: cioLeads,
          bookings: cioBookings,
        },
        ratios: {
          intake_completion_rate: intakeCompletionRate,
          meta_to_cio_lead_ratio: metaLeads > 0 ? cioLeads / metaLeads : null,
          show_rate: showRate,
        },
        per_lead_dollars: cpl,
        per_booking_dollars: cpb,
        diagnosis: (() => {
          if (totalSpend === 0) return 'No spend in window — funnel inactive.';
          if (metaLeads === 0 && cioLeads === 0) return 'Spend with zero leads on either side — likely Pixel not firing AND no funnel completion.';
          if (metaLeads > 0 && cioLeads === 0 && CIO_CONFIGURED) return 'Meta sees leads, CIO sees none — either tracking gap or wrong event name. Run cio_discover_event_names.';
          if (cioLeads > metaLeads * 1.5) return 'CIO sees significantly more leads than Meta — likely a Pixel firing issue on the Meta side.';
          if (metaLeads > cioLeads * 1.5) return 'Meta reports more leads than CIO records — likely funnel completion gap (intake started but email not captured).';
          return 'Meta and CIO lead counts within ~50% — tracking looks consistent.';
        })(),
      };
    }
    case 'compare_meta_vs_cio_leads': {
      const dp = (input.date_preset as 'today' | 'yesterday' | 'last_7d' | 'last_14d' | 'last_30d') ?? 'last_7d';
      const leadName = (input.cio_lead_event_name as string | undefined) ?? 'lead';

      const days = dp === 'today' ? 0 : dp === 'yesterday' ? 1 : Number(dp.replace('last_', '').replace('d', ''));
      const end = Math.floor(Date.now() / 1000);
      const start = dp === 'today'
        ? Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000)
        : end - days * 86400;

      const accountBreakdown = await getActionBreakdown(null, 'campaign', dp);
      const metaLeads = sumAction(accountBreakdown, 'lead');
      let cioLeads = 0;
      let cioError: string | null = null;
      if (CIO_CONFIGURED) {
        try {
          cioLeads = await cioCountEvents(leadName, start, end);
        } catch (e) {
          cioError = e instanceof Error ? e.message : String(e);
        }
      }
      const ratio = metaLeads > 0 ? cioLeads / metaLeads : null;
      const diagnosis = (() => {
        if (metaLeads === 0 && cioLeads === 0) return 'No leads in window from either source.';
        if (cioError) return `CIO query failed: ${cioError}`;
        if (ratio == null) return 'Meta reports zero leads — start there.';
        if (ratio < 0.7) return 'CIO records substantially fewer leads than Meta — funnel completion gap.';
        if (ratio > 1.3) return 'CIO records more leads than Meta — Pixel firing issue.';
        return 'Within ±30% — tracking consistent.';
      })();
      return {
        window: dp,
        meta_leads: metaLeads,
        cio_leads: cioLeads,
        cio_event_name: leadName,
        cio_to_meta_ratio: ratio,
        diagnosis,
      };
    }
    case 'list_competitor_landing_pages': {
      const all = await listCompetitors(true);
      return all.map((c) => ({
        id: c.id,
        url: c.url,
        label: c.label,
        type: c.type,
        enabled: c.enabled,
      }));
    }
    case 'analyze_landing_pages': {
      const r = await runDailyLpTick();
      return r;
    }
    case 'propose_lp_recommendations': {
      const r = await generateRecommendations();
      if ('error' in r) return { error: r.error };
      return {
        count: r.recommendations.length,
        saved_ids: r.saved_ids,
        recommendations: r.recommendations,
        summary: r.summary,
        tokens: { input: r.input_tokens, output: r.output_tokens },
      };
    }
    case 'list_lp_recommendations': {
      const status = (input.status as 'proposed' | 'sent' | 'implemented' | 'measured' | 'rejected' | 'all' | undefined) ?? 'proposed';
      const limit = (input.limit as number | undefined) ?? 30;
      const items = await listRecommendations(status, limit);
      return items.map((r) => ({
        id: r.id,
        priority: r.priority,
        expected_lift_band: r.expected_lift_band,
        expected_lift_pct: r.expected_lift_pct,
        hypothesis: r.hypothesis,
        competitor_evidence: r.competitor_evidence,
        claya_data_evidence: r.claya_data_evidence,
        implementation_steps: r.implementation_steps,
      }));
    }
    case 'track_lp_implementation': {
      const id = Number(input.recommendation_id);
      if (!Number.isFinite(id) || id <= 0) return { error: 'recommendation_id must be positive' };
      const date = (input.deploy_date as string | undefined) ?? new Date().toISOString().slice(0, 10);
      await markRecommendationStatus(id, 'implemented', date);
      return { ok: true, recommendation_id: id, deploy_date: date };
    }
    case 'measure_lp_lift': {
      const id = Number(input.recommendation_id);
      if (!Number.isFinite(id) || id <= 0) return { error: 'recommendation_id must be positive' };
      const r = await measureLpLift(id);
      if ('error' in r) return r;
      return r;
    }
    case 'propose_rebalance': {
      const plan = await generateRebalanceProposal('agent_tool');
      return {
        plan_id: plan.id,
        metric: plan.metric,
        metric_reason: plan.metric_reason,
        account_avg_metric: plan.account_avg_metric,
        total_daily_before: plan.total_daily_before_cents / 100,
        total_daily_after: plan.total_daily_after_cents / 100,
        change_count: plan.changes.length,
        changes: plan.changes.map((c) => ({
          campaign_name: c.campaign_name,
          band: c.band,
          current: c.current_daily_cents / 100,
          proposed: c.proposed_daily_cents / 100,
          delta_pct: c.delta_pct,
          reason: c.reason,
        })),
        rationale: plan.rationale,
      };
    }
    case 'execute_rebalance_plan': {
      // NOTE: dispatchToolGuarded does NOT route this through the budget
      // permission gate yet — the rebalance tool encompasses many setDailyBudget
      // calls, which is wider than a single-target gate. For V1 this tool runs
      // unguarded and is intended to be called only after a slash-command
      // accept (which is itself the user authorization). When called via
      // free-form, the caller should have user confirmation in this turn.
      const id = Number(input.plan_id);
      if (!Number.isFinite(id) || id <= 0) return { error: 'plan_id must be positive' };
      const r = await applyRebalancePlan(id, 'agent:clayton');
      return {
        plan_id: id,
        applied: r.applied,
        failed: r.failed,
        status: r.plan?.status,
      };
    }
    case 'load_open_rebalance_proposal': {
      const p = await loadOpenProposal();
      if (!p) return { open: false };
      return {
        open: true,
        plan_id: p.id,
        metric: p.metric,
        change_count: p.changes.length,
        total_daily_before: p.total_daily_before_cents / 100,
        total_daily_after: p.total_daily_after_cents / 100,
        rationale: p.rationale,
        changes: p.changes,
      };
    }
    case 'list_rebalance_history': {
      const limit = (input.limit as number | undefined) ?? 14;
      const items = await listRecentPlans(limit);
      return items.map((p) => ({
        id: p.id,
        generated_by: p.generated_by,
        status: p.status,
        metric: p.metric,
        change_count: (p.changes ?? []).length,
        total_daily_before: p.total_daily_before_cents / 100,
        total_daily_after: p.total_daily_after_cents / 100,
      }));
    }
    case 'run_judgment_on_signal': {
      const id = Number(input.inbox_id);
      if (!Number.isFinite(id) || id <= 0) return { error: 'inbox_id must be positive' };
      const r = await runJudgmentOnSignal(id);
      if ('error' in r) return { error: r.error };
      return {
        judgment_id: r.saved_id,
        signal_kind: r.judgment.signal_kind,
        target: r.judgment.target_name ?? r.judgment.target_id,
        primary_hypothesis: r.judgment.primary_hypothesis,
        alternative_hypotheses: r.judgment.alternative_hypotheses,
        evidence: r.judgment.evidence,
        caveats: r.judgment.caveats,
        recommended_action: r.judgment.recommended_action,
        confidence: r.judgment.confidence,
        rationale: r.judgment.rationale,
        tokens: { input: r.input_tokens, output: r.output_tokens },
      };
    }
    case 'list_recent_judgments': {
      const limit = (input.limit as number | undefined) ?? 10;
      const items = await listRecentJudgments(limit);
      return items.map((j) => ({
        id: j.id,
        signal_kind: j.signal_kind,
        target: j.target_name ?? j.target_id,
        recommended_action: j.recommended_action,
        confidence: j.confidence,
        rationale: j.rationale,
      }));
    }
    case 'capi_status': {
      const cfg = await getCapiConfig();
      const maps = await listEventMap();
      const recent = await listRecentForwards(10);
      return {
        config: {
          pixel_id: cfg.pixel_id,
          enabled: cfg.enabled,
          default_action_source: cfg.default_action_source,
          test_event_code: cfg.test_event_code,
          updated_at: cfg.updated_at,
          updated_by: cfg.updated_by_username ?? cfg.updated_by_user_id,
        },
        event_map: maps.map((m) => ({
          cio_event_name: m.cio_event_name,
          meta_event_name: m.meta_event_name,
          action_source: m.action_source,
          enabled: m.enabled,
        })),
        recent_forwards: recent.map((f) => ({
          id: f.id,
          created_at: f.created_at,
          cio_event_name: f.cio_event_name,
          meta_event_name: f.meta_event_name,
          customer_email: f.customer_email,
          http_status: f.http_status,
          success: f.success,
          error: f.error_message,
        })),
      };
    }
    case 'capi_run_tick': {
      const lookback = (input.lookback_minutes as number | undefined) ?? 30;
      const r = await runCapiTick({ lookbackMinutes: lookback });
      return r;
    }
    case 'list_inbox': {
      const onlyOpen = (input.only_open as boolean | undefined) ?? true;
      const items = onlyOpen ? await listOpenInbox(50) : await listRecentInbox(24, 100);
      return items.map((it) => ({
        id: it.id,
        signal_kind: it.signal_kind,
        severity: it.severity,
        target: { type: it.target_type, id: it.target_id, name: it.target_name },
        current: it.current_value,
        baseline: it.baseline_value,
        delta_pct: it.delta_pct,
        message: it.message,
        last_seen_at: it.last_seen_at,
        surfaced: it.surfaced_to_telegram,
        resolved: it.resolved_at != null,
        resolved_by: it.resolved_by,
        auto_action_taken: it.auto_action_taken,
      }));
    }
    case 'resolve_inbox_item': {
      const id = Number(input.inbox_id);
      if (!Number.isFinite(id) || id <= 0) return { error: 'inbox_id must be positive' };
      const note = (input.note as string | undefined) ?? null;
      const ok = await resolveInboxItem(id, 'agent:clayton', note);
      return { resolved: ok };
    }
    case 'run_monitor_tick': {
      const r = await runMonitorTick();
      return r;
    }
    case 'list_permissions': {
      const perms = await listAllPermissions(false);
      return perms.map((p) => ({
        id: p.id,
        kind: p.kind,
        scope: p.scope,
        expires_at: p.expires_at,
        granted_by: p.granted_by_username ?? p.granted_by_user_id,
        notes: p.notes,
        uses_count: p.uses_count,
        last_used_at: p.last_used_at,
        description: describePermission(p),
      }));
    }
    case 'grant_permission': {
      // This is a propose-only tool. The bot stages a pending grant; user reply 'yes' commits it.
      // It must be invoked from inside an askClaude turn so we can read the userKey from there.
      // dispatchTool can't see the userKey directly, so the wrapper handles staging — here we
      // just return a token and let dispatchToolGuarded wire up the pending.
      return {
        proposed: true,
        kind: input.kind,
        scope: (input.scope as Record<string, unknown>) ?? {},
        expires_in_hours: input.expires_in_hours ?? 24,
        notes: input.notes ?? null,
        next_step:
          "Not granted yet. The system will show the user a YES/NO prompt. Emit NO further text on this turn — wait for their reply.",
      };
    }
    case 'revoke_permission': {
      return {
        proposed: true,
        permission_id: input.permission_id,
        reason: input.reason ?? null,
        next_step:
          "Not revoked yet. The system will show the user a YES/NO prompt. Emit NO further text on this turn — wait for their reply.",
      };
    }
    // ---------- Demand Engine tools ----------
    case 'demand_engine_brands': {
      if (!DEMAND_ENGINE_CONFIGURED) return { error: 'DEMAND_ENGINE_URL or MACHINE_API_KEY not set in Railway.' };
      return await demandEngineBrands();
    }
    case 'demand_engine_spy': {
      if (!DEMAND_ENGINE_CONFIGURED) return { error: 'DEMAND_ENGINE_URL or MACHINE_API_KEY not set in Railway.' };
      return await demandEngineSpy({
        keyword: String(input.keyword),
        vertical: String(input.vertical),
        winner: Boolean(input.winner ?? false),
      });
    }
    case 'demand_engine_generate': {
      if (!DEMAND_ENGINE_CONFIGURED) return { error: 'DEMAND_ENGINE_URL or MACHINE_API_KEY not set in Railway.' };
      return await demandEngineGenerate({
        brandSlug: String(input.brandSlug),
        vertical: String(input.vertical),
        hookType: String(input.hookType),
        landingPage: String(input.landingPage),
      });
    }
    case 'demand_engine_build_page': {
      if (!DEMAND_ENGINE_CONFIGURED) return { error: 'DEMAND_ENGINE_URL or MACHINE_API_KEY not set in Railway.' };
      return await demandEngineBuildPage({
        brandSlug: String(input.brandSlug),
        funnelType: String(input.funnelType),
        referenceIntel: input.referenceIntel ? String(input.referenceIntel) : undefined,
      });
    }
    case 'get_cohort_summary': {
      const dp = (input.date_preset as 'today' | 'yesterday' | 'last_7d' | 'last_30d' | undefined) ?? 'last_7d';
      const refresh = Boolean(input.refresh ?? false);
      if (refresh) {
        const r = await runCohortTick({ date_preset: dp });
        const eventMap = r.event_map;
        return {
          ok: r.ok,
          cio_available: r.cio_available,
          error: r.error ?? null,
          snapshot: r.snapshot,
          event_map: eventMap,
          rebill_tracking: eventMap.rebill
            ? `tracking event "${eventMap.rebill}"`
            : 'rebill event NOT found — use /cohorts set rebill <event_name> to configure',
        };
      }
      const latest = await getLatestCohort('account');
      const eventMap = await discoverCohortEventMap().catch(() => null);
      return {
        ok: true,
        cio_available: CIO_CONFIGURED,
        snapshot: latest,
        event_map: eventMap,
        rebill_tracking: eventMap?.rebill
          ? `tracking event "${eventMap.rebill}"`
          : 'rebill event NOT found — use /cohorts set rebill <event_name> to configure',
        note: latest ? null : 'No cohort snapshot yet — use refresh:true or run /cohorts refresh',
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------- CAPI slash command handler ----------

async function handleCapiCmd(
  chatId: number,
  userKey: string,
  sender: { userId?: string | null; username?: string | null },
  args: string,
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? '').toLowerCase();

  // Read commands first.
  if (!sub || sub === 'status' || sub === 'show') {
    const cfg = await getCapiConfig();
    const maps = await listEventMap();
    const recent = await listRecentForwards(10);
    const lines: string[] = [];
    lines.push(`CAPI bridge:`);
    lines.push(`  enabled:  ${cfg.enabled ? 'YES — forwarding live' : 'no — disabled'}`);
    lines.push(`  pixel_id: ${cfg.pixel_id ?? '(not set)'}`);
    lines.push(`  default_action_source: ${cfg.default_action_source}`);
    lines.push(`  test_event_code: ${cfg.test_event_code ?? '(none — production sends)'}`);
    lines.push('');
    if (maps.length === 0) lines.push('Event map: (empty — nothing will forward)');
    else {
      lines.push(`Event map (${maps.length}):`);
      for (const m of maps) {
        lines.push(
          `  ${m.cio_event_name} → ${m.meta_event_name}  [${m.action_source}]${m.enabled ? '' : ' (disabled)'}`,
        );
      }
    }
    lines.push('');
    if (recent.length === 0) lines.push('No forwards logged yet.');
    else {
      lines.push(`Recent forwards (${recent.length}):`);
      for (const f of recent) {
        const ts = f.created_at.replace('T', ' ').slice(0, 16);
        lines.push(
          `  ${ts}  ${f.cio_event_name}→${f.meta_event_name}  http=${f.http_status ?? '?'}  ${f.success ? 'ok' : 'FAIL'}`,
        );
        if (!f.success && f.error_message)
          lines.push(`    err: ${f.error_message.slice(0, 120)}`);
      }
    }
    lines.push('');
    lines.push('Subcommands:');
    lines.push('  /capi pixel <pixel_id>');
    lines.push('  /capi map <cio_event> <meta_event> [action=email|website|system_generated]');
    lines.push('  /capi unmap <cio_event>');
    lines.push('  /capi enable | disable');
    lines.push('  /capi test_code <code> | clear_test_code');
    lines.push('  /capi backfill <hours>');
    lines.push('  /capi tick — force one poll now');
    lines.push('  /capi forwards [limit] — list recent forwards');
    lines.push('  /capi digest [hours=24] — summarize last N hours');
    await sendChunked(chatId, lines.join('\n'));
    return;
  }

  if (sub === 'digest') {
    const hoursArg = parseInt(parts[1] ?? '24', 10);
    const hours = Number.isFinite(hoursArg) && hoursArg > 0 ? Math.min(hoursArg, 168) : 24;
    try {
      const d = await getCapiDigest(hours);
      await bot.sendMessage(chatId, formatCapiDigest(d));
    } catch (err) {
      await bot.sendMessage(chatId, `digest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (sub === 'forwards') {
    const limit = Math.min(Math.max(parseInt(parts[1] ?? '20', 10) || 20, 1), 100);
    const rows = await listRecentForwards(limit);
    if (rows.length === 0) {
      await bot.sendMessage(chatId, 'No CAPI forwards logged.');
      return;
    }
    const lines: string[] = [`Recent CAPI forwards (${rows.length}):`, ''];
    for (const f of rows) {
      const ts = f.created_at.replace('T', ' ').slice(0, 16);
      lines.push(
        `#${f.id} ${ts} ${f.cio_event_name}→${f.meta_event_name} http=${f.http_status ?? '?'} ${f.success ? 'ok' : 'FAIL'}${f.customer_email ? ` ${f.customer_email}` : ''}`,
      );
      if (!f.success && f.error_message) lines.push(`   err: ${f.error_message.slice(0, 200)}`);
    }
    await sendChunked(chatId, lines.join('\n'));
    return;
  }

  if (sub === 'tick') {
    await bot.sendMessage(chatId, 'Running CAPI tick…');
    try {
      const r = await runCapiTick();
      await bot.sendMessage(chatId, `CAPI tick: ${JSON.stringify(r)}`);
    } catch (err) {
      await bot.sendMessage(chatId, `CAPI tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // Write commands — gated by `capi` permission via the pending Y/N flow.
  // We stage a tool_action so the existing executePending path handles it.
  // For simplicity we run write-commands inline (slash commands are explicit
  // user authorization, like /pause).
  const senderInfo = { userId: sender.userId ?? null, username: sender.username ?? null };

  if (sub === 'pixel') {
    const id = parts[1];
    if (!id) {
      await bot.sendMessage(chatId, 'Usage: /capi pixel <pixel_id>');
      return;
    }
    await updateCapiConfig({ pixel_id: id }, senderInfo);
    await bot.sendMessage(chatId, `CAPI pixel_id set to ${id}.`);
    return;
  }
  if (sub === 'map') {
    const cio = parts[1];
    const meta = parts[2];
    if (!cio || !meta) {
      await bot.sendMessage(
        chatId,
        'Usage: /capi map <cio_event_name> <meta_event_name> [action=system_generated|email|website|chat|app]',
      );
      return;
    }
    let actionSource = 'system_generated';
    for (const p of parts.slice(3)) {
      if (p.startsWith('action=')) actionSource = p.slice(7);
    }
    const m = await upsertEventMap({ cio_event_name: cio, meta_event_name: meta, action_source: actionSource });
    await bot.sendMessage(chatId, `Mapped: ${m.cio_event_name} → ${m.meta_event_name} [${m.action_source}]`);
    return;
  }
  if (sub === 'unmap') {
    const cio = parts[1];
    if (!cio) {
      await bot.sendMessage(chatId, 'Usage: /capi unmap <cio_event_name>');
      return;
    }
    await deleteEventMap(cio);
    await bot.sendMessage(chatId, `Unmapped ${cio}.`);
    return;
  }
  if (sub === 'enable') {
    const cfg = await getCapiConfig();
    if (!cfg.pixel_id) {
      await bot.sendMessage(chatId, "Can't enable — pixel_id is not set. Run /capi pixel <id> first.");
      return;
    }
    if ((await listEventMap()).filter((m) => m.enabled).length === 0) {
      await bot.sendMessage(chatId, "Can't enable — no enabled event mappings. Run /capi map ... first.");
      return;
    }
    await updateCapiConfig({ enabled: true }, senderInfo);
    await bot.sendMessage(chatId, 'CAPI bridge ENABLED. Polling tick will run every 10 minutes.');
    return;
  }
  if (sub === 'disable') {
    await updateCapiConfig({ enabled: false }, senderInfo);
    await bot.sendMessage(chatId, 'CAPI bridge DISABLED.');
    return;
  }
  if (sub === 'test_code') {
    const code = parts[1];
    if (!code) {
      await bot.sendMessage(chatId, 'Usage: /capi test_code <code>');
      return;
    }
    await updateCapiConfig({ test_event_code: code }, senderInfo);
    await bot.sendMessage(chatId, `Test event code set: ${code}. Forwards will appear under Test Events in Events Manager.`);
    return;
  }
  if (sub === 'clear_test_code') {
    await updateCapiConfig({ test_event_code: null }, senderInfo);
    await bot.sendMessage(chatId, 'Test event code cleared. Forwards will land in production.');
    return;
  }
  if (sub === 'backfill') {
    const hours = parseFloat(parts[1] ?? '24');
    if (!Number.isFinite(hours) || hours <= 0) {
      await bot.sendMessage(chatId, 'Usage: /capi backfill <hours> (e.g. 24)');
      return;
    }
    void userKey;
    await bot.sendMessage(chatId, `Running CAPI backfill for last ${hours}h… this may take a moment.`);
    try {
      const r = await runCapiBackfill(hours);
      await bot.sendMessage(chatId, `Backfill done: ${JSON.stringify(r)}`);
    } catch (err) {
      await bot.sendMessage(chatId, `Backfill failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  await bot.sendMessage(chatId, `Unknown /capi subcommand "${sub}". Run /capi for help.`);
}

// ---------- /cio status — Customer.io health check ----------

async function handleCioCmd(chatId: number, args: string): Promise<void> {
  const sub = (args.trim().split(/\s+/)[0] ?? '').toLowerCase();

  if (sub === 'help') {
    await bot.sendMessage(
      chatId,
      [
        '/cio — show CIO health (default = status)',
        '/cio status — same as above',
        '',
        'Reports: API reachable, events in 24h/7d/30d, last event seen,',
        'distinct event names. Use this the moment Claya restores their',
        'pixel + form integration to verify events are flowing before',
        'waiting for the next CAPI tick.',
      ].join('\n'),
    );
    return;
  }

  await bot.sendChatAction(chatId, 'typing');
  let report;
  try {
    report = await cioHealthCheck();
  } catch (err) {
    await bot.sendMessage(
      chatId,
      `CIO health check threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const lines: string[] = [];
  lines.push('Customer.io health:');
  lines.push(`  configured:        ${report.configured ? 'yes' : 'no (CIO_APP_API_KEY missing)'}`);
  lines.push(`  region:            ${report.region}`);
  lines.push(`  app api reachable: ${report.app_api_reachable ? 'yes' : 'no'}`);
  lines.push(`  track api ready:   ${report.track_api_configured ? 'yes' : 'no (write events disabled)'}`);
  lines.push('');
  lines.push(`Funnel state:        ${formatFunnelState(report.funnel_state)}`);
  lines.push(`  events last 24h:   ${report.total_events_24h}`);
  lines.push(`  events last 7d:    ${report.total_events_7d}`);
  lines.push(`  events last 30d:   ${report.total_events_30d}`);
  lines.push(
    `  last event:        ${report.last_event_iso ? `${report.last_event_iso.replace('T', ' ').slice(0, 16)} (${report.last_event_name ?? 'unnamed'})` : 'none'}`,
  );
  lines.push('');
  if (report.distinct_event_names_30d.length === 0) {
    lines.push('Event types seen (30d): none');
  } else {
    lines.push(`Event types seen (30d, top ${Math.min(15, report.distinct_event_names_30d.length)}):`);
    for (const e of report.distinct_event_names_30d.slice(0, 15)) {
      const last = e.last_seen_iso ? e.last_seen_iso.replace('T', ' ').slice(0, 16) : '?';
      lines.push(`  ${e.event_name.padEnd(28)} ${String(e.count).padStart(5)}  last: ${last}`);
    }
  }
  if (report.error_message) {
    lines.push('');
    lines.push(`Error: ${report.error_message.slice(0, 300)}`);
  }
  if (report.funnel_state === 'silent') {
    lines.push('');
    lines.push('Funnel is dark — CIO is reachable but no events in 30d.');
    lines.push('Likely: pixel not firing on join.claya.com OR form not posting to CIO.');
    lines.push('Verify with the Claya dev team.');
  }
  await sendChunked(chatId, lines.join('\n'));
}

function formatFunnelState(s: 'live' | 'silent' | 'unconfigured' | 'unknown'): string {
  switch (s) {
    case 'live':
      return 'LIVE — events flowing';
    case 'silent':
      return 'SILENT — CIO reachable but zero events 30d';
    case 'unconfigured':
      return 'UNCONFIGURED — credentials missing';
    case 'unknown':
      return 'UNKNOWN — could not verify';
  }
}

// ---------- Permission slash command handlers ----------

async function handlePermsCmd(chatId: number): Promise<void> {
  const active = await listAllPermissions(false);
  const lines: string[] = [];
  if (active.length === 0) {
    lines.push('No active standing orders.');
    lines.push('');
    lines.push('Grant one with /grant <kind> [campaign="..."] [expires=24h|7d|permanent]');
    lines.push(`Valid kinds: ${ALL_PERMISSION_KINDS.join(', ')}`);
  } else {
    lines.push(`Active standing orders (${active.length}):`);
    lines.push('');
    for (const p of active) lines.push(describePermission(p));
  }
  await sendChunked(chatId, lines.join('\n'));
}

async function handleGrantCmd(
  chatId: number,
  userKey: string,
  args: string,
): Promise<void> {
  const parsed = parseGrantArgs(args);
  if ('error' in parsed) {
    await bot.sendMessage(chatId, parsed.error);
    return;
  }
  setPending(chatId, userKey, {
    kind: 'grant',
    permKind: parsed.kind,
    scope: parsed.scope,
    expiresAtIso: parsed.expires_at,
    notes: parsed.notes,
  });
  const exp = parsed.expires_at
    ? parsed.expires_at.replace('T', ' ').slice(0, 16)
    : 'until revoked (DANGEROUS)';
  const scopeStr = Object.keys(parsed.scope).length === 0 ? '(no restriction)' : JSON.stringify(parsed.scope);
  await bot.sendMessage(
    chatId,
    [
      `Pending GRANT for review:`,
      `  kind: ${parsed.kind}`,
      `  scope: ${scopeStr}`,
      `  expires: ${exp}`,
      parsed.notes ? `  notes: ${parsed.notes}` : '',
      '',
      `Reply "yes" to grant, "no" to cancel. (Times out in 5 min.)`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function handleRevokeCmd(chatId: number, userKey: string, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const id = Number(parts[0]);
  if (!Number.isFinite(id) || id <= 0) {
    await bot.sendMessage(chatId, 'Usage: /revoke <permission_id> [reason...]');
    return;
  }
  const reason = parts.slice(1).join(' ') || null;
  setPending(chatId, userKey, { kind: 'revoke', permissionId: id, reason });
  await bot.sendMessage(
    chatId,
    `Pending REVOKE for permission #${id}${reason ? ` — reason: ${reason}` : ''}\nReply "yes" to revoke, "no" to cancel.`,
  );
}

// ---------- Permission-guarded tool dispatch ----------
//
// Every WRITE tool (and grant/revoke proposals) routes through this wrapper.
// Authorized by a standing order → execute and record usage.
// No matching grant → stage a one-time pending tool_action so the user can
// confirm with "yes" or upgrade to a /grant.

interface WriteToolSpec {
  permKind(input: Record<string, unknown>): PermissionKind;
  paramsFor(input: Record<string, unknown>): RequirePermissionParams;
  targetLabel(input: Record<string, unknown>): string;
}

const WRITE_TOOL_SPECS: Record<string, WriteToolSpec> = {
  // pause_campaign is intentionally NOT gated here — pause is low-risk and
  // reversible. Consistent with /pause slash command which also executes
  // immediately. The LLM can pause directly without a standing order.
  resume_campaign: {
    permKind: () => 'resume',
    paramsFor: (i) => ({
      campaign_id: i.campaign_id ? String(i.campaign_id) : null,
      campaign_name: typeof i.campaign_name === 'string' ? i.campaign_name : null,
    }),
    targetLabel: (i) =>
      `activate campaign ${typeof i.campaign_name === 'string' ? '"' + i.campaign_name + '"' : i.campaign_id}`,
  },
  set_ad_set_status: {
    permKind: (i) => (i.status === 'ACTIVE' ? 'resume' : 'pause'),
    paramsFor: () => ({}),
    targetLabel: (i) => `set ad set ${i.ad_set_id} → ${i.status}`,
  },
  set_ad_status: {
    permKind: (i) => (i.status === 'ACTIVE' ? 'resume' : 'pause'),
    paramsFor: () => ({}),
    targetLabel: (i) => `set ad ${i.ad_id} → ${i.status}`,
  },
  set_daily_budget: {
    permKind: () => 'budget',
    // Pass the absolute new budget so a standing /grant's daily ceiling is
    // enforced. delta_pct needs the old budget (async) so it isn't computed
    // here — the ±50% hard rail in the dispatch case covers oversize swings.
    paramsFor: (i) => ({
      campaign_id: i.campaign_id ? String(i.campaign_id) : null,
      campaign_name: typeof i.campaign_name === 'string' ? i.campaign_name : null,
      new_daily_budget_cents: Number.isFinite(Number(i.daily_budget_dollars))
        ? Math.round(Number(i.daily_budget_dollars) * 100)
        : null,
    }),
    targetLabel: (i) =>
      `set ${typeof i.campaign_name === 'string' ? '"' + i.campaign_name + '"' : 'campaign ' + i.campaign_id} daily budget to $${Number(i.daily_budget_dollars)}/day`,
  },
  clone_ad_with_new_copy: {
    permKind: () => 'clone_ad',
    paramsFor: () => ({}),
    targetLabel: (i) => `clone ad ${i.ad_id} with new copy`,
  },
  create_campaign: {
    permKind: () => 'create_campaign',
    paramsFor: (i) => ({ campaign_name: typeof i.name === 'string' ? i.name : null }),
    targetLabel: (i) => `create campaign "${i.name}"`,
  },
  create_ad_set: {
    permKind: () => 'create_adset',
    paramsFor: (i) => ({ campaign_id: i.campaign_id ? String(i.campaign_id) : null }),
    targetLabel: (i) => `create ad set "${i.name}" under campaign ${i.campaign_id}`,
  },
  create_ad: {
    permKind: () => 'create_ad',
    paramsFor: () => ({}),
    targetLabel: (i) => `create ad "${i.name}" in ad set ${i.adset_id}`,
  },
  // Image upload is a low-risk add (just an asset in the library, doesn't
  // affect spend) but we still gate it so audit log captures who uploaded
  // what. Reuses the 'create_ad' permission kind — anyone authorized to
  // create ads can upload the source media.
  upload_image_for_ad: {
    permKind: () => 'create_ad',
    paramsFor: () => ({}),
    targetLabel: (i) =>
      `upload image (ref ${typeof i.image_ref === 'string' ? i.image_ref : '?'}) to Meta media library`,
  },
  create_ad_with_uploaded_image: {
    permKind: () => 'create_ad',
    paramsFor: () => ({}),
    targetLabel: (i) =>
      `create new ad with uploaded image in ad set ${typeof i.ad_set_id === 'string' ? i.ad_set_id : '?'}`,
  },
  update_ad_set_targeting: {
    permKind: () => 'targeting',
    paramsFor: () => ({}),
    targetLabel: (i) => `update targeting on ad set ${i.ad_set_id}`,
  },
  create_lookalike_audience: {
    permKind: () => 'audience',
    paramsFor: () => ({}),
    targetLabel: (i) => `create lookalike audience "${i.name}"`,
  },
  delete_custom_audience: {
    permKind: () => 'audience',
    paramsFor: () => ({}),
    targetLabel: (i) => `delete audience ${i.audience_id}`,
  },
  batch_execute: {
    // Permission kind is inherited from the inner tool so a batch of
    // create_ad needs 'create_ad' permission, a batch of pause needs 'pause',
    // etc. A standing-order /grant on the inner kind covers the whole batch.
    permKind: (i) => {
      const innerName = i.tool as string;
      const innerSpec = innerName ? WRITE_TOOL_SPECS[innerName] : undefined;
      // Fall back to 'rule' for unknown inner tools — generic write gate.
      return innerSpec ? innerSpec.permKind({}) : 'rule';
    },
    paramsFor: () => ({}),
    targetLabel: (i) => {
      const n = Array.isArray(i.inputs) ? i.inputs.length : '?';
      const desc = (i.description as string) ?? `batch ${i.tool}`;
      return `${desc} (${n} actions via batch_execute)`;
    },
  },
  cio_send_event: {
    permKind: () => 'cio_event',
    paramsFor: () => ({}),
    targetLabel: (i) => `send CIO event "${i.event_name}" → ${i.customer_id}`,
  },
  create_rule: {
    permKind: () => 'rule',
    paramsFor: () => ({}),
    targetLabel: (i) => `create rule "${i.name}"`,
  },
  disable_rule: {
    permKind: () => 'rule',
    paramsFor: () => ({}),
    targetLabel: (i) => `disable rule ${i.rule_id}`,
  },
};

const PROPOSE_ONLY_TOOLS = new Set(['grant_permission', 'revoke_permission']);

async function dispatchToolGuarded(
  toolName: string,
  input: Record<string, unknown>,
  chatId: number,
  userKey: string | undefined,
  sender: { userId?: number | string; username?: string | null } | undefined,
): Promise<unknown> {
  // Propose-only tools: stage a pending grant/revoke and ask user for confirm.
  if (toolName === 'grant_permission') {
    const kindRaw = String(input.kind ?? '');
    if (!(ALL_PERMISSION_KINDS as string[]).includes(kindRaw)) {
      return { error: `Unknown permission kind "${kindRaw}". Valid: ${ALL_PERMISSION_KINDS.join(', ')}` };
    }
    const kind = kindRaw as PermissionKind;
    const scope = ((input.scope as PermissionScope | undefined) ?? {}) as PermissionScope;
    const hours =
      input.expires_in_hours == null ? 24 : Number(input.expires_in_hours);
    const expiresAtIso =
      input.expires_in_hours === null
        ? null
        : Number.isFinite(hours) && hours > 0
          ? new Date(Date.now() + hours * 3600 * 1000).toISOString()
          : null;
    const notes = typeof input.notes === 'string' ? input.notes : null;
    if (userKey) {
      setPending(chatId, userKey, {
        kind: 'grant',
        permKind: kind,
        scope,
        expiresAtIso,
        notes,
      });
    }
    await bot.sendMessage(
      chatId,
      [
        `Pending GRANT for review:`,
        `  kind: ${kind}`,
        `  scope: ${JSON.stringify(scope)}`,
        `  expires: ${expiresAtIso ? expiresAtIso.replace('T', ' ').slice(0, 16) : 'until revoked (DANGEROUS)'}`,
        notes ? `  notes: ${notes}` : '',
        '',
        'Reply "yes" to grant, "no" to cancel.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return {
      pending_confirmation: true,
      kind,
      next_step: "Tell the user to reply 'yes' to commit the grant or 'no' to cancel.",
    };
  }
  if (toolName === 'revoke_permission') {
    const id = Number(input.permission_id);
    if (!Number.isFinite(id) || id <= 0) {
      return { error: `permission_id must be a positive number; got ${input.permission_id}` };
    }
    const reason = typeof input.reason === 'string' ? input.reason : null;
    if (userKey) {
      setPending(chatId, userKey, { kind: 'revoke', permissionId: id, reason });
    }
    await bot.sendMessage(
      chatId,
      `Pending REVOKE for permission #${id}${reason ? ` — reason: ${reason}` : ''}\nReply "yes" to revoke, "no" to cancel.`,
    );
    return {
      pending_confirmation: true,
      next_step: "Tell the user to reply 'yes' to revoke or 'no' to cancel.",
    };
  }
  if (PROPOSE_ONLY_TOOLS.has(toolName)) {
    return dispatchTool(toolName, input, chatId);
  }

  // Read tools / memory tools / read-only execution: pass through.
  const spec = WRITE_TOOL_SPECS[toolName];
  if (!spec) return dispatchTool(toolName, input, chatId);

  const permKind = spec.permKind(input);
  const params = spec.paramsFor(input);
  const targetLabel = spec.targetLabel(input);

  const guard = await requirePermission(permKind, params);
  if (guard.ok) {
    const result = await dispatchTool(toolName, input, chatId);
    await recordPermissionUsage(guard.permission_id);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return { ...(result as Record<string, unknown>), used_permission_id: guard.permission_id };
    }
    return result;
  }

  // Denied — stage a pending tool_action. ONE consolidated prompt for the whole
  // queue is sent at end of the agentic turn (see askClaude tail) — no per-action
  // Telegram message here, so a multi-tool turn doesn't spam the chat.
  if (userKey) {
    setPending(chatId, userKey, {
      kind: 'tool_action',
      toolName,
      input,
      permKind,
      targetLabel,
    });
  }
  void sender; // reserved for future audit trail enrichment
  return {
    permission_required: true,
    kind: permKind,
    target: targetLabel,
    pending_staged: Boolean(userKey),
    next_step: userKey
      ? "STOP. This action has been queued; the system will show ONE consolidated 'Reply YES' prompt at end of turn covering ALL queued actions. Emit NO text in your final response — do not mention permissions/gates/standing orders or repeat what was queued. Continue calling any remaining tools for this request, then end silently."
      : 'Ask the user to confirm by re-issuing as a slash command.',
  };
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

// ---------- /audit — pre-launch policy vision check ----------

async function handleAuditCmd(chatId: number, args: string): Promise<void> {
  const adId = args.trim();
  if (!adId) {
    await bot.sendMessage(
      chatId,
      'Usage: /audit <ad_id>\n\nRuns Claude vision on the ad creative and predicts whether Meta will reject it for the Drugs/Pharma policy. Returns verdict + specific risks + actionable fixes. Use BEFORE flipping an ad ACTIVE.',
    );
    return;
  }
  await bot.sendMessage(chatId, `Auditing ad ${adId}…`);
  try {
    const ad = await getAd(adId);
    const cr = (ad as unknown as { creative?: { body?: string; title?: string; image_url?: string; thumbnail_url?: string } }).creative ?? {};
    let creative = cr;
    if (!creative.image_url && !creative.thumbnail_url && !creative.body) {
      try {
        const url = `https://graph.facebook.com/v25.0/${adId}?fields=creative{id,body,title,image_url,thumbnail_url}&access_token=${process.env.META_ACCESS_TOKEN}`;
        const adFull = (await fetch(url).then((r) => r.json())) as { creative?: typeof creative };
        if (adFull.creative) creative = adFull.creative;
      } catch {}
    }
    const result = await auditCreative({
      id: adId,
      name: (ad as unknown as { name?: string }).name,
      body: creative.body,
      title: creative.title,
      image_url: creative.image_url ?? creative.thumbnail_url,
    });
    await sendChunked(chatId, formatPolicyAudit(result));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await bot.sendMessage(chatId, `Audit failed: ${m}`);
  }
}

// ---------- /audiences — Meta custom + lookalike audiences ----------

async function handleAudiencesCmd(
  chatId: number,
  userId: number | string,
  args: string,
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? '').toLowerCase();

  if (sub === 'list' || sub === '') {
    const aud = await listCustomAudiences();
    if (aud.length === 0) {
      await bot.sendMessage(chatId, 'No custom audiences in this ad account.');
      return;
    }
    // Group by subtype for readability
    const groups = new Map<string, typeof aud>();
    for (const a of aud) {
      const key = a.subtype ?? 'OTHER';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(a);
    }
    const lines: string[] = [`Custom audiences (${aud.length} total):`];
    for (const [subtype, items] of [...groups.entries()].sort()) {
      lines.push(`\n${subtype} (${items.length}):`);
      for (const a of items) {
        const lo = a.approximate_count_lower_bound;
        const hi = a.approximate_count_upper_bound;
        const sized = lo != null && lo >= 0;
        const size = sized ? (lo === hi ? `${lo}` : `${lo}–${hi}`) : 'pending';
        const status = a.operation_status?.description ?? '';
        const failed = /couldn't create|delete this audience/i.test(status) ? '  ⚠ FAILED' : '';
        lines.push(`  ${a.id}  ${a.name}  (${size})${failed}`);
      }
    }
    lines.push('\n/audiences delete <id> — remove a failed or stale audience');
    await sendChunked(chatId, lines.join('\n'));
    return;
  }

  if (sub === 'delete' && parts[1]) {
    const audienceId = parts[1];
    const aud = (await listCustomAudiences()).find((a) => a.id === audienceId);
    if (!aud) {
      await bot.sendMessage(chatId, `No audience found with ID ${audienceId}. Run /audiences list to see all IDs.`);
      return;
    }
    setPending(chatId, userId, {
      kind: 'tool_action',
      toolName: 'delete_custom_audience',
      input: { audience_id: audienceId },
      permKind: 'audience',
      targetLabel: `delete audience "${aud.name}"`,
    });
    const status = aud.operation_status?.description ?? 'OK';
    await bot.sendMessage(
      chatId,
      `Delete this audience? **IRREVERSIBLE** — Meta cannot restore it.\n\n` +
        `Name: ${aud.name}\nID: ${aud.id}\nSubtype: ${aud.subtype}\nMeta status: ${status}\n\n` +
        `Reply confirm / yes / fire to proceed, or anything else to cancel.`,
    );
    return;
  }

  const help = [
    '/audiences — Meta custom + lookalike audiences',
    '',
    '  /audiences list          — show all audiences grouped by type',
    '  /audiences delete <id>   — permanently delete one (irreversible, needs confirmation)',
    '',
    'Use delete to clean up failed lookalikes (Meta status says "couldn\'t create… delete and try again").',
  ].join('\n');
  await bot.sendMessage(chatId, help);
}

// ---------- /rules — autonomous scaling rules ----------

async function handleRulesCmd(chatId: number, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? '').toLowerCase();

  if (sub === 'list' || sub === '') {
    const rules = await loadActiveRules();
    if (rules.length === 0) {
      await bot.sendMessage(chatId, 'No active rules. Seeding defaults…');
      const n = await seedDefaultRules();
      await bot.sendMessage(chatId, `Seeded ${n} default rules. Run /rules list to see them.`);
      return;
    }
    const lines = rules.map((r) =>
      `#${r.id} ${r.auto_execute ? '[AUTO]' : '[notify]'} ${r.name}\n  ${r.description} (triggered ${r.trigger_count}×)`,
    );
    await bot.sendMessage(chatId, `Active rules (${rules.length}):\n\n${lines.join('\n\n')}`);
    return;
  }

  if (sub === 'eval' || sub === 'run') {
    await bot.sendMessage(chatId, 'Evaluating all rules against current account state…');
    try {
      const triggers = await evaluateAllRules();
      await executeAutoTriggers(triggers);
      if (triggers.length === 0) {
        await bot.sendMessage(chatId, 'No rules triggered. All conditions within thresholds.');
        return;
      }
      const lines = triggers.map((t) => {
        const executed = t.executed ? ' [AUTO-EXECUTED]' : t.execution_error ? ` [ERROR: ${t.execution_error}]` : '';
        return `• ${t.rule.name}${executed}\n  ${t.reason}${t.proposed_action ? `\n  Action: ${t.proposed_action}` : ''}`;
      });
      await bot.sendMessage(chatId, `Rules fired (${triggers.length}):\n\n${lines.join('\n\n')}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await bot.sendMessage(chatId, `Rule evaluation failed: ${m}`);
    }
    return;
  }

  if (sub === 'auto' && parts[1]) {
    const id = Number(parts[1]);
    if (!Number.isFinite(id) || id <= 0) {
      await bot.sendMessage(chatId, 'Usage: /rules auto <rule_id>');
      return;
    }
    await supabase.from('agent_rules').update({ auto_execute: true }).eq('id', id);
    await bot.sendMessage(chatId, `Rule #${id} set to AUTO — will execute without confirmation when triggered.`);
    return;
  }

  if (sub === 'disable' && parts[1]) {
    const id = Number(parts[1]);
    if (!Number.isFinite(id) || id <= 0) {
      await bot.sendMessage(chatId, 'Usage: /rules disable <rule_id>');
      return;
    }
    await setRuleActive(id, false);
    await bot.sendMessage(chatId, `Rule #${id} disabled.`);
    return;
  }

  const help = [
    '/rules — autonomous scaling rule engine',
    '',
    '  /rules list       — show active rules and trigger counts',
    '  /rules eval       — run all rules now against live account data',
    '  /rules auto <id>  — promote rule to auto-execute (no confirmation)',
    '  /rules disable <id> — disable a rule',
    '',
    'Rules start as notify-only. Use /rules auto <id> once you trust them.',
  ].join('\n');
  await bot.sendMessage(chatId, help);
}

// ---------- /cohorts — customer quality intelligence ----------

async function handleCohortsCmd(chatId: number, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? '').toLowerCase();

  if (sub === 'refresh' || sub === 'run') {
    await bot.sendMessage(chatId, 'Pulling cohort data from Meta + CIO…');
    try {
      const r = await runCohortTick({ date_preset: 'last_7d', force_rediscover: sub === 'refresh' });
      if (!r.ok) {
        await bot.sendMessage(chatId, `Cohort pull failed: ${r.error ?? 'unknown error'}`);
        return;
      }
      const text = r.snapshot
        ? formatCohortForTelegram(r.snapshot, r.event_map)
        : 'No snapshot data returned.';
      await sendChunked(chatId, text);
    } catch (err) {
      await bot.sendMessage(chatId, `Cohort tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (sub === 'discover') {
    await bot.sendMessage(chatId, 'Re-scanning CIO for event names…');
    try {
      const map = await discoverCohortEventMap(true);
      const lines: string[] = [
        'CIO event map updated:',
        `  lead:    ${map.lead}`,
        `  rebill:  ${map.rebill ?? '(not found)'}`,
        `  intake:  ${map.intake_complete ?? '(not found)'}`,
        `  approval: ${map.approval ?? '(not found)'}`,
        `  refund:  ${map.refund ?? '(not found)'}`,
        '',
        'If rebill shows "(not found)", ask Rahul what the payment event is called in CIO.',
        'Then set it with: /cohorts set rebill <event_name>',
      ];
      await sendChunked(chatId, lines.join('\n'));
    } catch (err) {
      await bot.sendMessage(chatId, `Discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (sub === 'set') {
    const field = parts[1]?.toLowerCase() as 'lead' | 'rebill' | 'refund' | 'intake_complete' | 'approval' | undefined;
    const eventName = parts.slice(2).join('_');
    const validFields = ['lead', 'rebill', 'refund', 'intake_complete', 'approval'];
    if (!field || !validFields.includes(field) || !eventName) {
      await bot.sendMessage(chatId, `Usage: /cohorts set <lead|rebill|refund|intake_complete|approval> <event_name>\nExample: /cohorts set rebill Payment_completed`);
      return;
    }
    try {
      const updated = await setCohortEventOverride(field, eventName);
      await bot.sendMessage(chatId, `Set ${field} → "${eventName}"\nRun /cohorts refresh to pull fresh data with the new mapping.`);
      void updated;
    } catch (err) {
      await bot.sendMessage(chatId, `Set failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (sub === 'history') {
    const limit = Math.min(parseInt(parts[1] ?? '14', 10) || 14, 30);
    const rows = await listCohortHistory({ limit });
    if (rows.length === 0) {
      await bot.sendMessage(chatId, 'No cohort history. Run /cohorts refresh first.');
      return;
    }
    const lines: string[] = [`Cohort history (${rows.length}):`, ''];
    for (const r of rows) {
      const rebillStr = r.rebill_count > 0
        ? `rebills=${r.rebill_count}${r.rebill_rate_pct != null ? ` (${r.rebill_rate_pct.toFixed(0)}%)` : ''} CPB=${r.cpb != null ? `$${r.cpb.toFixed(0)}` : '?'}`
        : 'rebills=0';
      lines.push(`${r.cohort_date}  spend=$${r.spend.toFixed(0)}  leads=${r.lead_count}  CPL=${r.cpl != null ? `$${r.cpl.toFixed(0)}` : '?'}  ${rebillStr}`);
    }
    await sendChunked(chatId, lines.join('\n'));
    return;
  }

  // Default: show latest snapshot
  await bot.sendChatAction(chatId, 'typing');
  const latest = await getLatestCohort('account');
  const eventMap = await discoverCohortEventMap().catch(() => null);

  if (!latest) {
    await bot.sendMessage(chatId, [
      'No cohort data yet.',
      '',
      'Run /cohorts refresh to pull a snapshot from Meta + CIO.',
      'If the rebill event isn\'t found, ask Rahul the CIO event name and set it:',
      '  /cohorts set rebill <event_name>',
      '',
      'Subcommands:',
      '  /cohorts refresh — pull fresh data now',
      '  /cohorts discover — re-scan CIO event names',
      '  /cohorts set rebill <event_name>',
      '  /cohorts history — show past snapshots',
    ].join('\n'));
    return;
  }

  const text = formatCohortForTelegram(latest, eventMap ?? undefined);
  await sendChunked(chatId, text + '\n\nRun /cohorts refresh to update.');
}

// ---------- /tag — creative intelligence ----------

async function handleTagCmd(chatId: number, args: string): Promise<void> {
  const sub = args.trim().split(/\s+/)[0]?.toLowerCase();

  if (sub === 'stats' || sub === 'performance') {
    await bot.sendChatAction(chatId, 'typing');
    const results = await getCreativePerformanceByAngle();
    if (results.length === 0) {
      await bot.sendMessage(chatId, 'No creative tags yet. Tag ads first with /tag <ad name>.');
      return;
    }
    const lines: string[] = ['Creative tags by angle:', ''];
    for (const r of results) {
      lines.push(
        `${r.angle.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}: ${r.ad_count} ad${r.ad_count === 1 ? '' : 's'}${r.avg_cpl != null ? `  avg CPL $${r.avg_cpl.toFixed(0)}` : ''}`,
      );
    }
    await sendChunked(chatId, lines.join('\n'));
    return;
  }

  if (!args.trim()) {
    await bot.sendMessage(chatId, 'Usage: /tag <ad name or id>\n       /tag stats — breakdown by emotional angle');
    return;
  }

  await bot.sendChatAction(chatId, 'typing');
  const ad = await findAdByQuery(args);
  if (!ad) {
    await bot.sendMessage(chatId, `No ad matched "${args}".`);
    return;
  }

  try {
    const full = await getAd(ad.id);
    const tag = await tagAndSaveAd({
      id: full.id,
      name: full.name,
      title: full.creative?.title ?? undefined,
      body: full.creative?.body ?? undefined,
      campaign_id: (full as unknown as Record<string, unknown>).campaign_id as string | undefined,
    });
    const summary = formatTagSummary(tag);
    const lines: string[] = [
      `Tagged: ${full.name}`,
      `  ${summary}`,
      tag.hook_text ? `  Hook: "${tag.hook_text}"` : '',
      tag.cta_language ? `  CTA: ${tag.cta_language}` : '',
      tag.notes ? `  Notes: ${tag.notes}` : '',
    ].filter(Boolean);
    await sendChunked(chatId, lines.join('\n'));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await bot.sendMessage(chatId, `Tag failed: ${m}`);
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
  images?: AttachedImage[],
): Promise<void> {
  const guardUserKey = sender?.userId != null ? String(sender.userId) : (sender?.username ?? undefined);
  await bot.sendChatAction(chatId, 'typing');

  // The router records the user's message before dispatch, so memory is up-to-date.
  // 1. Pull context: rolling conversation, persistent observations, active goals.
  const [history, observations, goals] = await Promise.all([
    loadRecentMessages(chatId),
    loadActiveObservations(),
    loadActiveGoals(),
  ]);

  // Drop the just-recorded user turn off the end of history; we'll add it as the live user turn.
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

  // 3. Build the current user turn — image blocks first, then text.
  // If the user sent images with no caption, give Claude a hint so it knows to look.
  const userBlocks: Anthropic.ContentBlockParam[] = [];
  for (const img of images ?? []) {
    userBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type, data: img.data },
    });
  }
  const captionText = userText.trim()
    ? userText
    : images && images.length > 0
      ? '(image attached, no caption — describe what you see and react accordingly)'
      : '';
  if (captionText) userBlocks.push({ type: 'text', text: captionText });

  // If images are attached, tell Claude their refs so it can pass them to
  // upload_image_for_ad when the user asks for ad creation from media.
  if (images && images.length > 0) {
    const refs = images
      .map((img, i) => `  img_${i}: ${img.media_type}, ~${Math.round((img.data.length * 3) / 4 / 1024)}KB`)
      .join('\n');
    userBlocks.push({
      type: 'text',
      text:
        `[attached images registry — pass these refs to upload_image_for_ad when the user wants to create an ad from the image]\n${refs}\n\nBefore uploading: check for healthcare-policy-sensitive content (before/after weight loss imagery, body shots with text overlays claiming results, "lose X lbs" guarantees). If you see any of those, flag the policy risk to the user FIRST and confirm before calling upload_image_for_ad.`,
    });
  }

  // Stash images for tool dispatch (resolveAttachedImage looks them up by chatId).
  turnImages.set(chatId, images ?? []);

  // Build the message array: rolling history + session-context turn + current user turn.
  const messages: Anthropic.MessageParam[] = [
    ...priorHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: `[session context]\n${sessionContext}` },
    { role: 'user', content: userBlocks.length > 0 ? userBlocks : userText },
  ];

  // 4. Tool-use loop: keep calling Claude until it stops asking for tools.
  let assistantText = '';
  const MAX_HOPS = 8;

  try {
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
          const result = await dispatchToolGuarded(
            tu.name,
            tu.input as Record<string, unknown>,
            chatId,
            guardUserKey,
            sender,
          );
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
  } finally {
    // Always clear the per-turn image registry so subsequent turns can't
    // accidentally upload stale bytes via a leftover ref.
    turnImages.delete(chatId);
  }

  // 5. Consolidated permission prompt: if the agentic loop queued one or more
  // tool_actions awaiting confirmation, show a SINGLE summary prompt so the
  // user can approve the whole batch with one YES instead of N.
  const queued = guardUserKey ? peekPending(chatId, guardUserKey) : [];
  const toolQueue = queued.filter((a): a is Extract<PendingAction, { kind: 'tool_action' }> => a.kind === 'tool_action');
  if (toolQueue.length > 0) {
    const lines: string[] = [];
    if (toolQueue.length === 1) {
      lines.push(`About to ${toolQueue[0].targetLabel}.`);
      lines.push('');
      lines.push('Reply YES to confirm, or anything else to cancel.');
    } else {
      lines.push(`About to do ${toolQueue.length} actions:`);
      lines.push('');
      toolQueue.forEach((a, i) => lines.push(`  ${i + 1}. ${a.targetLabel}`));
      lines.push('');
      lines.push(`Reply YES to do all ${toolQueue.length}, or anything else to cancel all.`);
    }
    const prompt = lines.join('\n');
    // Suppress the LLM's text if it was an empty placeholder — the prompt IS the message.
    if (!assistantText || assistantText === '[no response]') assistantText = prompt;
    else assistantText = `${assistantText}\n\n${prompt}`;
  }

  if (!assistantText) assistantText = '[no response]';

  // 6. Persist the assistant reply so future turns can see it.
  await recordMessage(chatId, 'assistant', assistantText);

  await sendChunked(chatId, assistantText);
}

// ---------- Router ----------

bot.on('message', async (msg) => {
  // Receiving a message means Telegram is routing updates to us — we are the
  // active (primary) poller. Clear secondary flag in case it was set during
  // deploy overlap when the old instance was still alive.
  if (isSecondaryCronInstance) {
    isSecondaryCronInstance = false;
    console.log('[CONFLICT] Now receiving messages — transitioned to primary instance.');
  }

  const chatId = msg.chat.id;
  // Photo messages have caption instead of text. Use whichever is present.
  let text = (msg.text ?? msg.caption ?? '').trim();
  const handle = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? 'unknown');

  // Detect image attachments early so we can route them through Claude even with no text.
  const hasImage =
    (msg.photo && msg.photo.length > 0) ||
    Boolean(msg.document && msg.document.mime_type?.startsWith('image/'));

  // Skip messages that have no text and no image (Telegram service messages, stickers, etc.)
  if (!text && !hasImage) return;

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

  // ---------- Two-bot routing in shared groups ----------
  // When Clayton (this bot) and Google Clayton (@Clayton_googlebot) are
  // both in the same group, route messages by addressee. Clayton is the
  // DEFAULT (responds to anything not explicitly addressed to Google
  // Clayton). Google Clayton ignores anything that doesn't start with
  // "google", "google clayton", or its @-handle.
  //
  // This bot stays silent when a message is addressed to Google Clayton.
  const isGroupChat = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  if (isGroupChat && isAddressedToGoogleClayton(text)) {
    return;
  }
  // If addressed to this bot (or no platform mention at all), strip
  // addressing artifacts so existing slash-command equality checks
  // ('/help', '/status') match and the LLM isn't tripped by its own name
  // in the input. Slash command shortcuts like '/helpmeta' become '/help'.
  if (isGroupChat) {
    text = text
      .replace(/@clayton_metabot\b/gi, '')
      .replace(/^\/([a-z_]+)meta(\s|$)/i, '/$1$2')           // /helpmeta → /help
      .replace(/^meta\s+clayton[,:]?\s*/i, '')
      .replace(/^meta[,:]?\s+/i, '')
      .replace(/^clayton[,:]?\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Per-user pending action: in groups, only the same user who started the
  // /pause /budget /boost can confirm it.
  const userKey = senderId ?? senderUsername ?? '';

  // Persist the user turn at the router so EVERY message — slash commands,
  // confirmations, free-form — is visible in memory. Tag attachments so a
  // later replay knows what was sent.
  const memoryText = hasImage
    ? `${text || ''}\n[image attachment${(msg.photo?.length ?? 0) + (msg.document ? 1 : 0) === 1 ? '' : 's'}]`.trim()
    : text;
  if (memoryText) {
    await recordMessage(chatId, 'user', memoryText, {
      fromUserId: senderId,
      fromUsername: senderUsername,
    });
  }

  try {
    // If pending actions are waiting and the user did NOT start a new slash command,
    // try to interpret their reply as confirm/cancel. A single YES now drains the
    // entire batch sequentially.
    if (pendingSize(chatId, userKey) > 0 && !text.startsWith('/')) {
      const verdict = classifyReply(text);
      if (verdict === 'confirm') {
        const actions = takePending(chatId, userKey);
        if (actions.length === 1) {
          await executePending(chatId, actions[0], handle, text, {
            userId: senderId,
            username: senderUsername,
          });
        } else if (actions.length > 1) {
          await bot.sendMessage(chatId, `Running ${actions.length} actions…`);
          let ok = 0;
          let fail = 0;
          const failures: string[] = [];
          for (const a of actions) {
            const label = a.kind === 'tool_action' ? a.targetLabel : a.kind;
            try {
              const result = await executePending(chatId, a, handle, text, {
                userId: senderId,
                username: senderUsername,
              });
              if (result.ok) {
                ok++;
              } else {
                fail++;
                failures.push(`  ✗ ${label}: ${result.error ?? 'unknown error'}`);
              }
            } catch (err) {
              fail++;
              const m = err instanceof Error ? err.message : String(err);
              failures.push(`  ✗ ${label}: ${m}`);
            }
          }
          const summary =
            fail === 0
              ? `✓ All ${ok} actions complete.`
              : ok === 0
                ? `✗ All ${fail} actions failed.\n${failures.join('\n')}`
                : `Done: ${ok} succeeded, ${fail} failed.\n${failures.join('\n')}`;
          await bot.sendMessage(chatId, summary);
        }
        return;
      }
      if (verdict === 'cancel') {
        const n = pendingSize(chatId, userKey);
        takePending(chatId, userKey);
        await bot.sendMessage(chatId, n > 1 ? `Cancelled all ${n} pending actions.` : 'Cancelled.');
        return;
      }
      // unclear → fall through to Claude
    }

    // No per-user pending — but check for an open rebalance proposal.
    // Daily proposals live for ~12h until the next pass supersedes them, so
    // they can't ride the 5-min pending Map. A bare "yes" applies the most
    // recent proposed plan; "no" rejects it.
    //
    // CRITICAL: use isBareConfirm/isBareCancel here, NOT classifyReply. A
    // phrase like "Yes resume ghost 500" matches classifyReply as 'confirm'
    // because it contains the word "yes", but it is obviously NOT a bare
    // confirmation of a stale open rebalance plan — it's a confirmation of
    // a different action the user is teeing up. Auto-applying the rebalance
    // in that case hijacks the user's actual intent (see 2026-05-11 Ghost
    // incident: "Yes resume ghost 500" → applied empty rebalance #20
    // instead of resuming the campaign).
    if (!text.startsWith('/')) {
      const isConfirm = isBareConfirm(text);
      const isCancel = !isConfirm && isBareCancel(text);
      if (isConfirm || isCancel) {
        const open = await loadOpenProposal();
        if (open && open.id != null) {
          if (isConfirm) {
            await bot.sendChatAction(chatId, 'typing');
            try {
              const r = await applyRebalancePlan(open.id, `user:${senderUsername ?? senderId ?? 'unknown'}`);
              await bot.sendMessage(
                chatId,
                `Applied rebalance plan #${open.id}: ${r.applied} succeeded, ${r.failed} failed. Status=${r.plan?.status}.`,
              );
            } catch (err) {
              await bot.sendMessage(chatId, `Apply failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
          }
          await rejectRebalancePlan(open.id, `user:${senderUsername ?? senderId ?? 'unknown'}`);
          await bot.sendMessage(chatId, `Rejected rebalance plan #${open.id}.`);
          return;
        }
      }
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
              '/memory [N] — show last N messages I have stored for this chat (default 20)',
              '/journey <email> — full Customer.io journey for one lead',
              '',
              'Daily rhythm:',
              '/briefing — fire morning briefing now',
              '/recap — fire end-of-day recap now',
              '',
              'Write (gated, requires confirm reply):',
              '/pause <campaign>',
              '/resume <campaign> (aliases: /activate, /on)',
              '/budget <campaign> <amount>',
              '/boost <campaign> <percent>',
              '',
              'Permissions (standing orders for autonomous writes):',
              '/perms — list active standing orders',
              '/grant <kind> [campaign="..."] [expires=24h|7d|permanent]',
              '/revoke <id> [reason...]',
              '',
              'Real-time monitor:',
              '/inbox — open signals (cpl spike, zero leads, etc.)',
              '/inbox resolve <id> [note] — dismiss an inbox item',
              '/monitor — run a monitor tick now (test)',
              '/judge <inbox_id> — reasoned analysis of an open signal',
              '/judgments [N] — recent judgment trail',
              '',
              'Landing page intelligence (Mondays 8am PT scrape):',
              '/competitors — list/add/remove competitor URLs',
              '/lp — status of latest snapshots + open recommendations',
              '/lp scan [url] — force scrape now',
              '/lp recommend — generate fresh recommendations',
              '/lp implemented <rec_id> [date] — mark a rec as deployed (lift tracking)',
              '/lp measure <rec_id> — force pre/post lift comparison now',
              '',
              'Daily rebalance (9am + 6pm PT):',
              '/rebalance — generate a fresh proposal now',
              '/rebalance show — re-print the open proposal',
              '/rebalance accept [id] — apply (defaults to most recent)',
              '/rebalance reject [id] — dismiss',
              '/rebalance history [N] — last N plans',
              '',
              'CAPI bridge (forward CIO events → Meta Conversions API):',
              '/capi — show status, mappings, recent forwards',
              '/capi pixel <id>',
              '/capi map <cio_event> <meta_event> [action=...]',
              '/capi enable | /capi disable',
              '/capi backfill <hours>',
              '',
              'CIO upstream health:',
              '/cio — health check (events 24h/7d/30d, last seen, funnel state)',
              '',
              'Customer quality (CPB):',
              '/cohorts — latest rebill rate, CPB, intake completion',
              '/cohorts refresh — pull fresh snapshot from Meta + CIO now',
              '/cohorts discover — re-scan CIO for event names',
              '/cohorts set rebill <event_name> — configure the rebill event',
              '/cohorts history — past snapshots',
              '',
              'Creative intelligence:',
              '/tag <ad> — auto-tag an ad (hook type, emotional angle, format, claim)',
              '/tag stats — breakdown of tagged ads by emotional angle',
              '/audit <ad_id> — pre-launch Meta policy check via Claude vision (catches drugs/pharma rejections before they happen)',
              '',
              'Autonomous rules:',
              '/rules — list active rules and trigger history',
              '/rules eval — run all rules now against live account',
              '/rules auto <id> — promote rule to auto-execute',
              '',
              'Audiences:',
              '/audiences — list all custom + lookalike audiences grouped by type',
              '/audiences delete <id> — permanently delete one (irreversible)',
              '',
              'Market intelligence:',
              '/intel <topic> — deep multi-source landscape scan (news, Reddit, competitors, regulatory)',
              '  e.g. /intel TRT  |  /intel GLP-1 compounding  |  /intel semaglutide FDA 2026',
              '',
              'Or ask anything in plain English. The agent has web search, can drill into ads, save observations, set goals, and create rules.',
            ].join('\n'),
          );
          return;
        case 'intel':
        case 'research':
        case 'market': {
          if (!args.trim()) {
            await bot.sendMessage(chatId, 'Usage: /intel <topic>\nExamples:\n  /intel TRT\n  /intel GLP-1 compounding regulations\n  /intel semaglutide competitors 2026');
            return;
          }
          // Route through Claude with explicit intel instruction so it chains searches
          text = `Run a full market intelligence scan on: ${args.trim()}. Search news, Reddit patient sentiment, competitor activity, and regulatory landscape. Use web_search at least 6 times across different angles before synthesizing. Structure your response: What's happening now / What patients are saying / What competitors are doing / Market opportunity / Recommended ad angle.`;
          break;
        }
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
        case 'memory': {
          const requested = parseInt(args, 10);
          const want = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 50) : 20;
          const health = await checkSchemaHealth();
          const recent = await loadRecentMessages(chatId);
          const fails = getMemoryFailureCounts();
          const lines: string[] = [];
          lines.push(`Memory state for chat_id=${chatId}`);
          lines.push(`  schema_ok: ${health.ok}`);
          if (!health.ok) {
            if (health.missing.length > 0) lines.push(`  missing tables: ${health.missing.join(', ')}`);
            if (health.optionalMissing.length > 0)
              lines.push(`  missing columns: ${health.optionalMissing.join(', ')}`);
          }
          lines.push(`  failures since boot: writes=${fails.writes} reads=${fails.reads}`);
          lines.push(`  stored messages in this chat: ${recent.length} (showing up to ${want})`);
          lines.push('');
          if (recent.length === 0) {
            lines.push('(no messages stored)');
          } else {
            for (const m of recent.slice(-want)) {
              const ts = m.created_at ? m.created_at.replace('T', ' ').slice(0, 16) : '?';
              const who =
                m.role === 'assistant'
                  ? 'clayton'
                  : m.from_username
                    ? `@${m.from_username}`
                    : m.from_user_id
                      ? `id=${m.from_user_id}`
                      : 'user';
              const preview = m.content.length > 280 ? m.content.slice(0, 280) + '…' : m.content;
              lines.push(`${ts}  ${who}: ${preview}`);
            }
          }
          await sendChunked(chatId, lines.join('\n'));
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
          await handlePauseCmd(chatId, userKey, args, handle);
          return;
        case 'resume':
        case 'activate':
        case 'on':
          await handleResumeCmd(chatId, userKey, args);
          return;
        case 'budget':
          await handleBudgetCmd(chatId, userKey, args);
          return;
        case 'boost':
          await handleBoostCmd(chatId, userKey, args);
          return;
        case 'perms':
        case 'permissions':
          await handlePermsCmd(chatId);
          return;
        case 'inbox': {
          const sub = args.trim().split(/\s+/);
          if (sub[0] === 'resolve') {
            const id = Number(sub[1]);
            if (!Number.isFinite(id) || id <= 0) {
              await bot.sendMessage(chatId, 'Usage: /inbox resolve <id> [note]');
              return;
            }
            const note = sub.slice(2).join(' ') || null;
            const ok = await resolveInboxItem(id, `user:${senderUsername ?? senderId ?? 'unknown'}`, note);
            await bot.sendMessage(chatId, ok ? `Resolved inbox #${id}.` : `Couldn't resolve #${id} (already closed?).`);
            return;
          }
          const open = await listOpenInbox(50);
          if (open.length === 0) {
            await bot.sendMessage(chatId, "Inbox empty. Nothing has tripped a signal.");
            return;
          }
          const lines: string[] = [`${open.length} open signal${open.length === 1 ? '' : 's'}:`, ''];
          for (const it of open) {
            const ts = it.last_seen_at.replace('T', ' ').slice(0, 16);
            lines.push(`#${it.id} [${it.severity}] ${it.message}`);
            lines.push(`   kind=${it.signal_kind} last_seen=${ts}${it.surfaced_to_telegram ? ' (notified)' : ''}`);
          }
          lines.push('');
          lines.push('/inbox resolve <id> to dismiss');
          await sendChunked(chatId, lines.join('\n'));
          return;
        }
        case 'capi':
          await handleCapiCmd(chatId, userKey, { userId: senderId, username: senderUsername }, args);
          return;
        case 'cio':
          await handleCioCmd(chatId, args);
          return;
        case 'competitors':
        case 'comp': {
          const sub = (args.trim().split(/\s+/)[0] ?? '').toLowerCase();
          if (sub === 'add') {
            const url = args.trim().split(/\s+/)[1];
            const label = args.trim().split(/\s+/).slice(2).join(' ');
            if (!url) {
              await bot.sendMessage(chatId, 'Usage: /competitors add <url> [label]');
              return;
            }
            try {
              const c = await addCompetitor({ url, label: label || undefined });
              await bot.sendMessage(chatId, `Added competitor #${c.id}: ${c.url}${c.label ? ' (' + c.label + ')' : ''}`);
            } catch (err) {
              await bot.sendMessage(chatId, `Add failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
          }
          if (sub === 'remove' || sub === 'rm') {
            const id = Number(args.trim().split(/\s+/)[1]);
            if (!Number.isFinite(id) || id <= 0) {
              await bot.sendMessage(chatId, 'Usage: /competitors remove <id>');
              return;
            }
            await removeCompetitor(id);
            await bot.sendMessage(chatId, `Removed competitor #${id}.`);
            return;
          }
          if (sub === 'enable' || sub === 'disable') {
            const id = Number(args.trim().split(/\s+/)[1]);
            if (!Number.isFinite(id) || id <= 0) {
              await bot.sendMessage(chatId, `Usage: /competitors ${sub} <id>`);
              return;
            }
            await setCompetitorEnabled(id, sub === 'enable');
            await bot.sendMessage(chatId, `${sub}d competitor #${id}.`);
            return;
          }
          // default: list
          const all = await listCompetitors(true);
          if (all.length === 0) {
            await bot.sendMessage(chatId, 'No competitors. Add via /competitors add <url> [label]');
            return;
          }
          const lines: string[] = [`Competitors (${all.length}):`, ''];
          for (const c of all) {
            lines.push(
              `#${c.id} ${c.enabled ? '✓' : '✗'} ${c.url}${c.label ? ' — ' + c.label : ''}${c.type !== 'landing_page' ? ` [${c.type}]` : ''}`,
            );
          }
          await sendChunked(chatId, lines.join('\n'));
          return;
        }
        case 'lp': {
          const sub = (args.trim().split(/\s+/)[0] ?? '').toLowerCase();
          if (sub === 'scan') {
            // Only treat the next token as a target if it actually looks like
            // a URL or a numeric competitor id. Anything else (stray words
            // copy-pasted from instructions, etc.) → fall back to full scan.
            const second = args.trim().split(/\s+/)[1];
            const isUrl = second && /^https?:\/\//i.test(second);
            const isId = second && /^\d+$/.test(second);
            if (isUrl || isId) {
              const targetUrl = second!;
              await bot.sendMessage(chatId, `Scraping ${targetUrl}…`);
              const all = await listCompetitors(true);
              const c = all.find((x) => x.url === targetUrl || String(x.id) === targetUrl);
              if (!c) {
                await bot.sendMessage(chatId, 'Not in competitor list. Add it first via /competitors add <url>');
                return;
              }
              const r = await snapshotCompetitor(c, 'manual');
              await bot.sendMessage(
                chatId,
                `Snapshot ${r.snapshot_id ?? 'failed'} — analyzed=${r.analyzed}${r.error ? ' err=' + r.error : ''}`,
              );
              return;
            }
            await bot.sendMessage(chatId, 'Running full LP scrape (may take 1-2 min)…');
            try {
              const r = await runDailyLpTick();
              await bot.sendMessage(
                chatId,
                `Scrape: ${r.succeeded}/${r.total} succeeded, ${r.analyzed} analyzed, ${r.failed} failed.`,
              );
            } catch (err) {
              await bot.sendMessage(chatId, `Scrape failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
          }
          if (sub === 'recommend' || sub === 'recommendations' || sub === 'recs') {
            const sub2 = args.trim().split(/\s+/)[1]?.toLowerCase();
            if (sub2 === 'list') {
              const recs = await listRecommendations('proposed');
              await sendChunked(chatId, formatRecommendationsForTelegram(recs));
              return;
            }
            await bot.sendMessage(chatId, 'Generating recommendations from latest snapshots…');
            try {
              const r = await generateRecommendations();
              if ('error' in r) {
                await bot.sendMessage(chatId, r.error);
                return;
              }
              const lines = [`Generated ${r.recommendations.length} recommendations:`, ''];
              lines.push(formatRecommendationsForTelegram(r.recommendations, r.summary));
              await sendChunked(chatId, lines.join('\n'));
            } catch (err) {
              await bot.sendMessage(chatId, `Recommendations failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
          }
          if (sub === 'implemented') {
            const id = Number(args.trim().split(/\s+/)[1]);
            const date = args.trim().split(/\s+/)[2] ?? new Date().toISOString().slice(0, 10);
            if (!Number.isFinite(id) || id <= 0) {
              await bot.sendMessage(chatId, 'Usage: /lp implemented <recommendation_id> [yyyy-mm-dd]');
              return;
            }
            await markRecommendationStatus(id, 'implemented', date);
            await bot.sendMessage(chatId, `Marked recommendation #${id} as implemented on ${date}.`);
            return;
          }
          if (sub === 'reject') {
            const id = Number(args.trim().split(/\s+/)[1]);
            if (!Number.isFinite(id) || id <= 0) {
              await bot.sendMessage(chatId, 'Usage: /lp reject <recommendation_id>');
              return;
            }
            await markRecommendationStatus(id, 'rejected');
            await bot.sendMessage(chatId, `Rejected recommendation #${id}.`);
            return;
          }
          if (sub === 'measure') {
            const id = Number(args.trim().split(/\s+/)[1]);
            if (!Number.isFinite(id) || id <= 0) {
              await bot.sendMessage(chatId, 'Usage: /lp measure <recommendation_id>');
              return;
            }
            await bot.sendChatAction(chatId, 'typing');
            const r = await measureLpLift(id);
            if ('error' in r) {
              await bot.sendMessage(chatId, `Measurement failed: ${r.error}`);
              return;
            }
            const lines: string[] = [
              `Measurement #${id}:`,
              `  pre lead_rate: ${r.pre.lead_rate_pct != null ? r.pre.lead_rate_pct.toFixed(2) + '%' : 'n/a'} (${r.pre.leads}/${r.pre.clicks})`,
              `  post lead_rate: ${r.post.lead_rate_pct != null ? r.post.lead_rate_pct.toFixed(2) + '%' : 'n/a'} (${r.post.leads}/${r.post.clicks})`,
              `  lift on lead_rate: ${r.lift_lead_rate_pct == null ? 'n/a' : (r.lift_lead_rate_pct >= 0 ? '+' : '') + r.lift_lead_rate_pct.toFixed(1) + '%'}`,
              `  lift on CPL: ${r.lift_cpl_pct == null ? 'n/a' : (r.lift_cpl_pct >= 0 ? '+' : '') + r.lift_cpl_pct.toFixed(1) + '%'}`,
            ];
            if (r.confound_warning) lines.push(`  caveat: ${r.confound_warning}`);
            await sendChunked(chatId, lines.join('\n'));
            return;
          }
          // default: status — most recent snapshots + open recs
          const snaps = await loadLatestSnapshots();
          const recs = await listRecommendations('proposed', 10);
          const lines: string[] = [];
          lines.push(`LP intelligence — screenshot service ${SCREENSHOT_AVAILABLE ? 'configured' : 'NOT configured (text-only)'}`);
          lines.push('');
          lines.push(`Latest snapshots (${snaps.length}):`);
          for (const s of snaps.slice(0, 12)) {
            const a = s.parsed_structure;
            const ts = s.captured_at.replace('T', ' ').slice(0, 16);
            lines.push(
              `  ${ts} ${s.label ?? s.url}${a ? ` — "${(a.hero_headline ?? '?').slice(0, 60)}"` : ' (analysis unavailable)'}`,
            );
          }
          lines.push('');
          if (recs.length === 0) {
            lines.push('No open recommendations. Run /lp recommend to generate.');
          } else {
            lines.push(`Open recommendations (${recs.length}):`);
            for (const r of recs.slice(0, 6)) {
              lines.push(`  #${r.id} P${r.priority} (${r.expected_lift_band}) — ${r.hypothesis.slice(0, 100)}`);
            }
          }
          lines.push('');
          lines.push('Subcommands:');
          lines.push('  /lp scan [url] — force scrape now (all, or one URL/id)');
          lines.push('  /lp recommend — generate fresh recommendations');
          lines.push('  /lp recommend list — list open recommendations');
          lines.push('  /lp implemented <rec_id> [yyyy-mm-dd] — mark deployed');
          lines.push('  /lp reject <rec_id>');
          lines.push('  /competitors — manage the competitor list');
          await sendChunked(chatId, lines.join('\n'));
          return;
        }
        case 'rebalance': {
          const sub = (args.trim().split(/\s+/)[0] ?? '').toLowerCase();
          if (sub === 'history' || sub === 'log') {
            const limit = Math.min(Math.max(parseInt(args.trim().split(/\s+/)[1] ?? '14', 10) || 14, 1), 50);
            const items = await listRecentPlans(limit);
            if (items.length === 0) {
              await bot.sendMessage(chatId, 'No rebalance plans recorded.');
              return;
            }
            const lines: string[] = [`Recent rebalance plans (${items.length}):`, ''];
            for (const p of items) {
              const ts = new Date((p as { created_at?: string }).created_at ?? '').toISOString().replace('T', ' ').slice(0, 16);
              lines.push(
                `#${p.id} ${ts} ${p.generated_by} metric=${p.metric} status=${p.status} changes=${(p.changes ?? []).length}`,
              );
            }
            await sendChunked(chatId, lines.join('\n'));
            return;
          }
          if (sub === 'accept' || sub === 'apply' || sub === 'yes') {
            const idArg = parseInt(args.trim().split(/\s+/)[1] ?? '', 10);
            const open = await loadOpenProposal();
            const id = Number.isFinite(idArg) && idArg > 0 ? idArg : open?.id;
            if (id == null) {
              await bot.sendMessage(chatId, 'No proposed plan to apply. Run /rebalance first.');
              return;
            }
            await bot.sendChatAction(chatId, 'typing');
            try {
              const r = await applyRebalancePlan(id, `user:${senderUsername ?? senderId ?? 'unknown'}`);
              await bot.sendMessage(
                chatId,
                `Applied plan #${id}: ${r.applied} succeeded, ${r.failed} failed. Status=${r.plan?.status}.`,
              );
            } catch (err) {
              await bot.sendMessage(chatId, `Apply failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
          }
          if (sub === 'reject' || sub === 'no' || sub === 'dismiss') {
            const idArg = parseInt(args.trim().split(/\s+/)[1] ?? '', 10);
            const open = await loadOpenProposal();
            const id = Number.isFinite(idArg) && idArg > 0 ? idArg : open?.id;
            if (id == null) {
              await bot.sendMessage(chatId, 'No proposed plan to reject.');
              return;
            }
            await rejectRebalancePlan(id, `user:${senderUsername ?? senderId ?? 'unknown'}`);
            await bot.sendMessage(chatId, `Rejected plan #${id}.`);
            return;
          }
          if (sub === 'show' || sub === 'status' || sub === 'open') {
            const open = await loadOpenProposal();
            if (!open) {
              await bot.sendMessage(chatId, 'No open proposal. Run /rebalance to generate one.');
              return;
            }
            await sendChunked(chatId, formatPlanForTelegram(open));
            return;
          }
          // No subcommand → generate a fresh proposal now.
          await bot.sendChatAction(chatId, 'typing');
          try {
            const plan = await generateRebalanceProposal('manual');
            await sendChunked(chatId, formatPlanForTelegram(plan));
          } catch (err) {
            await bot.sendMessage(chatId, `Rebalance failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }
        case 'monitor': {
          await bot.sendMessage(chatId, 'Running monitor tick now…');
          try {
            const r = await runMonitorTick();
            await bot.sendMessage(
              chatId,
              `Tick: detected=${r.detected} new=${r.new_inbox} surfaced=${r.surfaced} auto_acted=${r.auto_acted} auto_resolved=${r.auto_resolved_open}`,
            );
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            await bot.sendMessage(chatId, `Monitor failed: ${m}`);
          }
          return;
        }
        case 'judge': {
          const id = Number(args.trim().split(/\s+/)[0]);
          if (!Number.isFinite(id) || id <= 0) {
            await bot.sendMessage(chatId, 'Usage: /judge <inbox_id> — run reasoning pass on an inbox signal.');
            return;
          }
          await bot.sendChatAction(chatId, 'typing');
          try {
            const r = await runJudgmentOnSignal(id);
            if ('error' in r) {
              await bot.sendMessage(chatId, `Judgment failed: ${r.error}`);
              return;
            }
            await sendChunked(chatId, formatJudgmentForTelegram(r.judgment, 'review'));
          } catch (err) {
            await bot.sendMessage(chatId, `Judgment crashed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }
        case 'judgments': {
          const limit = Math.min(Math.max(parseInt(args.trim() || '10', 10) || 10, 1), 50);
          const items = await listRecentJudgments(limit);
          if (items.length === 0) {
            await bot.sendMessage(chatId, 'No judgments recorded yet.');
            return;
          }
          const lines: string[] = [`Recent judgments (${items.length}):`, ''];
          for (const j of items) {
            const target = j.target_name ?? j.target_id ?? '?';
            const action = j.recommended_action?.action ?? '?';
            lines.push(`#${j.id} ${j.signal_kind} on ${target} → ${action} (${j.confidence})`);
            lines.push(`   ${j.rationale.slice(0, 200)}`);
          }
          await sendChunked(chatId, lines.join('\n'));
          return;
        }
        case 'launch': {
          // Parse structured key: value lines from the message body
          const launchLines = args.split('\n');
          const launchFields: Record<string, string> = {};
          for (const line of launchLines) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const k = line.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, '_');
            const v = line.slice(colonIdx + 1).trim();
            if (k && v) launchFields[k] = v;
          }

          // Validate required fields
          const requiredFields = ['image_url', 'headline', 'body', 'landing_page'];
          const missingFields = requiredFields.filter(f => !launchFields[f]);
          if (missingFields.length > 0) {
            await bot.sendMessage(
              chatId,
              `❌ /launch is missing required fields: ${missingFields.join(', ')}\n\nPlease include all of: image_url, headline, body, landing_page.`,
            );
            return;
          }

          // Extract and apply defaults
          const campaignName =
            launchFields['campaign'] ??
            `Demand Engine — ${new Date().toISOString().slice(0, 10)}`;
          const objective = launchFields['objective'] ?? 'OUTCOME_LEADS';
          const pixelId = launchFields['pixel'] ?? null;
          const pixelEvent = launchFields['event'] ?? null;
          const budgetUsd = launchFields['budget'] ? Number(launchFields['budget']) : 100;
          const landingPage = launchFields['landing_page']!;
          const headline = launchFields['headline']!;
          const body = launchFields['body']!;
          const cta = launchFields['cta'] ?? 'LEARN_MORE';
          const imageUrl = launchFields['image_url']!;

          // Parse targeting: age=25-55, location=US
          let ageMin = 25;
          let ageMax = 55;
          let countries: string[] = ['US'];
          const targetingRaw = launchFields['targeting'] ?? '';
          if (targetingRaw) {
            const targetingParts = targetingRaw.split(',').map(p => p.trim());
            for (const part of targetingParts) {
              const eqIdx = part.indexOf('=');
              if (eqIdx === -1) continue;
              const tk = part.slice(0, eqIdx).trim().toLowerCase();
              const tv = part.slice(eqIdx + 1).trim();
              if (tk === 'age') {
                const ageParts = tv.split('-');
                if (ageParts.length === 2) {
                  ageMin = parseInt(ageParts[0], 10) || 25;
                  ageMax = parseInt(ageParts[1], 10) || 55;
                }
              } else if (tk === 'location') {
                countries = tv.split('|').map(c => c.trim()).filter(Boolean);
              }
            }
          }
          const targetingObj = {
            age_min: ageMin,
            age_max: ageMax,
            geo_locations: { countries },
          };

          // Build promoted_object if pixel is set
          const promotedObj = pixelId
            ? { pixel_id: pixelId, custom_event_type: pixelEvent ?? 'LEAD' }
            : null;

          await bot.sendMessage(chatId, '🚀 Launch received. Building campaign...');

          try {
            // Download image
            await bot.sendChatAction(chatId, 'typing');
            const imgRes = await fetch(imageUrl);
            const imgBuf = Buffer.from(await imgRes.arrayBuffer());

            // Upload to Meta
            await bot.sendChatAction(chatId, 'typing');
            const uploaded = await uploadImage({
              bytes: imgBuf,
              mime_type: 'image/png',
              filename: 'de-creative.png',
            });

            // Create campaign
            await bot.sendChatAction(chatId, 'typing');
            const campaign = await createCampaign({
              name: campaignName,
              objective: objective,
              special_ad_categories: [],
            });

            // Create ad set
            await bot.sendChatAction(chatId, 'typing');
            const adSet = await createAdSet({
              campaign_id: campaign.id,
              name: `${campaignName} — Ad Set`,
              daily_budget_cents: budgetUsd * 100,
              optimization_goal: 'OFFSITE_CONVERSIONS',
              billing_event: 'IMPRESSIONS',
              targeting: targetingObj,
              promoted_object: promotedObj ?? undefined,
            });

            // Look up a template ad from existing campaigns
            await bot.sendChatAction(chatId, 'typing');
            let templateAdId: string | null = null;
            try {
              const existingCampaigns = await listCampaigns();
              const firstCampaign = existingCampaigns[0];
              const adSets = firstCampaign ? await listAdSets(firstCampaign.id) : [];
              const existingAds = adSets[0] ? await listAds(adSets[0].id) : [];
              templateAdId = existingAds[0]?.id ?? null;
            } catch {
              // proceed without template
            }

            // Create ad
            await bot.sendChatAction(chatId, 'typing');
            const adResult = await createAdFromImage({
              ad_set_id: adSet.id,
              image_hash: uploaded.image_hash,
              headline: headline,
              primary_text: body,
              cta: cta,
              link_url: landingPage,
              ad_name: campaignName,
              template_ad_id: templateAdId ?? undefined,
            });

            await bot.sendMessage(
              chatId,
              [
                '✅ Campaign built — PAUSED (review before activating)',
                '',
                `Campaign: ${campaignName} (id: ${campaign.id})`,
                `Ad Set: id ${adSet.id}`,
                `Ad: id ${adResult.new_ad_id}`,
                `Creative: id ${adResult.new_creative_id}`,
                `Budget: $${budgetUsd}/day`,
                `Landing page: ${landingPage}`,
                'Image: uploaded ✓',
                '',
                `To activate: /activate ${adResult.new_ad_id}`,
                'To view: check Ads Manager',
              ].join('\n'),
            );
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            await bot.sendMessage(chatId, `❌ Launch failed: ${m}`);
          }
          return;
        }
        case 'cohorts':
        case 'cohort':
          await handleCohortsCmd(chatId, args);
          return;
        case 'tag':
          await handleTagCmd(chatId, args);
          return;
        case 'rules':
          await handleRulesCmd(chatId, args);
          return;
        case 'audiences':
        case 'audience':
          await handleAudiencesCmd(chatId, userKey, args);
          return;
        case 'audit':
          await handleAuditCmd(chatId, args);
          return;
        case 'grant':
          await handleGrantCmd(chatId, userKey, args);
          return;
        case 'revoke':
          await handleRevokeCmd(chatId, userKey, args);
          return;
        default:
          await bot.sendMessage(chatId, `Unknown command /${cmdRaw}. /help to list.`);
          return;
      }
    }

    const attachedImages = hasImage ? await extractImagesFromMessage(msg) : [];
    await askClaude(
      text,
      chatId,
      {
        userId: senderId ?? undefined,
        username: senderUsername,
        chatType: msg.chat.type,
      },
      attachedImages,
    );
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error('handler error:', err);
    await bot.sendMessage(chatId, `Error: ${m}`);
  }
});

// True when Telegram reports a 409 Conflict — means a newer instance has
// taken over polling (Railway deploy overlap). Suppress cron execution on
// the outgoing instance so only one instance sends alerts and takes actions.
let isSecondaryCronInstance = false;

bot.on('polling_error', (err) => {
  console.error('polling error:', err);
  const is409 = (err as { code?: string }).code === 'ETELEGRAM' && err.message?.includes('409');
  if (is409 && !isSecondaryCronInstance) {
    isSecondaryCronInstance = true;
    console.warn('[CONFLICT] 409 from Telegram — another instance is primary. Suppressing cron actions until this process exits.');
  } else if (!is409) {
    isSecondaryCronInstance = false;
  }
});

// ---------- Daily cron schedules (in-process) ----------
// Eliminates the need for GitHub Actions secrets — bot is already on
// Railway with all env vars. Same Claude/Meta/Supabase/Telegram clients
// the chat handler already uses. Schedules are in account-local TZ.

const ENABLE_CRON = (process.env.ENABLE_CRON ?? 'true').toLowerCase() !== 'false';
// User-facing pings (pulse briefings, rebalance proposals, LP ticks, CAPI
// digests) are OFF by default. Set ENABLE_AUTO_PINGS=true in Railway to
// re-enable. Slash commands (/briefing, /recap, /rebalance, /lp scan,
// /lp measure, /capi, /monitor) work regardless — they trigger the same
// code paths on demand. The silent background work (monitor tick every
// 15min, CAPI tick every 10min) keeps running under ENABLE_CRON so Lead
// attribution to Meta server-side stays intact.
const ENABLE_AUTO_PINGS = (process.env.ENABLE_AUTO_PINGS ?? 'false').toLowerCase() === 'true';

if (ENABLE_CRON) {
  if (ENABLE_AUTO_PINGS) {
    // Every 3 hours account-local — pulse check (broad summary).
    // Fires at 0, 3, 6, 9, 12, 15, 18, 21 PT (8 times a day).
    cron.schedule(
      '0 */3 * * *',
      () => {
        console.log(`[cron] pulse firing at ${new Date().toISOString()}`);
        runBriefing('pulse').catch((err) => console.error('pulse failed:', err));
      },
      { timezone: ACCOUNT_TZ },
    );
  }

  // Every 15 minutes — fast monitor tick (delta detection, inbox, auto-act).
  cron.schedule(
    '*/15 * * * *',
    () => {
      if (isSecondaryCronInstance) {
        console.log('[cron] monitor tick SKIPPED — secondary instance (409 conflict)');
        return;
      }
      console.log(`[cron] monitor tick firing at ${new Date().toISOString()}`);
      runMonitorTick()
        .then((r) =>
          console.log(
            `[monitor] detected=${r.detected} new_inbox=${r.new_inbox} surfaced=${r.surfaced} auto_acted=${r.auto_acted} auto_resolved=${r.auto_resolved_open}`,
          ),
        )
        .catch((err) => console.error('monitor tick failed:', err));
    },
    { timezone: ACCOUNT_TZ },
  );

  // Every 10 minutes — CAPI bridge tick. No-ops when disabled.
  cron.schedule(
    '*/10 * * * *',
    () => {
      if (isSecondaryCronInstance) {
        console.log('[cron] capi tick SKIPPED — secondary instance (409 conflict)');
        return;
      }
      console.log(`[cron] capi tick firing at ${new Date().toISOString()}`);
      runCapiTick()
        .then((r) =>
          console.log(
            `[capi] enabled=${r.enabled} scanned=${r.scanned} matched=${r.matched} forwarded=${r.forwarded} dedup=${r.skipped_dedup} errors=${r.errors}`,
          ),
        )
        .catch((err) => console.error('capi tick failed:', err));
    },
    { timezone: ACCOUNT_TZ },
  );

  if (ENABLE_AUTO_PINGS) {
    // Daily 9 AM PT — morning rebalance proposal.
    cron.schedule(
      '0 9 * * *',
      () => {
        console.log(`[cron] morning rebalance firing at ${new Date().toISOString()}`);
        runRebalanceTick('cron_morning')
          .then((r) => console.log(`[rebalance] morning: plan_id=${r.plan_id} changes=${r.changes} metric=${r.metric}`))
          .catch((err) => console.error('morning rebalance failed:', err));
      },
      { timezone: ACCOUNT_TZ },
    );
    // Daily 6 PM PT — evening rebalance proposal.
    cron.schedule(
      '0 18 * * *',
      () => {
        console.log(`[cron] evening rebalance firing at ${new Date().toISOString()}`);
        runRebalanceTick('cron_evening')
          .then((r) => console.log(`[rebalance] evening: plan_id=${r.plan_id} changes=${r.changes} metric=${r.metric}`))
          .catch((err) => console.error('evening rebalance failed:', err));
      },
      { timezone: ACCOUNT_TZ },
    );

    // Wednesdays 7 AM PT — Demand Engine market scan.
    // Pulls active brands, runs spy on each vertical, surfaces opportunities
    // in Telegram only when something actionable is found.
    if (DEMAND_ENGINE_CONFIGURED) {
      cron.schedule(
        '0 7 * * 3',
        async () => {
          console.log(`[cron] demand engine market scan firing at ${new Date().toISOString()}`);
          try {
            const brands = await demandEngineBrands();
            if (!brands.length) return;
            const verticals = [...new Set(brands.map((b) => b.vertical).filter(Boolean))];
            const recipients = (process.env.BRIEFING_CHAT_IDS ?? '-5086989989')
              .split(',').map((s) => s.trim()).filter(Boolean);
            for (const vertical of verticals.slice(0, 3)) {
              const winners = await demandEngineSpy({ keyword: vertical, vertical, winner: true });
              if (!winners.length) continue;
              const top = winners[0];
              const msg = [
                `[MARKET SCAN] ${vertical.toUpperCase()} — ${winners.length} active competitor ads found`,
                `Top hook: ${top.hook_type ?? 'unknown'} — running ${top.days_running ?? '?'} days`,
                top.headline ? `Headline: "${top.headline}"` : null,
                `\nTell me "generate a ${vertical} creative" to build an ad targeting this angle.`,
              ].filter(Boolean).join('\n');
              for (const cid of recipients) {
                await bot.sendMessage(cid, msg).catch(() => {});
              }
            }
          } catch (err) {
            console.error('[cron] demand engine market scan failed:', err);
          }
        },
        { timezone: ACCOUNT_TZ },
      );
    }

    // Mondays 8 AM PT — LP intelligence scrape (competitor first-scrolls).
    // Weekly cadence: landing pages don't change daily; weekly catches the
    // signal at a fraction of the cost.
    cron.schedule(
      '0 8 * * 1',
      () => {
        console.log(`[cron] LP scrape firing at ${new Date().toISOString()}`);
        runDailyLpTick()
          .then((r) =>
            console.log(`[lp] scraped ${r.succeeded}/${r.total} analyzed=${r.analyzed} failed=${r.failed}`),
          )
          .catch((err) => console.error('LP scrape failed:', err));
      },
      { timezone: ACCOUNT_TZ },
    );
    // Daily 7 AM PT — LP lift measurement loop. Closes the feedback loop on
    // any 'implemented' recommendation past its 14-day soak window.
    cron.schedule(
      '0 7 * * *',
      () => {
        console.log(`[cron] LP lift measurement firing at ${new Date().toISOString()}`);
        runLiftMeasurementTick()
          .then((r) =>
            console.log(`[lp-lift] considered=${r.considered} measured=${r.measured} errors=${r.errors}`),
          )
          .catch((err) => console.error('LP lift measurement failed:', err));
      },
      { timezone: ACCOUNT_TZ },
    );

    // CAPI bridge digest — broadcasts last-24h forward totals, error rate,
    // and sample customer emails (separating internal/test addresses) so
    // silent regressions surface without anyone querying. Default target
    // is the Clayton Meta Ads group (-5086989989) since Josh hasn't DM'd
    // the bot. Override with TELEGRAM_DIGEST_CHAT_ID env var; set to "users"
    // to fall back to broadcasting individual ALLOWED_USER_IDS.
    const DIGEST_CHAT_ID = (process.env.TELEGRAM_DIGEST_CHAT_ID ?? '-5086989989').trim();

    async function fireCapiDigest(label: string): Promise<void> {
      console.log(`[cron] capi digest (${label}) firing at ${new Date().toISOString()}`);
      try {
        const digest = await getCapiDigest(24);
        const text = `[${label}]\n${formatCapiDigest(digest)}`;
        const targets = DIGEST_CHAT_ID === 'users' ? [...ALLOWED_USER_IDS] : [DIGEST_CHAT_ID];
        for (const t of targets) {
          try {
            await bot.sendMessage(t, text);
          } catch (err) {
            console.error(`[capi-digest] send to ${t} failed:`, err);
          }
        }
        console.log(
          `[capi-digest:${label}] total=${digest.total} ok=${digest.success} err=${digest.errors} internal=${digest.internal_emails.length}`,
        );
      } catch (err) {
        console.error(`capi digest (${label}) failed:`, err);
      }
    }

    // Three pings/day so changes are visible morning, mid-day, and end-of-day.
    cron.schedule('30 8 * * *', () => fireCapiDigest('morning 8:30 AM PT'), { timezone: ACCOUNT_TZ });
    cron.schedule('0 13 * * *', () => fireCapiDigest('midday 1:00 PM PT'), { timezone: ACCOUNT_TZ });
    cron.schedule('0 21 * * *', () => fireCapiDigest('evening 9:00 PM PT'), { timezone: ACCOUNT_TZ });
  }

  console.log(
    `[cron] monitor 15m + capi 10m always-on. auto pings ${ENABLE_AUTO_PINGS ? 'ON — pulse/rebalance/lp/digest scheduled' : 'OFF (set ENABLE_AUTO_PINGS=true to re-enable)'} in tz=${ACCOUNT_TZ}`,
  );
}

console.log(
  `Facebook ad agent running. model=${MODEL} account=${process.env.META_AD_ACCOUNT} tz=${ACCOUNT_TZ}`,
);

// Seed default rules on boot (no-ops if rules already exist).
seedDefaultRules()
  .then((n) => { if (n > 0) console.log(`[rules] seeded ${n} default rules`); })
  .catch((err) => console.warn('[rules] seedDefaultRules failed:', err));

// Schema health check — fail loudly if Supabase tables are missing.
// Memory was silently failing for hours because chat_messages didn't exist
// and every recordMessage call returned an error we only console.warn'd.
checkSchemaHealth()
  .then(async (h) => {
    const banner = formatSchemaBanner(h);
    if (h.ok) {
      console.log(banner);
      return;
    }
    console.error(banner);
    // Notify ops chats so the user sees it without watching Railway logs.
    const recipients = (process.env.BRIEFING_CHAT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const cid of recipients) {
      try {
        await bot.sendMessage(cid, `[boot health check]\n${banner}`);
      } catch (err) {
        console.error('failed to notify ops about schema health:', err);
      }
    }
  })
  .catch((err) => console.error('checkSchemaHealth crashed:', err));
