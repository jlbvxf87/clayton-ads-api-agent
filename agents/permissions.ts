import { supabase } from './supabase.js';

export type PermissionKind =
  | 'pause'
  | 'resume'
  | 'budget'
  | 'create_campaign'
  | 'create_adset'
  | 'create_ad'
  | 'clone_ad'
  | 'targeting'
  | 'audience'
  | 'cio_event'
  | 'rule';

export const ALL_PERMISSION_KINDS: PermissionKind[] = [
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
];

export interface PermissionScope {
  campaign_ids?: string[];
  campaign_name_match?: string;
  ad_account_ids?: string[];
  max_budget_change_pct?: number;
  max_daily_budget_cents?: number;
  min_daily_budget_cents?: number;
  max_uses_per_day?: number;
}

export interface Permission {
  id: number;
  created_at: string;
  kind: PermissionKind;
  scope: PermissionScope;
  granted_by_user_id: string | null;
  granted_by_username: string | null;
  granted_at_chat_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  notes: string | null;
  uses_count: number;
  last_used_at: string | null;
}

export interface RequirePermissionParams {
  campaign_id?: string | null;
  campaign_name?: string | null;
  ad_account_id?: string | null;
  delta_pct?: number | null;
  new_daily_budget_cents?: number | null;
}

export type RequirePermissionResult =
  | { ok: true; permission_id: number; description: string }
  | {
      ok: false;
      reason:
        | 'no_standing_order'
        | 'expired'
        | 'scope_mismatch'
        | 'daily_cap_reached'
        | 'budget_change_too_large'
        | 'budget_out_of_range';
      message: string;
      suggested_grants: string[];
    };

function isPermissionKind(s: string): s is PermissionKind {
  return (ALL_PERMISSION_KINDS as string[]).includes(s);
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function listActivePermissions(): Promise<Permission[]> {
  const now = nowIso();
  const { data, error } = await supabase
    .from('agent_permissions')
    .select('*')
    .is('revoked_at', null)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[PERMS] listActivePermissions failed:', error.message);
    return [];
  }
  return (data ?? []) as Permission[];
}

export async function listAllPermissions(includeRevoked = false): Promise<Permission[]> {
  let q = supabase.from('agent_permissions').select('*').order('created_at', { ascending: false });
  if (!includeRevoked) q = q.is('revoked_at', null);
  const { data, error } = await q;
  if (error) {
    console.error('[PERMS] listAllPermissions failed:', error.message);
    return [];
  }
  return (data ?? []) as Permission[];
}

function scopeMatchesParams(
  kind: PermissionKind,
  scope: PermissionScope,
  params: RequirePermissionParams,
): { ok: true } | { ok: false; reason: RequirePermissionResult & { ok: false } } {
  // Campaign-id allow-list
  if (scope.campaign_ids && scope.campaign_ids.length > 0) {
    if (!params.campaign_id || !scope.campaign_ids.includes(params.campaign_id)) {
      return {
        ok: false,
        reason: {
          ok: false,
          reason: 'scope_mismatch',
          message: `Standing order is restricted to campaigns ${scope.campaign_ids.join(', ')}; this action targets ${params.campaign_id ?? '(unknown)'}.`,
          suggested_grants: [],
        },
      };
    }
  }
  // Campaign name match
  if (scope.campaign_name_match) {
    const needle = scope.campaign_name_match.toLowerCase();
    const hay = (params.campaign_name ?? '').toLowerCase();
    if (!hay.includes(needle)) {
      return {
        ok: false,
        reason: {
          ok: false,
          reason: 'scope_mismatch',
          message: `Standing order requires campaign name to contain "${scope.campaign_name_match}"; got "${params.campaign_name ?? '(unknown)'}".`,
          suggested_grants: [],
        },
      };
    }
  }
  // Ad-account allow-list
  if (scope.ad_account_ids && scope.ad_account_ids.length > 0) {
    if (!params.ad_account_id || !scope.ad_account_ids.includes(params.ad_account_id)) {
      return {
        ok: false,
        reason: {
          ok: false,
          reason: 'scope_mismatch',
          message: `Standing order is restricted to ad accounts ${scope.ad_account_ids.join(', ')}.`,
          suggested_grants: [],
        },
      };
    }
  }
  // Budget kind: change-pct + range
  if (kind === 'budget') {
    if (scope.max_budget_change_pct != null && params.delta_pct != null) {
      if (Math.abs(params.delta_pct) > scope.max_budget_change_pct) {
        return {
          ok: false,
          reason: {
            ok: false,
            reason: 'budget_change_too_large',
            message: `Standing order caps budget changes at ±${scope.max_budget_change_pct}%; this change is ${params.delta_pct.toFixed(1)}%.`,
            suggested_grants: [],
          },
        };
      }
    }
    if (
      scope.max_daily_budget_cents != null &&
      params.new_daily_budget_cents != null &&
      params.new_daily_budget_cents > scope.max_daily_budget_cents
    ) {
      return {
        ok: false,
        reason: {
          ok: false,
          reason: 'budget_out_of_range',
          message: `Standing order caps daily budget at $${(scope.max_daily_budget_cents / 100).toFixed(2)}; new budget would be $${(params.new_daily_budget_cents / 100).toFixed(2)}.`,
          suggested_grants: [],
        },
      };
    }
    if (
      scope.min_daily_budget_cents != null &&
      params.new_daily_budget_cents != null &&
      params.new_daily_budget_cents < scope.min_daily_budget_cents
    ) {
      return {
        ok: false,
        reason: {
          ok: false,
          reason: 'budget_out_of_range',
          message: `Standing order requires daily budget at least $${(scope.min_daily_budget_cents / 100).toFixed(2)}; new budget would be $${(params.new_daily_budget_cents / 100).toFixed(2)}.`,
          suggested_grants: [],
        },
      };
    }
  }
  return { ok: true };
}

async function checkDailyCap(p: Permission): Promise<boolean> {
  if (!p.scope?.max_uses_per_day) return true;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('agent_actions')
    .select('id', { count: 'exact', head: false })
    .eq('permission_id', p.id)
    .gte('created_at', since.toISOString());
  if (error) {
    console.error('[PERMS] checkDailyCap query failed:', error.message);
    return true; // fail open on cap check rather than blocking
  }
  return (data?.length ?? 0) < p.scope.max_uses_per_day;
}

export async function requirePermission(
  kind: PermissionKind,
  params: RequirePermissionParams,
): Promise<RequirePermissionResult> {
  const all = await listActivePermissions();
  const candidates = all.filter((p) => p.kind === kind);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'no_standing_order',
      message: `No active standing order for "${kind}".`,
      suggested_grants: suggestedGrants(kind, params),
    };
  }
  let lastFailure: RequirePermissionResult | null = null;
  for (const p of candidates) {
    const m = scopeMatchesParams(kind, p.scope ?? {}, params);
    if (!m.ok) {
      lastFailure = m.reason;
      continue;
    }
    if (!(await checkDailyCap(p))) {
      lastFailure = {
        ok: false,
        reason: 'daily_cap_reached',
        message: `Standing order #${p.id} hit its daily use cap.`,
        suggested_grants: [],
      };
      continue;
    }
    return {
      ok: true,
      permission_id: p.id,
      description: describePermission(p),
    };
  }
  return (
    lastFailure ?? {
      ok: false,
      reason: 'no_standing_order',
      message: `No matching standing order for "${kind}".`,
      suggested_grants: suggestedGrants(kind, params),
    }
  );
}

export interface GrantPermissionArgs {
  kind: PermissionKind;
  scope?: PermissionScope;
  expires_at?: string | null; // ISO
  granted_by_user_id?: string | null;
  granted_by_username?: string | null;
  granted_at_chat_id?: string | null;
  notes?: string | null;
}

export async function grantPermission(args: GrantPermissionArgs): Promise<Permission> {
  const row: Record<string, unknown> = {
    kind: args.kind,
    scope: args.scope ?? {},
    expires_at: args.expires_at ?? null,
    granted_by_user_id: args.granted_by_user_id ?? null,
    granted_by_username: args.granted_by_username ?? null,
    granted_at_chat_id: args.granted_at_chat_id ?? null,
    notes: args.notes ?? null,
  };
  const { data, error } = await supabase.from('agent_permissions').insert(row).select().single();
  if (error || !data) {
    throw new Error(`grantPermission failed: ${error?.message ?? 'no row returned'}`);
  }
  return data as Permission;
}

export async function revokePermission(id: number, reason: string | null = null): Promise<void> {
  const { error } = await supabase
    .from('agent_permissions')
    .update({ revoked_at: nowIso(), revoke_reason: reason })
    .eq('id', id)
    .is('revoked_at', null);
  if (error) throw new Error(`revokePermission failed: ${error.message}`);
}

export async function recordPermissionUsage(id: number): Promise<void> {
  const { data: row, error: readErr } = await supabase
    .from('agent_permissions')
    .select('uses_count')
    .eq('id', id)
    .single();
  if (readErr) {
    console.error('[PERMS] recordPermissionUsage read failed:', readErr.message);
    return;
  }
  const { error } = await supabase
    .from('agent_permissions')
    .update({
      uses_count: ((row?.uses_count as number | undefined) ?? 0) + 1,
      last_used_at: nowIso(),
    })
    .eq('id', id);
  if (error) console.error('[PERMS] recordPermissionUsage update failed:', error.message);
}

export function describePermission(p: Permission): string {
  const scopeBits: string[] = [];
  if (p.scope?.campaign_ids?.length) scopeBits.push(`campaigns: ${p.scope.campaign_ids.join(',')}`);
  if (p.scope?.campaign_name_match) scopeBits.push(`name~"${p.scope.campaign_name_match}"`);
  if (p.scope?.ad_account_ids?.length) scopeBits.push(`accounts: ${p.scope.ad_account_ids.join(',')}`);
  if (p.scope?.max_budget_change_pct != null) scopeBits.push(`±${p.scope.max_budget_change_pct}%`);
  if (p.scope?.max_daily_budget_cents != null)
    scopeBits.push(`max $${(p.scope.max_daily_budget_cents / 100).toFixed(0)}/day`);
  if (p.scope?.min_daily_budget_cents != null)
    scopeBits.push(`min $${(p.scope.min_daily_budget_cents / 100).toFixed(0)}/day`);
  if (p.scope?.max_uses_per_day != null) scopeBits.push(`${p.scope.max_uses_per_day}/day`);
  const exp = p.expires_at
    ? `expires ${p.expires_at.replace('T', ' ').slice(0, 16)}`
    : 'until revoked';
  const grantor = p.granted_by_username ? `@${p.granted_by_username}` : p.granted_by_user_id ?? '?';
  return `#${p.id} ${p.kind}${scopeBits.length ? ' [' + scopeBits.join(', ') + ']' : ''} — ${exp} — by ${grantor} — used ${p.uses_count}×`;
}

export function suggestedGrants(kind: PermissionKind, params: RequirePermissionParams): string[] {
  const out: string[] = [];
  if (params.campaign_name) {
    out.push(`/grant ${kind} campaign="${params.campaign_name}" expires=24h`);
  }
  out.push(`/grant ${kind} expires=24h  (any target, 24h)`);
  out.push(`/grant ${kind} expires=permanent  (DANGEROUS — until revoked)`);
  return out;
}

// ----- Parser for /grant slash command -----
//
//   /grant <kind> [campaign="..."] [campaign_id=...] [max_change_pct=N]
//                 [max_daily=$N] [min_daily=$N] [max_uses_per_day=N]
//                 [expires=24h|7d|permanent|<ISO>] [notes="..."]

export interface ParsedGrant {
  kind: PermissionKind;
  scope: PermissionScope;
  expires_at: string | null;
  notes: string | null;
}

export function parseGrantArgs(raw: string): ParsedGrant | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'Usage: /grant <kind> [campaign="..."] [expires=24h|7d|permanent] [notes="..."]' };

  // Split on whitespace but keep "quoted strings" together.
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of trimmed) {
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (cur) {
        parts.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);

  if (parts.length === 0) return { error: 'Missing kind.' };
  const kind = parts[0].toLowerCase();
  if (!isPermissionKind(kind)) {
    return {
      error: `Unknown kind "${parts[0]}". Valid: ${ALL_PERMISSION_KINDS.join(', ')}`,
    };
  }

  const scope: PermissionScope = {};
  let expiresAt: string | null = null;
  let notes: string | null = null;

  const stripQuotes = (s: string): string => s.replace(/^"(.*)"$/, '$1');

  for (const piece of parts.slice(1)) {
    const eq = piece.indexOf('=');
    if (eq === -1) return { error: `Bad token "${piece}" (expected key=value).` };
    const key = piece.slice(0, eq).toLowerCase();
    const val = stripQuotes(piece.slice(eq + 1));

    switch (key) {
      case 'campaign':
      case 'campaign_name':
        scope.campaign_name_match = val;
        break;
      case 'campaign_id':
        scope.campaign_ids = (scope.campaign_ids ?? []).concat(val.split(',').map((s) => s.trim()));
        break;
      case 'account':
      case 'ad_account_id':
        scope.ad_account_ids = (scope.ad_account_ids ?? []).concat(val.split(',').map((s) => s.trim()));
        break;
      case 'max_change_pct':
      case 'max_pct': {
        const n = Number(val);
        if (!Number.isFinite(n) || n <= 0) return { error: `max_change_pct must be a positive number.` };
        scope.max_budget_change_pct = n;
        break;
      }
      case 'max_daily': {
        const n = parseDollars(val);
        if (n == null) return { error: `max_daily must look like $50 or 5000.` };
        scope.max_daily_budget_cents = n;
        break;
      }
      case 'min_daily': {
        const n = parseDollars(val);
        if (n == null) return { error: `min_daily must look like $5 or 500.` };
        scope.min_daily_budget_cents = n;
        break;
      }
      case 'max_uses_per_day': {
        const n = parseInt(val, 10);
        if (!Number.isFinite(n) || n <= 0) return { error: `max_uses_per_day must be a positive integer.` };
        scope.max_uses_per_day = n;
        break;
      }
      case 'expires': {
        const e = parseExpires(val);
        if (e === 'invalid') return { error: `expires must be 24h, 7d, permanent, or ISO.` };
        expiresAt = e;
        break;
      }
      case 'notes':
        notes = val;
        break;
      default:
        return { error: `Unknown option "${key}".` };
    }
  }
  return { kind, scope, expires_at: expiresAt, notes };
}

function parseDollars(s: string): number | null {
  const m = s.replace(/^\$/, '');
  const n = Number(m);
  if (!Number.isFinite(n) || n < 0) return null;
  // If it looks like dollars (has decimal or under 100), assume dollars and convert.
  // Otherwise treat as cents.
  if (m.includes('.') || n < 1000) return Math.round(n * 100);
  return Math.round(n);
}

function parseExpires(s: string): string | null | 'invalid' {
  const v = s.toLowerCase().trim();
  if (v === 'permanent' || v === 'never' || v === 'until_revoked') return null;
  const rel = /^(\d+)([hdw])$/.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const mult = unit === 'h' ? 3600 : unit === 'd' ? 86400 : 7 * 86400;
    return new Date(Date.now() + n * mult * 1000).toISOString();
  }
  // Try ISO
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return 'invalid';
}
