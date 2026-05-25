import 'dotenv/config';
import axios, { type AxiosInstance } from 'axios';

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_RAW = process.env.META_AD_ACCOUNT;

if (!ACCESS_TOKEN || !AD_ACCOUNT_RAW) {
  throw new Error('META_ACCESS_TOKEN and META_AD_ACCOUNT must be set');
}

// Multi-account support — comma-separated list. First entry is the default.
export const AD_ACCOUNTS: string[] = AD_ACCOUNT_RAW.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_AD_ACCOUNT = AD_ACCOUNTS[0];

// Resolve "act_xxx" or short alias to a full ID. If missing, returns default.
export function resolveAdAccount(accountId?: string): string {
  if (!accountId) return DEFAULT_AD_ACCOUNT;
  const trimmed = accountId.trim();
  if (!trimmed) return DEFAULT_AD_ACCOUNT;
  const match = AD_ACCOUNTS.find((a) => a === trimmed || a === `act_${trimmed}`);
  return match ?? DEFAULT_AD_ACCOUNT;
}

// Backward-compat alias used throughout the file.
const AD_ACCOUNT = DEFAULT_AD_ACCOUNT;

const META_API_VERSION = 'v21.0';
const baseURL = `https://graph.facebook.com/${META_API_VERSION}`;

const meta: AxiosInstance = axios.create({
  baseURL,
  params: { access_token: ACCESS_TOKEN },
  timeout: 30_000,
});

export interface Campaign {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  objective?: string;
  daily_budget?: string;       // smallest currency unit (cents in USD accounts)
  lifetime_budget?: string;
  budget_remaining?: string;
}

export interface CampaignInsight {
  campaign_id: string;
  campaign_name: string;
  spend: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  frequency?: string;
  actions?: Array<{ action_type: string; value: string }>;
}

export interface AdSet {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  campaign_id?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  targeting?: Record<string, unknown>;
}

export interface Ad {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  adset_id?: string;
  campaign_id?: string;
  creative?: AdCreative;
  preview_shareable_link?: string;
}

export interface AdCreative {
  id?: string;
  name?: string;
  title?: string;
  body?: string;
  image_url?: string;
  thumbnail_url?: string;
  video_id?: string;
  object_type?: string;
  call_to_action_type?: string;
  effective_object_story_id?: string;
}

export interface AdInsight {
  ad_id?: string;
  adset_id?: string;
  ad_name?: string;
  adset_name?: string;
  spend: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  frequency?: string;
  actions?: Array<{ action_type: string; value: string }>;
}

const CAMPAIGN_FIELDS = [
  'id',
  'name',
  'status',
  'effective_status',
  'objective',
  'daily_budget',
  'lifetime_budget',
  'budget_remaining',
].join(',');

const INSIGHT_FIELDS = [
  'campaign_id',
  'campaign_name',
  'spend',
  'impressions',
  'clicks',
  'ctr',
  'cpc',
  'cpm',
  'frequency',
  'actions',
].join(',');

async function paginated<T>(initialPath: string, params: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = initialPath;
  let p: Record<string, string> | undefined = params;
  while (url) {
    const { data } = await meta.get(url, { params: p });
    out.push(...((data.data ?? []) as T[]));
    const next = data.paging?.next as string | undefined;
    if (next) {
      url = next.replace(baseURL, '');
      p = undefined; // pagination URL already carries params
    } else {
      url = undefined;
    }
  }
  return out;
}

export async function listCampaigns(): Promise<Campaign[]> {
  return paginated<Campaign>(`/${AD_ACCOUNT}/campaigns`, {
    fields: CAMPAIGN_FIELDS,
    limit: '200',
  });
}

export async function getCampaign(campaignId: string): Promise<Campaign> {
  const { data } = await meta.get(`/${campaignId}`, {
    params: { fields: CAMPAIGN_FIELDS },
  });
  return data as Campaign;
}

export type DatePreset = 'today' | 'yesterday' | 'last_7d' | 'last_14d' | 'last_30d';

export async function getCampaignInsights(datePreset: DatePreset): Promise<CampaignInsight[]> {
  return paginated<CampaignInsight>(`/${AD_ACCOUNT}/insights`, {
    fields: INSIGHT_FIELDS,
    level: 'campaign',
    date_preset: datePreset,
    limit: '500',
  });
}

/**
 * Pull campaign insights for an arbitrary date window. Used by the
 * lift-measurement loop to compare 14d-pre vs 14d-post landing-page
 * deploys.
 */
export async function getCampaignInsightsRange(
  sinceIso: string, // 'YYYY-MM-DD'
  untilIso: string, // 'YYYY-MM-DD' (inclusive)
): Promise<CampaignInsight[]> {
  return paginated<CampaignInsight>(`/${AD_ACCOUNT}/insights`, {
    fields: INSIGHT_FIELDS,
    level: 'campaign',
    time_range: JSON.stringify({ since: sinceIso, until: untilIso }),
    limit: '500',
  });
}

const LEAD_ACTION_TYPES = new Set([
  'lead',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
  // Claya uses custom pixel events instead of standard — "Request Submitted"
  // fires where standard "Lead" would. Meta reports custom events as
  // offsite_conversion.custom.{name_with_underscores}.
  'offsite_conversion.custom.Request_Submitted',
  'offsite_conversion.custom.request_submitted',
]);

// Every known Claya funnel event, keyed by Meta action_type.
// stage = funnel position (lower = earlier), isLead = counts toward CPL.
export const CLAYA_FUNNEL_STEPS: Record<string, { label: string; stage: number; isLead: boolean }> = {
  'offsite_conversion.custom.ViewedProofScreen': { label: 'Viewed Proof Screen', stage: 2, isLead: false },
  'offsite_conversion.custom.Request_Submitted':  { label: 'Request Submitted (Lead)', stage: 5, isLead: true },
  'offsite_conversion.custom.request_submitted':  { label: 'Request Submitted (Lead)', stage: 5, isLead: true },
  'offsite_conversion.custom.ATC01':              { label: 'Add to Cart', stage: 6, isLead: false },
  'offsite_conversion.custom.CKT01':              { label: 'Initiate Checkout', stage: 6, isLead: false },
  'offsite_conversion.custom.ADP01':              { label: 'Add Payment Info', stage: 7, isLead: false },
  'offsite_conversion.custom.Payment_completed':  { label: 'Payment Completed', stage: 8, isLead: false },
};

// Returns every funnel step count seen in an insight row.
export function extractFunnelSteps(insight: CampaignInsight): Record<string, number> {
  const out: Record<string, number> = {};
  if (!insight.actions) return out;
  for (const a of insight.actions) {
    if (CLAYA_FUNNEL_STEPS[a.action_type]) {
      out[a.action_type] = (out[a.action_type] ?? 0) + (Number(a.value) || 0);
    }
  }
  return out;
}

export function extractLeads(insight: CampaignInsight): number {
  if (!insight.actions) return 0;
  let total = 0;
  for (const a of insight.actions) {
    if (LEAD_ACTION_TYPES.has(a.action_type)) total += Number(a.value) || 0;
  }
  return total;
}

export async function getAccountTimezone(): Promise<string> {
  const { data } = await meta.get(`/${AD_ACCOUNT}`, {
    params: { fields: 'timezone_name' },
  });
  return data.timezone_name as string;
}

export async function pauseCampaign(campaignId: string): Promise<unknown> {
  try {
    const { data } = await meta.post(`/${campaignId}`, null, {
      params: { status: 'PAUSED' },
    });
    return data;
  } catch (err: unknown) {
    // Surface the actual Meta error code/message, not just the HTTP status.
    const metaError = (err as { response?: { data?: { error?: { code?: number; message?: string; error_subcode?: number } } } })?.response?.data?.error;
    if (metaError) {
      throw new Error(`Meta API error ${metaError.code ?? '?'}${metaError.error_subcode ? '/' + metaError.error_subcode : ''}: ${metaError.message ?? 'unknown'}`);
    }
    throw err;
  }
}

export async function resumeCampaign(campaignId: string): Promise<unknown> {
  const { data } = await meta.post(`/${campaignId}`, null, {
    params: { status: 'ACTIVE' },
  });
  return data;
}

export async function setAdSetStatus(adSetId: string, status: 'ACTIVE' | 'PAUSED'): Promise<unknown> {
  const { data } = await meta.post(`/${adSetId}`, null, { params: { status } });
  return data;
}

export async function setAdStatus(adId: string, status: 'ACTIVE' | 'PAUSED'): Promise<unknown> {
  const { data } = await meta.post(`/${adId}`, null, { params: { status } });
  return data;
}

// daily budget in cents (smallest currency unit for USD accounts)
export async function setDailyBudget(campaignId: string, dailyBudgetCents: number): Promise<unknown> {
  if (!Number.isInteger(dailyBudgetCents) || dailyBudgetCents <= 0) {
    throw new Error('dailyBudgetCents must be a positive integer (cents)');
  }
  const { data } = await meta.post(`/${campaignId}`, null, {
    params: { daily_budget: String(dailyBudgetCents) },
  });
  return data;
}

// ---------- Ad set / ad / creative drill-downs ----------

const ADSET_FIELDS = [
  'id',
  'name',
  'status',
  'effective_status',
  'campaign_id',
  'daily_budget',
  'lifetime_budget',
  'optimization_goal',
  'billing_event',
  'bid_strategy',
].join(',');

const AD_FIELDS = [
  'id',
  'name',
  'status',
  'effective_status',
  'adset_id',
  'campaign_id',
  'preview_shareable_link',
  'creative{id,name,title,body,image_url,thumbnail_url,video_id,object_type,call_to_action_type,effective_object_story_id}',
].join(',');

const AD_INSIGHT_FIELDS_AD = [
  'ad_id',
  'ad_name',
  'spend',
  'impressions',
  'clicks',
  'ctr',
  'cpc',
  'cpm',
  'frequency',
  'actions',
].join(',');

const AD_INSIGHT_FIELDS_ADSET = [
  'adset_id',
  'adset_name',
  'spend',
  'impressions',
  'clicks',
  'ctr',
  'cpc',
  'cpm',
  'frequency',
  'actions',
].join(',');

export async function listAdSets(parentId?: string): Promise<AdSet[]> {
  // parentId may be a campaign id (drill from campaign) or omitted (account-wide)
  const path = parentId ? `/${parentId}/adsets` : `/${AD_ACCOUNT}/adsets`;
  return paginated<AdSet>(path, { fields: ADSET_FIELDS, limit: '200' });
}

export async function listAds(parentId?: string): Promise<Ad[]> {
  // parentId may be a campaign or ad set id (drill from either) or omitted (account-wide)
  const path = parentId ? `/${parentId}/ads` : `/${AD_ACCOUNT}/ads`;
  return paginated<Ad>(path, { fields: AD_FIELDS, limit: '200' });
}

export async function getAd(adId: string): Promise<Ad> {
  const { data } = await meta.get(`/${adId}`, { params: { fields: AD_FIELDS } });
  return data as Ad;
}

export async function getAdSet(adSetId: string): Promise<AdSet> {
  const { data } = await meta.get(`/${adSetId}`, { params: { fields: ADSET_FIELDS } });
  return data as AdSet;
}

export async function getAdSetInsights(
  parentId: string,
  datePreset: DatePreset,
): Promise<AdInsight[]> {
  return paginated<AdInsight>(`/${parentId}/insights`, {
    fields: AD_INSIGHT_FIELDS_ADSET,
    level: 'adset',
    date_preset: datePreset,
    limit: '500',
  });
}

export async function getAdInsights(
  parentId: string,
  datePreset: DatePreset,
): Promise<AdInsight[]> {
  return paginated<AdInsight>(`/${parentId}/insights`, {
    fields: AD_INSIGHT_FIELDS_AD,
    level: 'ad',
    date_preset: datePreset,
    limit: '500',
  });
}

// ---------- Full action-type breakdown (every action Meta records, not just leads) ----------

export interface ActionRow {
  action_type: string;
  value: number;
}

export interface ActionBreakdown {
  parent_id: string;
  parent_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpm: number | null;
  actions: ActionRow[];
}

const ACTION_BREAKDOWN_FIELDS_BY_LEVEL: Record<'campaign' | 'adset' | 'ad', string> = {
  campaign: 'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpm,actions',
  adset: 'adset_id,adset_name,spend,impressions,clicks,ctr,cpm,actions',
  ad: 'ad_id,ad_name,spend,impressions,clicks,ctr,cpm,actions',
};

/**
 * Pull a full action_type breakdown over a window. Returns every action Meta
 * records (PageView, ViewContent, AddPaymentInfo, InitiateCheckout, Lead,
 * Purchase, custom events) per entity at the chosen level. This is what
 * Clayton uses to answer screen/step-level questions — actions are how custom
 * funnel events show up via the Pixel.
 *
 * `parentId` may be null for account-wide.
 */
export async function getActionBreakdown(
  parentId: string | null,
  level: 'campaign' | 'adset' | 'ad',
  datePreset: DatePreset,
  accountId?: string,
): Promise<ActionBreakdown[]> {
  const path = parentId ? `/${parentId}/insights` : `/${resolveAdAccount(accountId)}/insights`;
  const rows = await paginated<Record<string, unknown>>(path, {
    fields: ACTION_BREAKDOWN_FIELDS_BY_LEVEL[level],
    level,
    date_preset: datePreset,
    limit: '500',
  });
  return rows.map((r) => {
    const idKey = level === 'campaign' ? 'campaign_id' : level === 'adset' ? 'adset_id' : 'ad_id';
    const nameKey = level === 'campaign' ? 'campaign_name' : level === 'adset' ? 'adset_name' : 'ad_name';
    const actions = (r.actions ?? []) as Array<{ action_type: string; value: string }>;
    return {
      parent_id: (r[idKey] as string) ?? '',
      parent_name: (r[nameKey] as string) ?? '',
      spend: Number(r.spend ?? 0),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      ctr: r.ctr != null ? Number(r.ctr) : null,
      cpm: r.cpm != null ? Number(r.cpm) : null,
      actions: actions.map((a) => ({ action_type: a.action_type, value: Number(a.value) || 0 })),
    };
  });
}

/**
 * Sum a specific action across an action breakdown — useful for totals.
 */
export function sumAction(breakdown: ActionBreakdown[], actionType: string): number {
  return breakdown.reduce((s, row) => {
    const found = row.actions.find((a) => a.action_type === actionType);
    return s + (found?.value ?? 0);
  }, 0);
}

// ---------- Creative editing (clone-with-modifications pattern) ----------

interface AdCreativeFull {
  id: string;
  name?: string;
  object_story_spec?: Record<string, unknown>;
  asset_feed_spec?: Record<string, unknown>;
  call_to_action_type?: string;
  title?: string;
  body?: string;
  url_tags?: string;
  link_url?: string;
  image_hash?: string;
  video_id?: string;
  thumbnail_url?: string;
  template_url?: string;
  effective_object_story_id?: string;
}

// ---------- Image upload + ad-from-image creation ----------

export interface UploadedImage {
  image_hash: string;
  url: string;
  width: number | null;
  height: number | null;
}

/**
 * Upload an image to the ad account's media library. Returns the
 * `image_hash` you can reference from `object_story_spec.link_data.image_hash`
 * when creating a new ad creative.
 *
 * Meta dedupes by content hash — uploading the same bytes twice returns the
 * same hash. Free, idempotent, and recommended dimensions are 1080x1080
 * (square), 1200x628 (landscape), or 1080x1350 (vertical 4:5).
 *
 * Healthcare ads: Meta's automated policy review still runs once you USE the
 * image in an ad. Upload doesn't trigger review; ad creation does. Flag
 * policy-sensitive imagery (before/after, body shots, weight-claim overlays)
 * before calling this — Meta will reject the ad post-create otherwise.
 */
export async function uploadImage(args: {
  bytes: Buffer | string;             // Buffer or base64 string
  mime_type?: string;                 // 'image/jpeg' | 'image/png' | 'image/gif'
  filename?: string;
  accountId?: string;
}): Promise<UploadedImage> {
  const acct = resolveAdAccount(args.accountId);
  const buffer = Buffer.isBuffer(args.bytes) ? args.bytes : Buffer.from(args.bytes, 'base64');
  if (buffer.length === 0) throw new Error('uploadImage: empty bytes');
  if (buffer.length > 8 * 1024 * 1024) {
    throw new Error(`uploadImage: image is ${(buffer.length / 1024 / 1024).toFixed(1)}MB, Meta limit is 8MB`);
  }

  // Meta accepts adimages via either `bytes` (base64 form field) or
  // multipart file upload. The base64 form is simpler over HTTPS and
  // doesn't require a multipart library — single POST.
  const filename = args.filename ?? `upload_${Date.now()}.jpg`;
  const form = new URLSearchParams();
  form.set('bytes', buffer.toString('base64'));
  form.set('name', filename);

  const { data } = await meta.post(`/${acct}/adimages`, form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    // Allow larger bodies — base64 inflates by ~33%, so an 8MB image is ~11MB encoded.
    maxBodyLength: 20 * 1024 * 1024,
    maxContentLength: 20 * 1024 * 1024,
  });

  // Response shape: { images: { "<keyed_by_filename_or_hash>": { hash, url, width, height } } }
  const images = (data?.images ?? {}) as Record<string, { hash?: string; url?: string; width?: number; height?: number }>;
  const first = Object.values(images)[0];
  if (!first?.hash) {
    throw new Error(`uploadImage: Meta did not return an image_hash. Response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return {
    image_hash: first.hash,
    url: first.url ?? '',
    width: first.width ?? null,
    height: first.height ?? null,
  };
}

interface CreateAdFromImageArgs {
  ad_set_id: string;                  // target ad set; new ad lands here as PAUSED
  image_hash: string;                 // from uploadImage()
  headline: string;                   // <= 40 chars recommended
  primary_text: string;               // the main body / "message" in link_data
  description?: string;               // optional secondary description text
  cta?: string;                       // 'APPLY_NOW' | 'LEARN_MORE' | 'SIGN_UP' | 'GET_QUOTE' | etc.
  link_url: string;                   // destination URL
  ad_name?: string;
  template_ad_id?: string;            // optional — borrow page_id + asset_feed_spec from a known-good ad
}

interface CreateAdFromImageResult {
  new_ad_id: string;
  new_creative_id: string;
  template_ad_id: string | null;
  page_id: string;
}

/**
 * Build a new ad from an uploaded image. Inherits the Facebook Page id
 * from a template ad (either an explicitly provided template_ad_id or the
 * first existing ad in the target ad set) — no page_id env needed since
 * the account always has running ads to borrow from.
 *
 * Always saves the new ad as PAUSED. The caller (or user via slash command)
 * must explicitly resume it before it goes live.
 */
export async function createAdFromImage(args: CreateAdFromImageArgs): Promise<CreateAdFromImageResult> {
  // 1. Find a template ad to inherit page_id from.
  let templateAdId = args.template_ad_id ?? null;
  if (!templateAdId) {
    const adsInSet = await listAds(args.ad_set_id);
    if (adsInSet.length === 0) {
      throw new Error(
        `createAdFromImage: ad set ${args.ad_set_id} has no existing ads to inherit page_id from. Pass template_ad_id explicitly (any ad in this account), or create the first ad of an ad set via Ads Manager UI.`,
      );
    }
    templateAdId = adsInSet[0].id;
  }

  // 2. Fetch the template's creative for the page_id and any link_data shape we should preserve.
  const templateAd = await getAd(templateAdId);
  if (!templateAd?.creative?.id) {
    throw new Error(`createAdFromImage: template ad ${templateAdId} has no creative attached`);
  }
  const templateCreative = await getCreative(templateAd.creative.id);
  const templateSpec = (templateCreative.object_story_spec ?? {}) as Record<string, unknown>;
  const pageId = (templateSpec.page_id as string) ?? null;
  if (!pageId) {
    throw new Error(
      `createAdFromImage: template ad ${templateAdId} has no page_id in its object_story_spec — Meta requires a Facebook Page to attach the new ad to. Try a different template ad.`,
    );
  }

  // 3. Build new object_story_spec from scratch (cleaner than mutating template).
  const linkData: Record<string, unknown> = {
    image_hash: args.image_hash,
    link: args.link_url,
    message: args.primary_text,
    name: args.headline,
  };
  if (args.description) linkData.description = args.description;
  if (args.cta) linkData.call_to_action = { type: args.cta, value: { link: args.link_url } };

  const objectStorySpec = {
    page_id: pageId,
    link_data: linkData,
  };

  // 4. Create the new creative.
  const newCreativeName = `${args.ad_name ?? 'image-upload'} — ${new Date().toISOString().slice(0, 10)}`;
  const { data: newCreative } = await meta.post(
    `/${resolveAdAccount()}/adcreatives`,
    null,
    {
      params: {
        name: newCreativeName,
        object_story_spec: JSON.stringify(objectStorySpec),
      },
    },
  );
  const newCreativeId = newCreative?.id as string;
  if (!newCreativeId) throw new Error('createAdFromImage: creative creation returned no id');

  // 5. Create the new ad — PAUSED.
  const newAdName = args.ad_name ?? `image-upload ${new Date().toISOString().slice(0, 10)}`;
  const { data: newAd } = await meta.post(
    `/${resolveAdAccount()}/ads`,
    null,
    {
      params: {
        name: newAdName,
        adset_id: args.ad_set_id,
        creative: JSON.stringify({ creative_id: newCreativeId }),
        status: 'PAUSED',
      },
    },
  );
  if (!newAd?.id) throw new Error('createAdFromImage: ad creation returned no id');

  return {
    new_ad_id: newAd.id as string,
    new_creative_id: newCreativeId,
    template_ad_id: templateAdId,
    page_id: pageId,
  };
}

export async function getCreative(creativeId: string): Promise<AdCreativeFull> {
  const fields = [
    'id',
    'name',
    'object_story_spec',
    'asset_feed_spec',
    'call_to_action_type',
    'title',
    'body',
    'url_tags',
    'link_url',
    'image_hash',
    'video_id',
    'thumbnail_url',
    'template_url',
    'effective_object_story_id',
  ].join(',');
  const { data } = await meta.get(`/${creativeId}`, { params: { fields } });
  return data as AdCreativeFull;
}

interface CloneAdWithCopyArgs {
  ad_id: string;
  new_headline?: string;
  new_body?: string;
  new_cta?: string;
  new_link_url?: string;
  new_ad_name?: string;
}

interface CloneAdResult {
  new_ad_id: string;
  new_creative_id: string;
  source_ad_id: string;
  source_ad_name: string;
  changes: Record<string, { from: unknown; to: unknown }>;
}

/**
 * Clone an existing ad, optionally swapping headline / body / CTA / link url,
 * and save the result as PAUSED. Original ad is untouched.
 *
 * Strategy: fetch the source ad's creative.object_story_spec, clone-with-mutations
 * into a new creative, then create a new ad pointing at the new creative.
 */
export async function cloneAdWithNewCopy(args: CloneAdWithCopyArgs): Promise<CloneAdResult> {
  // 1. Fetch the source ad with creative
  const adFields = [
    'id',
    'name',
    'adset_id',
    'creative{id}',
  ].join(',');
  const { data: srcAd } = await meta.get(`/${args.ad_id}`, { params: { fields: adFields } });

  if (!srcAd?.creative?.id) {
    throw new Error(`Source ad ${args.ad_id} has no creative attached`);
  }

  // 2. Fetch the full creative
  const srcCreative = await getCreative(srcAd.creative.id);

  // 3. Build the new creative payload by cloning + modifying object_story_spec
  // We mutate link_data fields where possible; otherwise fall back to top-level fields.
  const objectStorySpec: Record<string, unknown> = JSON.parse(
    JSON.stringify(srcCreative.object_story_spec ?? {}),
  );

  const changes: Record<string, { from: unknown; to: unknown }> = {};

  const linkData = (objectStorySpec.link_data as Record<string, unknown> | undefined) ?? null;
  const videoData = (objectStorySpec.video_data as Record<string, unknown> | undefined) ?? null;
  const target = linkData ?? videoData ?? null;

  if (args.new_headline) {
    if (target) {
      changes.headline = { from: target.name ?? srcCreative.title ?? null, to: args.new_headline };
      target.name = args.new_headline;
    } else {
      changes.headline = { from: srcCreative.title ?? null, to: args.new_headline };
    }
  }
  if (args.new_body) {
    if (target) {
      changes.body = { from: target.message ?? srcCreative.body ?? null, to: args.new_body };
      target.message = args.new_body;
    } else {
      changes.body = { from: srcCreative.body ?? null, to: args.new_body };
    }
  }
  if (args.new_cta) {
    const cta = (target?.call_to_action as Record<string, unknown> | undefined) ?? null;
    changes.cta = { from: cta?.type ?? srcCreative.call_to_action_type ?? null, to: args.new_cta };
    if (target) {
      target.call_to_action = { ...(cta ?? {}), type: args.new_cta };
    }
  }
  if (args.new_link_url) {
    if (target) {
      changes.link_url = { from: target.link ?? srcCreative.link_url ?? null, to: args.new_link_url };
      target.link = args.new_link_url;
    }
  }

  // 4. Create the new creative
  const newCreativeName = `${srcCreative.name ?? 'creative'} — edited ${new Date().toISOString().slice(0, 10)}`;
  const creativePayload: Record<string, unknown> = {
    name: newCreativeName,
    object_story_spec: objectStorySpec,
  };
  // Preserve top-level fields where useful (Meta accepts both)
  if (args.new_headline && !linkData && !videoData) creativePayload.title = args.new_headline;
  if (args.new_body && !linkData && !videoData) creativePayload.body = args.new_body;
  if (args.new_cta && !linkData && !videoData) creativePayload.call_to_action_type = args.new_cta;

  const { data: newCreative } = await meta.post(
    `/${AD_ACCOUNT}/adcreatives`,
    null,
    { params: creativePayload },
  );
  const newCreativeId = newCreative?.id as string;
  if (!newCreativeId) throw new Error('Failed to create new creative');

  // 5. Create the new ad as PAUSED, attached to the same ad set
  const newAdName = args.new_ad_name ?? `${srcAd.name} — edited ${new Date().toISOString().slice(0, 10)}`;
  const adPayload: Record<string, unknown> = {
    name: newAdName,
    adset_id: srcAd.adset_id,
    creative: JSON.stringify({ creative_id: newCreativeId }),
    status: 'PAUSED',
  };
  const { data: newAd } = await meta.post(`/${AD_ACCOUNT}/ads`, null, { params: adPayload });
  if (!newAd?.id) throw new Error('Failed to create new ad');

  return {
    new_ad_id: newAd.id,
    new_creative_id: newCreativeId,
    source_ad_id: args.ad_id,
    source_ad_name: srcAd.name,
    changes,
  };
}

// ---------- Campaign / ad set / ad creation (always PAUSED) ----------

interface CreateCampaignArgs {
  name: string;
  objective: string;          // e.g. 'OUTCOME_LEADS','OUTCOME_SALES','OUTCOME_TRAFFIC','OUTCOME_AWARENESS','OUTCOME_ENGAGEMENT','OUTCOME_APP_PROMOTION'
  special_ad_categories?: string[];
  daily_budget_cents?: number;     // optional CBO daily budget at the campaign level
  buying_type?: 'AUCTION' | 'RESERVED';
}

const NEW_BUDGET_CAP_CENTS = 50_000;       // $500/day hard cap on creation
const NEW_BUDGET_FLOOR_CENTS = 500;        // $5/day floor

export async function createCampaign(args: CreateCampaignArgs): Promise<{ id: string; payload: Record<string, unknown> }> {
  if (args.daily_budget_cents != null) {
    if (args.daily_budget_cents < NEW_BUDGET_FLOOR_CENTS)
      throw new Error(`daily_budget below $${NEW_BUDGET_FLOOR_CENTS / 100} floor`);
    if (args.daily_budget_cents > NEW_BUDGET_CAP_CENTS)
      throw new Error(`daily_budget exceeds $${NEW_BUDGET_CAP_CENTS / 100} per-creation cap`);
  }
  const payload: Record<string, unknown> = {
    name: args.name,
    objective: args.objective,
    status: 'PAUSED',
    special_ad_categories: JSON.stringify(args.special_ad_categories ?? []),
    buying_type: args.buying_type ?? 'AUCTION',
  };
  if (args.daily_budget_cents != null) payload.daily_budget = String(args.daily_budget_cents);

  const { data } = await meta.post(`/${AD_ACCOUNT}/campaigns`, null, { params: payload });
  if (!data?.id) throw new Error('Campaign creation returned no id');
  return { id: data.id as string, payload };
}

interface CreateAdSetArgs {
  campaign_id: string;
  name: string;
  daily_budget_cents?: number;
  optimization_goal: string;       // e.g. 'OFFSITE_CONVERSIONS','LEAD_GENERATION','LINK_CLICKS','REACH'
  billing_event?: string;          // default 'IMPRESSIONS'
  bid_strategy?: string;           // 'LOWEST_COST_WITHOUT_CAP','LOWEST_COST_WITH_BID_CAP','COST_CAP'
  targeting: Record<string, unknown>;
  start_time?: string;             // ISO; default now
  promoted_object?: Record<string, unknown>; // for conversion goals: { pixel_id, custom_event_type }
}

export async function createAdSet(args: CreateAdSetArgs): Promise<{ id: string; payload: Record<string, unknown> }> {
  if (args.daily_budget_cents != null) {
    if (args.daily_budget_cents < NEW_BUDGET_FLOOR_CENTS)
      throw new Error(`daily_budget below $${NEW_BUDGET_FLOOR_CENTS / 100} floor`);
    if (args.daily_budget_cents > NEW_BUDGET_CAP_CENTS)
      throw new Error(`daily_budget exceeds $${NEW_BUDGET_CAP_CENTS / 100} per-creation cap`);
  }
  const payload: Record<string, unknown> = {
    name: args.name,
    campaign_id: args.campaign_id,
    status: 'PAUSED',
    optimization_goal: args.optimization_goal,
    billing_event: args.billing_event ?? 'IMPRESSIONS',
    bid_strategy: args.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP',
    targeting: JSON.stringify(args.targeting),
  };
  if (args.daily_budget_cents != null) payload.daily_budget = String(args.daily_budget_cents);
  if (args.start_time) payload.start_time = args.start_time;
  if (args.promoted_object) payload.promoted_object = JSON.stringify(args.promoted_object);

  const { data } = await meta.post(`/${AD_ACCOUNT}/adsets`, null, { params: payload });
  if (!data?.id) throw new Error('Ad set creation returned no id');
  return { id: data.id as string, payload };
}

interface CreateAdArgs {
  adset_id: string;
  name: string;
  creative_id: string;
}

export async function createAd(args: CreateAdArgs): Promise<{ id: string }> {
  const payload: Record<string, unknown> = {
    name: args.name,
    adset_id: args.adset_id,
    creative: JSON.stringify({ creative_id: args.creative_id }),
    status: 'PAUSED',
  };
  const { data } = await meta.post(`/${AD_ACCOUNT}/ads`, null, { params: payload });
  if (!data?.id) throw new Error('Ad creation returned no id');
  return { id: data.id as string };
}

// ---------- Targeting reads + writes ----------

export async function getAdSetTargeting(adSetId: string): Promise<Record<string, unknown> | null> {
  const { data } = await meta.get(`/${adSetId}`, { params: { fields: 'targeting' } });
  return (data?.targeting as Record<string, unknown>) ?? null;
}

export async function updateAdSetTargeting(
  adSetId: string,
  newTargeting: Record<string, unknown>,
): Promise<unknown> {
  // Verify the ad set is PAUSED before touching targeting (high-blast-radius write).
  const { data: current } = await meta.get(`/${adSetId}`, {
    params: { fields: 'effective_status,status,name' },
  });
  const status = (current?.effective_status ?? current?.status) as string;
  if (status === 'ACTIVE') {
    throw new Error(
      `Refusing to modify targeting on ACTIVE ad set "${current?.name ?? adSetId}" (status=${status}). Pause it first.`,
    );
  }
  const { data } = await meta.post(`/${adSetId}`, null, {
    params: { targeting: JSON.stringify(newTargeting) },
  });
  return data;
}

export interface CustomAudience {
  id: string;
  name: string;
  description?: string;
  approximate_count?: number;
  subtype?: string;
  retention_days?: number;
}

export async function listCustomAudiences(accountId?: string): Promise<CustomAudience[]> {
  const acct = resolveAdAccount(accountId);
  return paginated<CustomAudience>(`/${acct}/customaudiences`, {
    fields: 'id,name,description,approximate_count,subtype,retention_days',
    limit: '100',
  });
}

export async function createLookalikeAudience(args: {
  name: string;
  source_audience_id: string;
  ratio: number;          // 0.01 (1%) to 0.20 (20%); ratio is decimal
  country: string;        // e.g. 'US'
}): Promise<{ id: string }> {
  if (args.ratio < 0.01 || args.ratio > 0.2) {
    throw new Error('ratio must be between 0.01 (1%) and 0.20 (20%)');
  }
  const lookalikeSpec = {
    type: 'similarity',
    ratio: args.ratio,
    country: args.country,
  };
  const { data } = await meta.post(`/${AD_ACCOUNT}/customaudiences`, null, {
    params: {
      name: args.name,
      subtype: 'LOOKALIKE',
      origin_audience_id: args.source_audience_id,
      lookalike_spec: JSON.stringify(lookalikeSpec),
    },
  });
  if (!data?.id) throw new Error('Lookalike creation returned no id');
  return { id: data.id as string };
}

// ---------- Pixel / Events Manager ----------

export interface AdsPixel {
  id: string;
  name: string;
  code?: string;
  creation_time?: string;
  last_fired_time?: string;
  is_unavailable?: boolean;
}

export async function listPixels(accountId?: string): Promise<AdsPixel[]> {
  const acct = resolveAdAccount(accountId);
  return paginated<AdsPixel>(`/${acct}/adspixels`, {
    fields: 'id,name,code,creation_time,last_fired_time,is_unavailable',
    limit: '50',
  });
}

export async function getPixel(pixelId: string): Promise<AdsPixel> {
  const { data } = await meta.get(`/${pixelId}`, {
    params: { fields: 'id,name,code,creation_time,last_fired_time,is_unavailable' },
  });
  return data as AdsPixel;
}

export interface PixelEventStat {
  event: string;
  event_total_count?: number;
  custom_conversions?: unknown;
}

export async function getPixelStats(
  pixelId: string,
  aggregation: 'event' | 'host' | 'browser_type' | 'pixel_fire' = 'event',
  startUnix?: number,
  endUnix?: number,
): Promise<PixelEventStat[]> {
  const params: Record<string, string> = { aggregation };
  if (startUnix) params.start_time = String(startUnix);
  if (endUnix) params.end_time = String(endUnix);
  const { data } = await meta.get(`/${pixelId}/stats`, { params });
  return (data?.data ?? []) as PixelEventStat[];
}

export interface PixelHealthSummary {
  pixel_id: string;
  pixel_name: string;
  last_fired_time: string | null;
  is_unavailable: boolean;
  hours_since_last_fire: number | null;
  events_seen: Array<{ event: string; count: number }>;
  diagnosis: string;
}

export async function getPixelHealth(pixelId?: string): Promise<PixelHealthSummary[]> {
  const pixels = pixelId ? [await getPixel(pixelId)] : await listPixels();
  const out: PixelHealthSummary[] = [];

  // Default: look at the last 7 days of pixel events. Without a time range,
  // Meta's `/stats?aggregation=event` returns aggregated lifetime data which
  // for newer pixels is sometimes empty. Explicit recent window surfaces
  // per-event counts reliably.
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 86400;

  for (const p of pixels) {
    let stats: PixelEventStat[] = [];
    try {
      stats = await getPixelStats(p.id, 'event', sevenDaysAgo, now);
    } catch {
      // Some pixels don't expose stats with time range; fall back to no-range
      try {
        stats = await getPixelStats(p.id, 'event');
      } catch {
        // ignore
      }
    }
    const lastFired = p.last_fired_time ? new Date(p.last_fired_time) : null;
    const hoursSince = lastFired
      ? Math.round((Date.now() - lastFired.getTime()) / 3600000)
      : null;

    let diagnosis = 'OK';
    if (p.is_unavailable) diagnosis = 'pixel marked unavailable by Meta';
    else if (hoursSince == null) diagnosis = 'no last_fired_time on record';
    else if (hoursSince > 168) diagnosis = `cold — last fired ${hoursSince}h ago (>1 week)`;
    else if (hoursSince > 48) diagnosis = `warm — last fired ${hoursSince}h ago`;
    else diagnosis = `live — last fired ${hoursSince}h ago`;

    out.push({
      pixel_id: p.id,
      pixel_name: p.name,
      last_fired_time: p.last_fired_time ?? null,
      is_unavailable: p.is_unavailable ?? false,
      hours_since_last_fire: hoursSince,
      events_seen: stats
        .map((s) => ({ event: s.event, count: Number(s.event_total_count ?? 0) }))
        .filter((s) => Number.isFinite(s.count) && s.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      diagnosis,
    });
  }
  return out;
}
