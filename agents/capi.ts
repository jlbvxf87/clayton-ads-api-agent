import 'dotenv/config';
import crypto from 'node:crypto';
import axios from 'axios';
import { supabase } from './supabase.js';
import { cioListActivities, cioGetCustomer, type CioActivity } from './customerio.js';

const META_GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const META_TOKEN = process.env.META_ACCESS_TOKEN;

if (!META_TOKEN) {
  // Don't throw — allow other modules to import this without crashing the bot.
  console.warn('[CAPI] META_ACCESS_TOKEN not set — CAPI sends will fail until configured.');
}

// ---------- Types ----------

export interface CapiConfig {
  id: number;
  pixel_id: string | null;
  enabled: boolean;
  default_action_source: string;
  default_event_source_url: string | null;
  test_event_code: string | null;
  notes: string | null;
  updated_at: string;
  updated_by_user_id: string | null;
  updated_by_username: string | null;
}

export interface CapiEventMap {
  id: number;
  cio_event_name: string;
  meta_event_name: string;
  action_source: string;
  enabled: boolean;
  config: Record<string, unknown>;
  notes: string | null;
}

export interface CapiForward {
  id: number;
  created_at: string;
  cio_activity_id: string;
  cio_event_name: string;
  meta_event_name: string;
  pixel_id: string;
  meta_event_id: string;
  customer_id: string | null;
  customer_email: string | null;
  event_time: number | null;
  success: boolean;
  http_status: number | null;
  meta_response: unknown;
  error_message: string | null;
}

// ---------- Hashing per Meta CAPI spec ----------

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function hashEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return sha256Hex(raw.trim().toLowerCase());
}

export function hashPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  return sha256Hex(digits);
}

export function hashName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return sha256Hex(raw.trim().toLowerCase());
}

// ---------- Config + mapping reads/writes ----------

export async function getCapiConfig(): Promise<CapiConfig> {
  const { data, error } = await supabase.from('capi_config').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(`getCapiConfig: ${error.message}`);
  if (!data) {
    // Lazy-init the singleton row in case migration ran without the seed insert.
    const { data: inserted, error: insErr } = await supabase
      .from('capi_config')
      .insert({ id: 1 })
      .select()
      .single();
    if (insErr) throw new Error(`getCapiConfig init: ${insErr.message}`);
    return inserted as CapiConfig;
  }
  return data as CapiConfig;
}

export async function updateCapiConfig(
  patch: Partial<Omit<CapiConfig, 'id' | 'updated_at'>>,
  by: { userId?: string | null; username?: string | null },
): Promise<CapiConfig> {
  const { data, error } = await supabase
    .from('capi_config')
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
      updated_by_user_id: by.userId ?? null,
      updated_by_username: by.username ?? null,
    })
    .eq('id', 1)
    .select()
    .single();
  if (error || !data) throw new Error(`updateCapiConfig: ${error?.message}`);
  return data as CapiConfig;
}

export async function listEventMap(): Promise<CapiEventMap[]> {
  const { data, error } = await supabase
    .from('capi_event_map')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[CAPI] listEventMap failed:', error.message);
    return [];
  }
  return (data ?? []) as CapiEventMap[];
}

export async function upsertEventMap(args: {
  cio_event_name: string;
  meta_event_name: string;
  action_source?: string;
  enabled?: boolean;
  notes?: string | null;
}): Promise<CapiEventMap> {
  const row: Record<string, unknown> = {
    cio_event_name: args.cio_event_name,
    meta_event_name: args.meta_event_name,
    action_source: args.action_source ?? 'system_generated',
    enabled: args.enabled ?? true,
    notes: args.notes ?? null,
  };
  const { data, error } = await supabase
    .from('capi_event_map')
    .upsert(row, { onConflict: 'cio_event_name' })
    .select()
    .single();
  if (error || !data) throw new Error(`upsertEventMap: ${error?.message}`);
  return data as CapiEventMap;
}

export async function deleteEventMap(cioEventName: string): Promise<void> {
  const { error } = await supabase.from('capi_event_map').delete().eq('cio_event_name', cioEventName);
  if (error) throw new Error(`deleteEventMap: ${error.message}`);
}

// ---------- The CAPI POST itself ----------

export interface CapiUserData {
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  external_id?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbp?: string;
  fbc?: string;
}

export interface CapiEventPayload {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: string;
  event_source_url?: string;
  user_data: CapiUserData;
  custom_data?: Record<string, unknown>;
}

export async function postToMetaCapi(args: {
  pixel_id: string;
  events: CapiEventPayload[];
  test_event_code?: string | null;
}): Promise<{ http_status: number; body: unknown }> {
  if (!META_TOKEN) throw new Error('META_ACCESS_TOKEN not set');
  const url = `${META_GRAPH_BASE}/${args.pixel_id}/events`;
  const body: Record<string, unknown> = { data: args.events, access_token: META_TOKEN };
  if (args.test_event_code) body.test_event_code = args.test_event_code;
  const res = await axios.post(url, body, { validateStatus: () => true, timeout: 15_000 });
  return { http_status: res.status, body: res.data };
}

// ---------- Activity → CAPI event ----------

function buildEventId(activityId: string): string {
  return `cio:${activityId}`;
}

async function fetchCustomerForActivity(act: CioActivity): Promise<{
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  external_id: string | null;
}> {
  const cid = act.customer_id ?? act.cio_id ?? null;
  if (!cid) return { email: null, phone: null, first_name: null, last_name: null, external_id: null };
  const c = await cioGetCustomer(cid);
  if (!c) return { email: null, phone: null, first_name: null, last_name: null, external_id: null };
  const attrs = (c.attributes ?? {}) as Record<string, unknown>;
  const email =
    typeof c.email === 'string'
      ? c.email
      : typeof attrs.email === 'string'
        ? (attrs.email as string)
        : null;
  const phone =
    typeof attrs.phone === 'string'
      ? (attrs.phone as string)
      : typeof attrs.phone_number === 'string'
        ? (attrs.phone_number as string)
        : null;
  const first =
    typeof attrs.first_name === 'string'
      ? (attrs.first_name as string)
      : typeof attrs.firstname === 'string'
        ? (attrs.firstname as string)
        : null;
  const last =
    typeof attrs.last_name === 'string'
      ? (attrs.last_name as string)
      : typeof attrs.lastname === 'string'
        ? (attrs.lastname as string)
        : null;
  return { email, phone, first_name: first, last_name: last, external_id: cid };
}

export async function forwardActivity(
  act: CioActivity,
  map: CapiEventMap,
  cfg: CapiConfig,
): Promise<{ ok: boolean; meta_event_id: string; http_status: number; body: unknown; error?: string }> {
  if (!cfg.pixel_id) throw new Error('capi_config.pixel_id is not set');
  const cust = await fetchCustomerForActivity(act);
  const userData: CapiUserData = {};
  const em = hashEmail(cust.email);
  if (em) userData.em = [em];
  const ph = hashPhone(cust.phone);
  if (ph) userData.ph = [ph];
  const fn = hashName(cust.first_name);
  if (fn) userData.fn = [fn];
  const ln = hashName(cust.last_name);
  if (ln) userData.ln = [ln];
  if (cust.external_id) userData.external_id = [sha256Hex(cust.external_id)];

  const meta_event_id = buildEventId(act.id);
  const event_time = Math.max(
    Math.floor(Date.now() / 1000) - 7 * 86400 + 60, // floor at 7d-old + 1min so Meta doesn't reject
    act.timestamp ?? Math.floor(Date.now() / 1000),
  );

  const event: CapiEventPayload = {
    event_name: map.meta_event_name,
    event_time,
    event_id: meta_event_id,
    action_source: map.action_source ?? cfg.default_action_source,
    user_data: userData,
  };
  if (cfg.default_event_source_url) event.event_source_url = cfg.default_event_source_url;
  if (act.data && typeof act.data === 'object') {
    const cd: Record<string, unknown> = {};
    const d = act.data as Record<string, unknown>;
    if (typeof d.value === 'number' || typeof d.value === 'string') cd.value = Number(d.value);
    if (typeof d.currency === 'string') cd.currency = d.currency;
    if (Object.keys(cd).length > 0) event.custom_data = cd;
  }

  let res: { http_status: number; body: unknown };
  try {
    res = await postToMetaCapi({
      pixel_id: cfg.pixel_id,
      events: [event],
      test_event_code: cfg.test_event_code,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await logForward({
      cio_activity_id: act.id,
      cio_event_name: map.cio_event_name,
      meta_event_name: map.meta_event_name,
      pixel_id: cfg.pixel_id,
      meta_event_id,
      customer_id: cust.external_id,
      customer_email: cust.email,
      event_time,
      success: false,
      http_status: null,
      meta_response: null,
      error_message: m,
    });
    return { ok: false, meta_event_id, http_status: 0, body: null, error: m };
  }

  const ok = res.http_status >= 200 && res.http_status < 300;
  await logForward({
    cio_activity_id: act.id,
    cio_event_name: map.cio_event_name,
    meta_event_name: map.meta_event_name,
    pixel_id: cfg.pixel_id,
    meta_event_id,
    customer_id: cust.external_id,
    customer_email: cust.email,
    event_time,
    success: ok,
    http_status: res.http_status,
    meta_response: res.body,
    error_message: ok ? null : JSON.stringify(res.body).slice(0, 500),
  });
  return { ok, meta_event_id, http_status: res.http_status, body: res.body };
}

async function logForward(row: Omit<CapiForward, 'id' | 'created_at'>): Promise<void> {
  const { error } = await supabase.from('capi_forwards').insert(row);
  if (error) console.error('[CAPI] logForward failed:', error.message);
}

async function alreadyForwarded(activityId: string, metaEventId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('capi_forwards')
    .select('id, success')
    .eq('cio_activity_id', activityId)
    .eq('meta_event_id', metaEventId)
    .eq('success', true)
    .limit(1);
  if (error) {
    console.error('[CAPI] alreadyForwarded check failed:', error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

// ---------- Polling tick ----------

export interface CapiTickResult {
  enabled: boolean;
  scanned: number;
  matched: number;
  forwarded: number;
  skipped_dedup: number;
  errors: number;
  lookback_minutes: number;
}

export async function runCapiTick(opts: { lookbackMinutes?: number } = {}): Promise<CapiTickResult> {
  const cfg = await getCapiConfig();
  const lookback = opts.lookbackMinutes ?? 30;
  const result: CapiTickResult = {
    enabled: cfg.enabled,
    scanned: 0,
    matched: 0,
    forwarded: 0,
    skipped_dedup: 0,
    errors: 0,
    lookback_minutes: lookback,
  };
  if (!cfg.enabled || !cfg.pixel_id) return result;

  const maps = (await listEventMap()).filter((m) => m.enabled);
  if (maps.length === 0) return result;
  const mapByName = new Map(maps.map((m) => [m.cio_event_name, m] as const));

  // Pull recent activities — global stream, paginate newest-first, stop after lookback.
  const startUnix = Math.floor(Date.now() / 1000) - lookback * 60;
  const acts = await cioListActivities({ type: 'event', limit: 200, start: startUnix });
  result.scanned = acts.length;

  for (const a of acts) {
    if (!a.name) continue;
    const map = mapByName.get(a.name);
    if (!map) continue;
    result.matched++;

    const meta_event_id = buildEventId(a.id);
    if (await alreadyForwarded(a.id, meta_event_id)) {
      result.skipped_dedup++;
      continue;
    }
    try {
      const r = await forwardActivity(a, map, cfg);
      if (r.ok) result.forwarded++;
      else result.errors++;
    } catch (err) {
      console.error('[CAPI] forwardActivity threw:', err);
      result.errors++;
    }
  }
  return result;
}

export async function runCapiBackfill(hours: number): Promise<CapiTickResult> {
  return runCapiTick({ lookbackMinutes: hours * 60 });
}

// ---------- Forwards readout ----------

export async function listRecentForwards(limit = 50): Promise<CapiForward[]> {
  const { data, error } = await supabase
    .from('capi_forwards')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[CAPI] listRecentForwards failed:', error.message);
    return [];
  }
  return (data ?? []) as CapiForward[];
}

// CLI: `tsx agents/capi.ts` runs one tick.
import { fileURLToPath } from 'node:url';
const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  runCapiTick()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
