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
 */
export async function cioListActivities(args: ListActivitiesArgs = {}): Promise<CioActivity[]> {
  const params: Record<string, string> = { limit: String(args.limit ?? 100) };
  if (args.type) params.type = args.type;
  if (args.name) params.name = args.name;
  if (args.customer_id) params.customer_id = args.customer_id;
  if (args.start) params.start = String(args.start);
  if (args.end) params.end = String(args.end);

  const { data } = await appClient.get('/activities', { headers: appHeaders(), params });
  return (data?.activities ?? []) as CioActivity[];
}

/**
 * Count events of a given name in a time window. Paginates if necessary.
 */
export async function cioCountEvents(
  eventName: string,
  startUnix: number,
  endUnix: number,
): Promise<number> {
  let total = 0;
  let next: string | undefined;
  let safety = 0;
  do {
    const params: Record<string, string> = {
      type: 'event',
      name: eventName,
      start: String(startUnix),
      end: String(endUnix),
      limit: '1000',
    };
    if (next) params.start_id = next;

    const { data } = await appClient.get('/activities', { headers: appHeaders(), params });
    total += (data?.activities ?? []).length;
    next = data?.next as string | undefined;
    safety++;
  } while (next && safety < 50);
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
