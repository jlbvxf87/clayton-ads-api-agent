import { supabase } from './supabase.js';

const REQUIRED_TABLES = [
  'campaign_snapshots',
  'agent_actions',
  'chat_messages',
  'agent_observations',
  'agent_goals',
  'agent_rules',
  'agent_briefings',
  'agent_permissions',
  'agent_inbox',
  'capi_config',
  'capi_event_map',
  'capi_forwards',
] as const;

export type TableName = (typeof REQUIRED_TABLES)[number];

export interface SchemaHealth {
  ok: boolean;
  missing: TableName[];
  optionalMissing: string[];
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  chat_messages: ['from_user_id', 'from_username'],
  agent_actions: ['permission_id'],
};

async function tableExists(name: TableName): Promise<boolean> {
  // NOTE: do not use { head: true } — supabase-js swallows 404s in HEAD mode
  // and returns { error: null, status: 204 }. A regular GET surfaces PGRST205.
  const { error } = await supabase.from(name).select('id').limit(1);
  if (!error) return true;
  if ((error as { code?: string }).code === 'PGRST205') return false;
  // Any other error (RLS, network) — table likely exists, just a different problem.
  return true;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const { error } = await supabase.from(table).select(column).limit(1);
  if (!error) return true;
  // 42703 = undefined column
  if ((error as { code?: string }).code === '42703') return false;
  const msg = (error as { message?: string }).message ?? '';
  if (msg.includes('does not exist') && msg.includes(column)) return false;
  return true;
}

export async function checkSchemaHealth(): Promise<SchemaHealth> {
  const missing: TableName[] = [];
  for (const t of REQUIRED_TABLES) {
    if (!(await tableExists(t))) missing.push(t);
  }
  const optionalMissing: string[] = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    if (missing.includes(table as TableName)) continue;
    for (const col of cols) {
      if (!(await columnExists(table, col))) optionalMissing.push(`${table}.${col}`);
    }
  }
  return { ok: missing.length === 0 && optionalMissing.length === 0, missing, optionalMissing };
}

export function formatSchemaBanner(h: SchemaHealth): string {
  if (h.ok) return `[MEMORY] schema OK — all ${REQUIRED_TABLES.length} tables present.`;
  const parts: string[] = [];
  parts.push('==========================================================');
  parts.push('[MEMORY DEGRADED] Supabase schema is incomplete.');
  if (h.missing.length > 0) parts.push(`  Missing tables: ${h.missing.join(', ')}`);
  if (h.optionalMissing.length > 0) parts.push(`  Missing columns: ${h.optionalMissing.join(', ')}`);
  parts.push('  Writes to these objects will silently fail.');
  parts.push('  Fix: run supabase/schema.sql in the Supabase SQL editor.');
  parts.push('==========================================================');
  return parts.join('\n');
}
