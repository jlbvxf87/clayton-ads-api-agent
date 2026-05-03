import 'dotenv/config';
import axios, { type AxiosInstance } from 'axios';

const SITE_ID = process.env.CIO_SITE_ID;
const TRACK_API_KEY = process.env.CIO_TRACK_API_KEY;
const APP_API_KEY = process.env.CIO_APP_API_KEY;
const REGION = (process.env.CIO_REGION ?? 'us').toLowerCase();

const APP_BASE = REGION === 'eu' ? 'https://api-eu.customer.io/v1' : 'https://api.customer.io/v1';
const TRACK_BASE =
  REGION === 'eu' ? 'https://track-eu.customer.io/api/v1' : 'https://track.customer.io/api/v1';

function ensureAppKey(): string {
  if (!APP_API_KEY) {
    throw new Error('CIO_APP_API_KEY not set — Customer.io read tools unavailable.');
  }
  return APP_API_KEY;
}

const appClient: AxiosInstance = axios.create({
  baseURL: APP_BASE,
  timeout: 20_000,
});

const trackClient: AxiosInstance = axios.create({
  baseURL: TRACK_BASE,
  timeout: 20_000,
  auth: SITE_ID && TRACK_API_KEY ? { username: SITE_ID, password: TRACK_API_KEY } : undefined,
});

function appHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ensureAppKey()}` };
}

// ---------- Segments ----------

export interface CioSegment {
  id: number;
  name: string;
  description?: string;
  type?: string;
  tags?: string[];
}

export async function cioListSegments(): Promise<CioSegment[]> {
  const { data } = await appClient.get('/segments', { headers: appHeaders() });
  return (data?.segments ?? []) as CioSegment[];
}

export async function cioCountSegment(segmentId: number): Promise<number> {
  const { data } = await appClient.get(`/segments/${segmentId}/customer_count`, {
    headers: appHeaders(),
  });
  return Number(data?.count ?? 0);
}

// ---------- Customers ----------

export interface CioCustomer {
  id: string;
  cio_id?: string;
  email?: string;
  attributes?: Record<string, unknown>;
}

/**
 * Find one customer by email. Returns null if not found.
 */
export async function cioFindCustomerByEmail(email: string): Promise<CioCustomer | null> {
  try {
    const { data } = await appClient.post(
      '/customers',
      {
        filter: { and: [{ attribute: { field: 'email', operator: 'eq', value: email } }] },
      },
      { headers: { ...appHeaders(), 'Content-Type': 'application/json' } },
    );
    const list = (data?.identifiers ?? data?.customers ?? data?.results ?? []) as CioCustomer[];
    return list[0] ?? null;
  } catch (err) {
    // Fall back to query-string lookup on older CIO accounts
    try {
      const { data } = await appClient.get('/customers', {
        params: { email },
        headers: appHeaders(),
      });
      const list = (data?.results ?? data?.customers ?? []) as CioCustomer[];
      return list[0] ?? null;
    } catch {
      throw err;
    }
  }
}

export async function cioGetCustomer(customerId: string): Promise<CioCustomer | null> {
  try {
    const { data } = await appClient.get(`/customers/${encodeURIComponent(customerId)}/attributes`, {
      headers: appHeaders(),
    });
    return data?.customer ?? null;
  } catch {
    return null;
  }
}

// ---------- Activity / events ----------

export interface CioActivity {
  id: string;
  type: string;             // 'event','attribute_change','page_view', etc.
  name?: string;            // event name when type==='event'
  customer_id?: string;
  cio_id?: string;
  delivery_type?: string;
  delivery_id?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
}

interface ListActivitiesArgs {
  type?: 'event' | 'attribute_change' | 'page_view' | 'delivery';
  name?: string;            // event name filter
  customer_id?: string;
  start?: number;           // unix seconds
  end?: number;             // unix seconds
  limit?: number;
}

/**
 * List activities (events, attribute changes, page views) — workspace-wide
 * by default, scoped to one customer if customer_id provided.
 *
 * NOTE: CIO's /v1/activities does NOT accept start/end timestamp params
 * directly (returns 400). For time windows, the caller paginates and
 * filters client-side using activity.timestamp. Helper functions below
 * (cioCountEvents, cioDiscoverEventNames) handle that pattern.
 */
export async function cioListActivities(args: ListActivitiesArgs = {}): Promise<CioActivity[]> {
  const params: Record<string, string> = { limit: String(args.limit ?? 100) };
  if (args.type) params.type = args.type;
  if (args.name) params.name = args.name;
  if (args.customer_id) params.customer_id = args.customer_id;
  // start/end NOT passed to the API — they trigger 400. Filter client-side.

  const { data } = await appClient.get('/activities', { headers: appHeaders(), params });
  let acts = (data?.activities ?? []) as CioActivity[];
  if (args.start) acts = acts.filter((a) => (a.timestamp ?? 0) >= args.start!);
  if (args.end) acts = acts.filter((a) => (a.timestamp ?? 0) <= args.end!);
  return acts;
}

/**
 * Count events of a given name in a time window. CIO's /v1/activities does
 * NOT support start/end query params — they 400. So we paginate the global
 * stream (newest-first) filtered by event name only, and stop once we cross
 * the startUnix boundary. Caps at 50 pages × 1000 = 50K activities scanned.
 */
export async function cioCountEvents(
  eventName: string,
  startUnix: number,
  endUnix: number,
): Promise<number> {
  let total = 0;
  let next: string | undefined;
  let safety = 0;
  let stop = false;

  while (!stop && safety < 50) {
    const params: Record<string, string> = {
      type: 'event',
      name: eventName,
      limit: '1000',
    };
    if (next) params.start_id = next;

    let data: { activities?: CioActivity[]; next?: string } = {};
    try {
      const res = await appClient.get('/activities', { headers: appHeaders(), params });
      data = res.data ?? {};
    } catch (err) {
      console.warn('cioCountEvents page failed:', err);
      break;
    }
    const acts = data.activities ?? [];
    if (acts.length === 0) break;

    for (const a of acts) {
      const ts = a.timestamp ?? 0;
      if (ts < startUnix) {
        // we've paged past the window (results are newest-first)
        stop = true;
        break;
      }
      if (ts >= startUnix && ts <= endUnix) total++;
    }

    next = data.next;
    if (!next) break;
    safety++;
  }
  return total;
}

/**
 * Full activity timeline for one customer (most recent first).
 */
export async function cioGetCustomerActivity(
  customerIdOrEmail: string,
  limit = 100,
): Promise<CioActivity[]> {
  // If it looks like an email, resolve to customer first
  let cid = customerIdOrEmail;
  if (customerIdOrEmail.includes('@')) {
    const c = await cioFindCustomerByEmail(customerIdOrEmail);
    if (!c) return [];
    cid = c.cio_id ?? c.id;
  }
  const { data } = await appClient.get(
    `/customers/${encodeURIComponent(cid)}/activities`,
    { headers: appHeaders(), params: { limit: String(limit) } },
  );
  return (data?.activities ?? []) as CioActivity[];
}

// ---------- Discover what events actually fire ----------

export interface DiscoveredEvent {
  event_name: string;
  count: number;
  last_seen_iso: string | null;
  sample_data_keys: string[];     // properties seen on the event payload
}

/**
 * Scan recent CIO activities and aggregate distinct event names. Lets the
 * agent answer "what events do you actually fire?" by checking, not guessing.
 * Defaults to the last 30 days, capped at 5000 activities scanned.
 */
export async function cioDiscoverEventNames(days = 30, scanLimit = 5000): Promise<DiscoveredEvent[]> {
  const start = Math.floor(Date.now() / 1000) - days * 86400;
  const end = Math.floor(Date.now() / 1000);

  let collected = 0;
  let next: string | undefined;
  const byName = new Map<string, { count: number; last_ts: number; keys: Set<string> }>();
  let safety = 0;

  let stop = false;
  while (collected < scanLimit && safety < 50 && !stop) {
    // CIO doesn't accept start/end on the activities endpoint — paginate
    // newest-first and stop when we cross the start boundary.
    const params: Record<string, string> = {
      type: 'event',
      limit: '1000',
    };
    if (next) params.start_id = next;

    let data: { activities?: CioActivity[]; next?: string } = {};
    try {
      const res = await appClient.get('/activities', { headers: appHeaders(), params });
      data = res.data ?? {};
    } catch (err) {
      console.warn('cioDiscoverEventNames page failed:', err);
      break;
    }
    const acts = data.activities ?? [];
    if (acts.length === 0) break;

    for (const a of acts) {
      const ts = a.timestamp ?? 0;
      if (ts < start) {
        stop = true;
        break;
      }
      if (ts > end) continue;
      const name = a.name ?? '(unnamed)';
      const entry = byName.get(name) ?? { count: 0, last_ts: 0, keys: new Set<string>() };
      entry.count += 1;
      if (ts > entry.last_ts) entry.last_ts = ts;
      if (a.data) for (const k of Object.keys(a.data)) entry.keys.add(k);
      byName.set(name, entry);
    }
    collected += acts.length;
    next = data.next;
    if (!next) break;
    safety++;
  }

  return [...byName.entries()]
    .map(([event_name, v]) => ({
      event_name,
      count: v.count,
      last_seen_iso: v.last_ts > 0 ? new Date(v.last_ts * 1000).toISOString() : null,
      sample_data_keys: [...v.keys].slice(0, 12),
    }))
    .sort((a, b) => b.count - a.count);
}

// ---------- Combined: lead → booking show rate ----------

export interface ShowRateSummary {
  start: string;
  end: string;
  lead_event_name: string;
  booking_event_name: string;
  lead_count: number;
  booking_count: number;
  show_rate_pct: number | null;       // booking_count / lead_count * 100
}

export async function cioShowRate(args: {
  lead_event_name: string;
  booking_event_name: string;
  start_unix: number;
  end_unix: number;
}): Promise<ShowRateSummary> {
  const [leads, bookings] = await Promise.all([
    cioCountEvents(args.lead_event_name, args.start_unix, args.end_unix),
    cioCountEvents(args.booking_event_name, args.start_unix, args.end_unix),
  ]);
  const showRate = leads > 0 ? Math.round((bookings / leads) * 1000) / 10 : null;
  return {
    start: new Date(args.start_unix * 1000).toISOString(),
    end: new Date(args.end_unix * 1000).toISOString(),
    lead_event_name: args.lead_event_name,
    booking_event_name: args.booking_event_name,
    lead_count: leads,
    booking_count: bookings,
    show_rate_pct: showRate,
  };
}

// ---------- Track API: write events INTO CIO ----------

export async function cioSendEvent(args: {
  customer_id: string;
  name: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  if (!SITE_ID || !TRACK_API_KEY) {
    throw new Error('CIO_SITE_ID and CIO_TRACK_API_KEY required to send events.');
  }
  await trackClient.post(`/customers/${encodeURIComponent(args.customer_id)}/events`, {
    name: args.name,
    data: args.data ?? {},
  });
}

export const CIO_CONFIGURED = Boolean(APP_API_KEY);

// ---------- Health check ----------

export interface CioHealthReport {
  configured: boolean;
  app_api_reachable: boolean;
  track_api_configured: boolean;
  region: string;
  total_events_24h: number;
  total_events_7d: number;
  total_events_30d: number;
  last_event_iso: string | null;
  last_event_name: string | null;
  distinct_event_names_30d: DiscoveredEvent[];
  error_message: string | null;
  funnel_state: 'live' | 'silent' | 'unconfigured' | 'unknown';
}

/**
 * One-shot health check for the Customer.io connection. Used by `/cio status`
 * to answer "is CIO connected and producing events?" in a single call —
 * critical for verifying the moment the upstream form/pixel integration
 * is restored.
 */
export async function cioHealthCheck(): Promise<CioHealthReport> {
  const report: CioHealthReport = {
    configured: CIO_CONFIGURED,
    app_api_reachable: false,
    track_api_configured: Boolean(SITE_ID && TRACK_API_KEY),
    region: REGION,
    total_events_24h: 0,
    total_events_7d: 0,
    total_events_30d: 0,
    last_event_iso: null,
    last_event_name: null,
    distinct_event_names_30d: [],
    error_message: null,
    funnel_state: 'unknown',
  };

  if (!CIO_CONFIGURED) {
    report.funnel_state = 'unconfigured';
    report.error_message = 'CIO_APP_API_KEY not set';
    return report;
  }

  try {
    // One probe call to confirm credentials work. Newest-first stream.
    const recent = await cioListActivities({ type: 'event', limit: 1 });
    report.app_api_reachable = true;
    if (recent.length > 0 && recent[0]?.timestamp) {
      report.last_event_iso = new Date(recent[0].timestamp * 1000).toISOString();
      report.last_event_name = recent[0].name ?? null;
    }
  } catch (err) {
    report.error_message = err instanceof Error ? err.message : String(err);
    return report;
  }

  // Roll up event names + counts across the last 30 days.
  const now = Math.floor(Date.now() / 1000);
  try {
    const discovered = await cioDiscoverEventNames(30, 5000);
    report.distinct_event_names_30d = discovered;
    report.total_events_30d = discovered.reduce((s, e) => s + e.count, 0);
  } catch (err) {
    report.error_message = err instanceof Error ? err.message : String(err);
  }

  // Tighter windows — paginate the global stream once and bucket client-side
  // so we don't hammer the API with three separate scans.
  try {
    let count24 = 0;
    let count7 = 0;
    const cutoff7 = now - 7 * 86400;
    const cutoff24 = now - 86400;
    let next: string | undefined;
    let safety = 0;
    let stop = false;
    while (!stop && safety < 20) {
      const params: Record<string, string> = { type: 'event', limit: '1000' };
      if (next) params.start_id = next;
      const { data } = await appClient.get('/activities', { headers: appHeaders(), params });
      const acts = (data?.activities ?? []) as CioActivity[];
      if (acts.length === 0) break;
      for (const a of acts) {
        const ts = a.timestamp ?? 0;
        if (ts < cutoff7) {
          stop = true;
          break;
        }
        if (ts >= cutoff24) count24++;
        if (ts >= cutoff7) count7++;
      }
      next = data?.next;
      if (!next) break;
      safety++;
    }
    report.total_events_24h = count24;
    report.total_events_7d = count7;
  } catch (err) {
    if (!report.error_message) {
      report.error_message = err instanceof Error ? err.message : String(err);
    }
  }

  // Classify funnel state.
  if (report.total_events_30d > 0) report.funnel_state = 'live';
  else if (report.app_api_reachable) report.funnel_state = 'silent';
  else report.funnel_state = 'unknown';

  return report;
}
