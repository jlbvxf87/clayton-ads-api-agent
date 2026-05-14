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

// Prefix convention: `attr:<AttributeName>` in capi_event_map.cio_event_name
// routes that row through the attribute-change forwarder instead of the
// named-event forwarder. Lets us synthesize CAPI events from CIO profile
// attribute flips when the upstream form writes attributes but doesn't
// emit named events (Claya's join.claya.com quiz today).
const ATTR_PREFIX = 'attr:';

function buildEventId(activityId: string): string {
  return `cio:${activityId}`;
}

function buildAttrEventId(activityId: string): string {
  return `cio:attr:${activityId}`;
}

function attributeFlippedTo(act: CioActivity, attr: string, target: string): boolean {
  if (act.type !== 'attribute_change') return false;
  const d = act.data as Record<string, unknown> | undefined;
  if (!d) return false;
  const change = d[attr] as { from?: unknown; to?: unknown } | undefined;
  if (!change || typeof change !== 'object') return false;
  if (String(change.to) !== target) return false;
  // Skip no-op writes that re-set the same value.
  if (String(change.from ?? '') === target) return false;
  return true;
}

function readAttrToString(d: Record<string, unknown> | undefined, key: string): string | null {
  if (!d) return null;
  const v = d[key] as { to?: unknown } | undefined;
  if (!v || typeof v !== 'object') return null;
  return typeof v.to === 'string' && v.to ? (v.to as string) : null;
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

interface CustomerFields {
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  external_id: string | null;
}

function buildUserData(cust: CustomerFields): CapiUserData {
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
  return userData;
}

async function postAndLog(args: {
  act: CioActivity;
  map: CapiEventMap;
  cfg: CapiConfig;
  cust: CustomerFields;
  meta_event_id: string;
  event: CapiEventPayload;
}): Promise<{ ok: boolean; meta_event_id: string; http_status: number; body: unknown; error?: string }> {
  const { act, map, cfg, cust, meta_event_id, event } = args;
  let res: { http_status: number; body: unknown };
  try {
    res = await postToMetaCapi({
      pixel_id: cfg.pixel_id!,
      events: [event],
      test_event_code: cfg.test_event_code,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await logForward({
      cio_activity_id: act.id,
      cio_event_name: map.cio_event_name,
      meta_event_name: map.meta_event_name,
      pixel_id: cfg.pixel_id!,
      meta_event_id,
      customer_id: cust.external_id,
      customer_email: cust.email,
      event_time: event.event_time,
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
    pixel_id: cfg.pixel_id!,
    meta_event_id,
    customer_id: cust.external_id,
    customer_email: cust.email,
    event_time: event.event_time,
    success: ok,
    http_status: res.http_status,
    meta_response: res.body,
    error_message: ok ? null : JSON.stringify(res.body).slice(0, 500),
  });
  return { ok, meta_event_id, http_status: res.http_status, body: res.body };
}

function eventTimeFloored(actTimestamp: number | undefined): number {
  // Meta CAPI rejects events older than 7 days; floor at 7d-1min ago.
  return Math.max(
    Math.floor(Date.now() / 1000) - 7 * 86400 + 60,
    actTimestamp ?? Math.floor(Date.now() / 1000),
  );
}

export async function forwardActivity(
  act: CioActivity,
  map: CapiEventMap,
  cfg: CapiConfig,
): Promise<{ ok: boolean; meta_event_id: string; http_status: number; body: unknown; error?: string }> {
  if (!cfg.pixel_id) throw new Error('capi_config.pixel_id is not set');
  const cust = await fetchCustomerForActivity(act);
  const userData = buildUserData(cust);
  const meta_event_id = buildEventId(act.id);
  const event_time = eventTimeFloored(act.timestamp);

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

  return postAndLog({ act, map, cfg, cust, meta_event_id, event });
}

// Forward a CIO attribute_change activity as a synthetic CAPI event.
// Reads PII from the activity's attribute deltas first (cheaper, avoids
// race conditions on profile fetch); falls back to /customers/:id/attributes
// if the deltas don't include enough identifiers.
export async function forwardAttributeChange(
  act: CioActivity,
  map: CapiEventMap,
  cfg: CapiConfig,
): Promise<{ ok: boolean; meta_event_id: string; http_status: number; body: unknown; error?: string }> {
  if (!cfg.pixel_id) throw new Error('capi_config.pixel_id is not set');
  const d = (act.data as Record<string, unknown> | undefined) ?? undefined;
  let cust: CustomerFields = {
    email: readAttrToString(d, 'email'),
    phone: readAttrToString(d, 'phone') ?? readAttrToString(d, 'phone_number'),
    first_name: readAttrToString(d, 'first_name') ?? readAttrToString(d, 'firstname'),
    last_name: readAttrToString(d, 'last_name') ?? readAttrToString(d, 'lastname'),
    external_id: act.customer_id ?? act.cio_id ?? null,
  };
  if (!cust.email && cust.external_id) {
    const fetched = await cioGetCustomer(cust.external_id);
    if (fetched) {
      const attrs = (fetched.attributes ?? {}) as Record<string, unknown>;
      const pickStr = (k: string): string | null =>
        typeof attrs[k] === 'string' && (attrs[k] as string).length > 0 ? (attrs[k] as string) : null;
      cust = {
        email: cust.email ?? (typeof fetched.email === 'string' ? fetched.email : pickStr('email')),
        phone: cust.phone ?? pickStr('phone') ?? pickStr('phone_number'),
        first_name: cust.first_name ?? pickStr('first_name') ?? pickStr('firstname'),
        last_name: cust.last_name ?? pickStr('last_name') ?? pickStr('lastname'),
        external_id: cust.external_id,
      };
    }
  }

  const userData = buildUserData(cust);
  // For Lead events, key the event_id on sha256(email) so the browser-side
  // fbq('track','Lead', {}, {eventID: sha256(email)}) in claya-nextjs
  // dedupes against this server fire automatically. Falls back to the
  // attribute-activity id when there's no email or the event is not Lead.
  const meta_event_id =
    map.meta_event_name === 'Lead' && cust.email
      ? sha256Hex(cust.email.trim().toLowerCase())
      : buildAttrEventId(act.id);
  const event_time = eventTimeFloored(act.timestamp);

  const event: CapiEventPayload = {
    event_name: map.meta_event_name,
    event_time,
    event_id: meta_event_id,
    action_source: map.action_source ?? cfg.default_action_source,
    user_data: userData,
  };
  if (cfg.default_event_source_url) event.event_source_url = cfg.default_event_source_url;

  return postAndLog({ act, map, cfg, cust, meta_event_id, event });
}

async function logForward(row: Omit<CapiForward, 'id' | 'created_at'>): Promise<void> {
  const { error } = await supabase.from('capi_forwards').upsert(row, {
    onConflict: 'cio_activity_id,meta_event_name',
    ignoreDuplicates: true,
  });
  if (error && !error.message.includes('duplicate')) {
    console.error('[CAPI] logForward failed:', error.message);
  }
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

  const startUnix = Math.floor(Date.now() / 1000) - lookback * 60;

  // ---- Path 1: named CIO events → CAPI (original) ----
  const eventMaps = maps.filter((m) => !m.cio_event_name.startsWith(ATTR_PREFIX));
  if (eventMaps.length > 0) {
    const mapByName = new Map(eventMaps.map((m) => [m.cio_event_name, m] as const));
    const acts = await cioListActivities({ type: 'event', limit: 200, start: startUnix });
    result.scanned += acts.length;
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
  }

  // ---- Path 2: CIO attribute_change deltas → synthetic CAPI events ----
  // For each map row whose cio_event_name starts with `attr:`, the suffix
  // names the attribute we watch for. The synthetic Lead fires when that
  // attribute flips from any non-target value to "true" (Quiz_Started=true
  // is Claya's quiz-submit signal today, since the form doesn't fire a
  // named CIO event).
  const attrMaps = maps.filter((m) => m.cio_event_name.startsWith(ATTR_PREFIX));
  if (attrMaps.length > 0) {
    const acts = await cioListActivities({
      type: 'attribute_change',
      limit: 200,
      start: startUnix,
    });
    result.scanned += acts.length;
    for (const a of acts) {
      for (const map of attrMaps) {
        const attrName = map.cio_event_name.slice(ATTR_PREFIX.length);
        if (!attributeFlippedTo(a, attrName, 'true')) continue;
        result.matched++;
        const meta_event_id = buildAttrEventId(a.id);
        if (await alreadyForwarded(a.id, meta_event_id)) {
          result.skipped_dedup++;
          break;
        }
        try {
          const r = await forwardAttributeChange(a, map, cfg);
          if (r.ok) result.forwarded++;
          else result.errors++;
        } catch (err) {
          console.error('[CAPI] forwardAttributeChange threw:', err);
          result.errors++;
        }
        break; // one synthetic event per activity, even if multiple maps would match
      }
    }
  }

  return result;
}

export async function runCapiBackfill(hours: number): Promise<CapiTickResult> {
  return runCapiTick({ lookbackMinutes: hours * 60 });
}

// ---------- Digest (daily summary) ----------

export interface CapiDigest {
  window_hours: number;
  total: number;
  success: number;
  errors: number;
  by_event: Record<string, number>;
  sample_emails: string[];
  internal_emails: string[];
  top_error: string | null;
}

// Heuristics for "internal/test" emails. Stays loose on purpose — false
// positives in the digest are cheap (just labels), false negatives let
// test traffic pollute Meta's optimizer silently.
function looksInternal(email: string): boolean {
  const e = email.toLowerCase();
  if (e.endsWith('@claya.com')) return true;
  if (e.endsWith('@seelr.com')) return true;
  if (e.includes('+test') || e.includes('+qa') || e.includes('+demo')) return true;
  return false;
}

export async function getCapiDigest(hours = 24): Promise<CapiDigest> {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('capi_forwards')
    .select('meta_event_name, customer_email, success, error_message')
    .gte('created_at', since);
  if (error) throw new Error(`getCapiDigest: ${error.message}`);
  const rows = (data ?? []) as Array<{
    meta_event_name: string;
    customer_email: string | null;
    success: boolean;
    error_message: string | null;
  }>;
  const digest: CapiDigest = {
    window_hours: hours,
    total: rows.length,
    success: 0,
    errors: 0,
    by_event: {},
    sample_emails: [],
    internal_emails: [],
    top_error: null,
  };
  for (const r of rows) {
    if (r.success) digest.success++;
    else digest.errors++;
    digest.by_event[r.meta_event_name] = (digest.by_event[r.meta_event_name] ?? 0) + 1;
    if (r.customer_email) {
      if (looksInternal(r.customer_email)) {
        if (digest.internal_emails.length < 5) digest.internal_emails.push(r.customer_email);
      } else if (digest.sample_emails.length < 5) {
        digest.sample_emails.push(r.customer_email);
      }
    }
    if (!r.success && !digest.top_error && r.error_message) {
      digest.top_error = r.error_message.slice(0, 200);
    }
  }
  return digest;
}

export function formatCapiDigest(d: CapiDigest): string {
  const lines: string[] = [];
  lines.push(`CAPI bridge — last ${d.window_hours}h`);
  lines.push('');
  if (d.total === 0) {
    lines.push('No forwards in the window.');
    lines.push('Check: bot up? CIO Quiz_Started flips happening? capi_event_map enabled?');
    return lines.join('\n');
  }
  lines.push(`Forwarded: ${d.total}  (ok=${d.success}  err=${d.errors})`);
  const eventLines = Object.entries(d.by_event).map(([k, v]) => `  ${k}: ${v}`);
  if (eventLines.length > 0) lines.push(...eventLines);
  if (d.errors > 0 && d.top_error) {
    lines.push('');
    lines.push(`Top error: ${d.top_error}`);
  }
  if (d.internal_emails.length > 0) {
    lines.push('');
    lines.push(`Possible test/internal (${d.internal_emails.length}):`);
    for (const e of d.internal_emails.slice(0, 3)) lines.push(`  ${e}`);
  }
  if (d.sample_emails.length > 0) {
    lines.push('');
    lines.push(`Sample real leads:`);
    for (const e of d.sample_emails.slice(0, 3)) lines.push(`  ${e}`);
  }
  return lines.join('\n');
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
