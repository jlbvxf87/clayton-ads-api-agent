import 'dotenv/config';
import axios from 'axios';

const BASE_URL = (process.env.DEMAND_ENGINE_URL ?? '').replace(/\/$/, '');
const API_KEY = process.env.MACHINE_API_KEY ?? '';

if (!BASE_URL || !API_KEY) {
  console.warn('[DEMAND ENGINE] DEMAND_ENGINE_URL or MACHINE_API_KEY not set — Demand Engine tools unavailable.');
}

const client = axios.create({
  baseURL: BASE_URL,
  headers: { 'x-machine-key': API_KEY, 'Content-Type': 'application/json' },
  timeout: 30_000,
});

export const DEMAND_ENGINE_CONFIGURED = Boolean(BASE_URL && API_KEY);

// ---------- Types ----------

export interface Brand {
  slug: string;
  name: string;
  vertical: string;
  domain?: string;
  angle?: string;
  traffic_type?: string;
}

export interface SpyResult {
  advertiser?: string;
  headline?: string;
  body?: string;
  cta?: string;
  hook_type?: string;
  psychology?: string;
  landing_page?: string;
  days_running?: number;
  spend_estimate?: string;
  image_url?: string;
  ad_id?: string;
  [key: string]: unknown;
}

export interface GeneratedAd {
  headline: string;
  body: string;
  cta: string;
  image_url: string;
  creative_id?: string;
  hook_type?: string;
  [key: string]: unknown;
}

export interface BuiltPage {
  page_url: string;
  slug?: string;
  brand_slug?: string;
  [key: string]: unknown;
}

// ---------- API functions ----------

export async function demandEngineBrands(): Promise<Brand[]> {
  const { data } = await client.get('/api/machine/brands');
  return (data?.brands ?? data ?? []) as Brand[];
}

export async function demandEngineSpy(args: {
  keyword: string;
  vertical: string;
  winner?: boolean;
}): Promise<SpyResult[]> {
  const { data } = await client.post('/api/machine/spy/search', args);
  return (data?.results ?? data ?? []) as SpyResult[];
}

export async function demandEngineGenerate(args: {
  brandSlug: string;
  vertical: string;
  hookType: string;
  landingPage: string;
  referenceAd?: Partial<SpyResult>;
}): Promise<GeneratedAd> {
  const { data } = await client.post('/api/machine/generate-ad', args);
  return data as GeneratedAd;
}

export async function demandEngineBuildPage(args: {
  brandSlug: string;
  funnelType: string;
  referenceIntel?: string;
}): Promise<BuiltPage> {
  const { data } = await client.post('/api/machine/build-page', args);
  return data as BuiltPage;
}
