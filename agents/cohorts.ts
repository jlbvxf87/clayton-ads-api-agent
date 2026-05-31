import 'dotenv/config';
import { supabase } from './supabase.js';
import { noteObservation, loadActiveObservations } from './memory.js';
import { cioDiscoverEventNames, cioCountEvents, CIO_CONFIGURED } from './customerio.js';
import { getCampaignInsights, getActionBreakdown, extractLeads } from './meta.js';

// ---------- Event name patterns ----------

const REBILL_PATTERNS = [
  'rebill', 'renewal', 'recurring', 'reorder', 're_order', 'subscription_renewed',
  'second_charge', 'repeat_purchase',
];
const REFUND_PATTERNS = ['refund', 'chargeback', 'cancel'];
const INTAKE_PATTERNS = [
  'intake_complete', 'intake_completed', 'intake_submitted', 'form_complete',
  'intake_done', 'onboarding_complete',
];
const APPROVAL_PATTERNS = [
  'approved', 'doctor_approved', 'provider_approved', 'medically_approved',
  'physician_approved', 'rx_approved',
];

// ---------- Types ----------

export interface CohortEventMap {
  lead: string;
  rebill: string | null;
  refund: string | null;
  intake_complete: string | null;
  approval: string | null;
  discovered_at: string;
}

export interface CohortSnapshot {
  cohort_date: string;
  campaign_id: string;
  campaign_name: string | null;
  spend: number;
  lead_count: number;
  intake_complete: number;
  approved_count: number;
  rebill_count: number;
  refund_count: number;
  cpl: number | null;
  cpb: number | null;
  intake_rate_pct: number | null;
  approval_rate_pct: number | null;
  rebill_rate_pct: number | null;
  data_source: 'cio' | 'manual';
}

// ---------- Event map discovery + caching ----------

function findMatch(names: string[], patterns: string[]): string | null {
  for (const p of patterns) {
    const found = names.find((n) => n.toLowerCase().includes(p));
    if (found) return found;
  }
  return null;
}

export async function discoverCohortEventMap(force = false): Promise<CohortEventMap> {
  if (!force) {
    const cached = await loadActiveObservations('cio:cohort_event_map');
    if (cached.length > 0) {
      try {
        return JSON.parse(cached[0].observation) as CohortEventMap;
      } catch {
        // stale — re-discover
      }
    }
  }

  const events = await cioDiscoverEventNames(30);
  const names = events.map((e) => e.event_name);

  // Lead: prefer Claya-specific names before generic 'lead'
  const leadName =
    findMatch(names, ['request_submitted', 'lead_submitted', 'intake_started']) ?? 'lead';

  const map: CohortEventMap = {
    lead: leadName,
    rebill: findMatch(names, REBILL_PATTERNS),
    refund: findMatch(names, REFUND_PATTERNS),
    intake_complete: findMatch(names, INTAKE_PATTERNS),
    approval: findMatch(names, APPROVAL_PATTERNS),
    discovered_at: new Date().toISOString(),
  };

  await noteObservation('cio:cohort_event_map', JSON.stringify(map), {
    confidence: 'medium',
  });

  return map;
}

export async function setCohortEventOverride(
  field: keyof Omit<CohortEventMap, 'discovered_at'>,
  eventName: string,
): Promise<CohortEventMap> {
  const current = await discoverCohortEventMap();
  const updated: CohortEventMap = {
    ...current,
    [field]: eventName,
    discovered_at: new Date().toISOString(),
  };
  await noteObservation('cio:cohort_event_map', JSON.stringify(updated), {
    confidence: 'high',
  });
  return updated;
}

// ---------- Cohort tick ----------

export async function runCohortTick(opts?: {
  date_preset?: 'today' | 'yesterday' | 'last_7d' | 'last_30d';
  force_rediscover?: boolean;
}): Promise<{
  ok: boolean;
  snapshot: CohortSnapshot | null;
  event_map: CohortEventMap;
  cio_available: boolean;
  error?: string;
}> {
  const dp = opts?.date_preset ?? 'last_7d';
  const days =
    dp === 'today' ? 0 : dp === 'yesterday' ? 1 : Number(dp.replace('last_', '').replace('d', ''));
  const endTs = Math.floor(Date.now() / 1000);
  const startTs =
    dp === 'today'
      ? Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000)
      : endTs - days * 86400;

  // Always pull Meta spend — that's always available
  let totalSpend = 0;
  let totalMetaLeads = 0;
  try {
    const insights = await getCampaignInsights(
      dp === 'today' ? 'today' : dp === 'yesterday' ? 'yesterday' : (dp as 'last_7d' | 'last_30d'),
    );
    totalSpend = insights.reduce((s, i) => s + Number(i.spend), 0);
    totalMetaLeads = insights.reduce((s, i) => s + extractLeads(i), 0);
  } catch (err) {
    return {
      ok: false,
      snapshot: null,
      event_map: { lead: 'lead', rebill: null, refund: null, intake_complete: null, approval: null, discovered_at: new Date().toISOString() },
      cio_available: false,
      error: `Meta pull failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!CIO_CONFIGURED) {
    // Meta-only snapshot: leads from Meta, no CIO enrichment
    const cpl = totalMetaLeads > 0 ? totalSpend / totalMetaLeads : null;
    const cohortDate = new Date().toISOString().slice(0, 10);
    const snapshot: CohortSnapshot = {
      cohort_date: cohortDate,
      campaign_id: 'account',
      campaign_name: 'Account-wide',
      spend: totalSpend,
      lead_count: totalMetaLeads,
      intake_complete: 0,
      approved_count: 0,
      rebill_count: 0,
      refund_count: 0,
      cpl,
      cpb: null,
      intake_rate_pct: null,
      approval_rate_pct: null,
      rebill_rate_pct: null,
      data_source: 'cio',
    };
    await supabase.from('customer_cohorts').upsert(
      { ...snapshot, updated_at: new Date().toISOString() },
      { onConflict: 'campaign_id,cohort_date' },
    );
    return {
      ok: true,
      snapshot,
      event_map: { lead: 'lead', rebill: null, refund: null, intake_complete: null, approval: null, discovered_at: new Date().toISOString() },
      cio_available: false,
    };
  }

  // CIO enrichment
  const eventMap = await discoverCohortEventMap(opts?.force_rediscover ?? false);

  const [leadCount, rebillCount, refundCount, intakeCount, approvalCount] = await Promise.all([
    cioCountEvents(eventMap.lead, startTs, endTs).catch(() => 0),
    eventMap.rebill ? cioCountEvents(eventMap.rebill, startTs, endTs).catch(() => 0) : Promise.resolve(0),
    eventMap.refund ? cioCountEvents(eventMap.refund, startTs, endTs).catch(() => 0) : Promise.resolve(0),
    eventMap.intake_complete ? cioCountEvents(eventMap.intake_complete, startTs, endTs).catch(() => 0) : Promise.resolve(0),
    eventMap.approval ? cioCountEvents(eventMap.approval, startTs, endTs).catch(() => 0) : Promise.resolve(0),
  ]);

  const effectiveLeads = leadCount || totalMetaLeads;
  const cpl = effectiveLeads > 0 ? totalSpend / effectiveLeads : null;
  const cpb = rebillCount > 0 ? totalSpend / rebillCount : null;

  // Rebill rate: prefer approved→rebill, fall back to lead→rebill
  const rebillDenom = approvalCount || intakeCount || effectiveLeads;
  const rebillRate = rebillDenom > 0 && rebillCount > 0 ? (rebillCount / rebillDenom) * 100 : null;
  const intakeRate = effectiveLeads > 0 && intakeCount > 0 ? (intakeCount / effectiveLeads) * 100 : null;
  const approvalRate = intakeCount > 0 && approvalCount > 0 ? (approvalCount / intakeCount) * 100 : null;

  const cohortDate = new Date().toISOString().slice(0, 10);
  const snapshot: CohortSnapshot = {
    cohort_date: cohortDate,
    campaign_id: 'account',
    campaign_name: 'Account-wide',
    spend: totalSpend,
    lead_count: effectiveLeads,
    intake_complete: intakeCount,
    approved_count: approvalCount,
    rebill_count: rebillCount,
    refund_count: refundCount,
    cpl,
    cpb,
    intake_rate_pct: intakeRate,
    approval_rate_pct: approvalRate,
    rebill_rate_pct: rebillRate,
    data_source: 'cio',
  };

  const { error } = await supabase.from('customer_cohorts').upsert(
    { ...snapshot, updated_at: new Date().toISOString() },
    { onConflict: 'campaign_id,cohort_date' },
  );
  if (error) {
    return { ok: false, snapshot, event_map: eventMap, cio_available: true, error: error.message };
  }

  return { ok: true, snapshot, event_map: eventMap, cio_available: true };
}

// ---------- Read ----------

export async function getLatestCohort(campaignId = 'account'): Promise<CohortSnapshot | null> {
  const { data } = await supabase
    .from('customer_cohorts')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('cohort_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as CohortSnapshot | null) ?? null;
}

export async function listCohortHistory(opts?: {
  campaign_id?: string;
  limit?: number;
}): Promise<CohortSnapshot[]> {
  let q = supabase
    .from('customer_cohorts')
    .select('*')
    .order('cohort_date', { ascending: false })
    .limit(opts?.limit ?? 30);
  if (opts?.campaign_id) q = q.eq('campaign_id', opts.campaign_id);
  const { data } = await q;
  return (data ?? []) as CohortSnapshot[];
}

// ---------- Formatting ----------

export function formatCohortForTelegram(
  s: CohortSnapshot,
  eventMap?: Partial<CohortEventMap>,
): string {
  const lines: string[] = [
    `Customer quality — ${s.cohort_date}`,
    s.campaign_name !== 'Account-wide' ? `Campaign: ${s.campaign_name}` : 'Account-wide',
    '',
    `Spend:    $${s.spend.toFixed(0)}`,
    `Leads:    ${s.lead_count}${s.cpl != null ? `   CPL $${s.cpl.toFixed(0)}` : ''}`,
  ];

  if (s.intake_complete > 0) {
    lines.push(
      `Intake:   ${s.intake_complete}${s.intake_rate_pct != null ? `   (${s.intake_rate_pct.toFixed(0)}% completion)` : ''}`,
    );
  }
  if (s.approved_count > 0) {
    lines.push(
      `Approved: ${s.approved_count}${s.approval_rate_pct != null ? `   (${s.approval_rate_pct.toFixed(0)}% of intake)` : ''}`,
    );
  }

  if (s.rebill_count > 0) {
    lines.push(
      `Rebills:  ${s.rebill_count}${s.rebill_rate_pct != null ? `   (${s.rebill_rate_pct.toFixed(0)}% rebill rate)` : ''}${s.cpb != null ? `   CPB $${s.cpb.toFixed(0)}` : ''}`,
    );
  } else {
    const noRebillNote = eventMap?.rebill
      ? `Rebills:  0   (tracking: ${eventMap.rebill})`
      : `Rebills:  —   rebill event not yet in CIO (set with /cohorts set rebill <event_name>)`;
    lines.push(noRebillNote);
  }

  if (s.refund_count > 0) {
    lines.push(`Refunds:  ${s.refund_count}`);
  }

  if (eventMap) {
    lines.push('');
    const mapParts = [
      `lead=${eventMap.lead ?? '?'}`,
      eventMap.rebill ? `rebill=${eventMap.rebill}` : 'rebill=not found',
      eventMap.intake_complete ? `intake=${eventMap.intake_complete}` : null,
      eventMap.approval ? `approval=${eventMap.approval}` : null,
    ].filter(Boolean);
    lines.push(`CIO events: ${mapParts.join('  ')}`);
  }

  return lines.join('\n');
}
