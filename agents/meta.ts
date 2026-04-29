import 'dotenv/config';
import axios, { type AxiosInstance } from 'axios';

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT = process.env.META_AD_ACCOUNT;

if (!ACCESS_TOKEN || !AD_ACCOUNT) {
  throw new Error('META_ACCESS_TOKEN and META_AD_ACCOUNT must be set');
}

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

const LEAD_ACTION_TYPES = new Set([
  'lead',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
]);

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
  const { data } = await meta.post(`/${campaignId}`, null, {
    params: { status: 'PAUSED' },
  });
  return data;
}

export async function resumeCampaign(campaignId: string): Promise<unknown> {
  const { data } = await meta.post(`/${campaignId}`, null, {
    params: { status: 'ACTIVE' },
  });
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
