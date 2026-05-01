import { supabase } from './supabase.js';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  from_user_id?: string | null;
  from_username?: string | null;
  created_at?: string;
}

export interface Observation {
  id?: number;
  topic: string;
  observation: string;
  confidence?: 'low' | 'medium' | 'high';
  created_at?: string;
}

export interface Goal {
  id?: number;
  goal_key: string;
  goal_value: string;
  active: boolean;
}

const HISTORY_LIMIT = 20;

let memoryWriteFailures = 0;
let memoryReadFailures = 0;

export function getMemoryFailureCounts(): { writes: number; reads: number } {
  return { writes: memoryWriteFailures, reads: memoryReadFailures };
}

function logMemoryError(label: string, err: { message?: string; code?: string } | null): void {
  if (!err) return;
  console.error(`[MEMORY] ${label} failed: code=${err.code ?? '?'} msg=${err.message ?? '?'}`);
}

export async function loadRecentMessages(chatId: number | string): Promise<StoredMessage[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, from_user_id, from_username, created_at')
    .eq('chat_id', String(chatId))
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) {
    memoryReadFailures++;
    logMemoryError('loadRecentMessages', error);
    return [];
  }
  return (data ?? []).reverse().map((r) => ({
    role: r.role as 'user' | 'assistant',
    content: r.content as string,
    from_user_id: (r.from_user_id as string | null) ?? null,
    from_username: (r.from_username as string | null) ?? null,
    created_at: r.created_at as string | undefined,
  }));
}

export interface RecordMessageOpts {
  fromUserId?: string | number | null;
  fromUsername?: string | null;
}

export async function recordMessage(
  chatId: number | string,
  role: 'user' | 'assistant',
  content: string,
  opts: RecordMessageOpts = {},
): Promise<void> {
  if (!content.trim()) return;
  const row: Record<string, unknown> = {
    chat_id: String(chatId),
    role,
    content,
  };
  if (opts.fromUserId != null) row.from_user_id = String(opts.fromUserId);
  if (opts.fromUsername) row.from_username = opts.fromUsername;

  const { error } = await supabase.from('chat_messages').insert(row);
  if (error) {
    memoryWriteFailures++;
    // If from_user_id/from_username columns don't exist yet, retry without them
    // so the core memory still works while the user runs the migration.
    const code = (error as { code?: string }).code;
    const msg = (error as { message?: string }).message ?? '';
    const columnMissing =
      code === 'PGRST204' ||
      code === '42703' ||
      msg.includes('from_user_id') ||
      msg.includes('from_username');
    if (columnMissing && (row.from_user_id || row.from_username)) {
      const { error: retryErr } = await supabase.from('chat_messages').insert({
        chat_id: String(chatId),
        role,
        content,
      });
      if (retryErr) logMemoryError('recordMessage(retry)', retryErr);
      return;
    }
    logMemoryError('recordMessage', error);
  }
}

export async function loadActiveObservations(topicPrefix?: string): Promise<Observation[]> {
  let q = supabase
    .from('agent_observations')
    .select('id, topic, observation, confidence, created_at')
    .is('superseded_by', null)
    .order('created_at', { ascending: false })
    .limit(50);
  if (topicPrefix) q = q.like('topic', `${topicPrefix}%`);

  const { data, error } = await q;
  if (error) {
    memoryReadFailures++;
    logMemoryError('loadActiveObservations', error);
    return [];
  }
  return (data ?? []) as Observation[];
}

export async function noteObservation(
  topic: string,
  observation: string,
  opts: {
    chatId?: number | string;
    confidence?: 'low' | 'medium' | 'high';
    supersedes?: number;
  } = {},
): Promise<number | null> {
  const { data, error } = await supabase
    .from('agent_observations')
    .insert({
      chat_id: opts.chatId != null ? String(opts.chatId) : null,
      topic,
      observation,
      confidence: opts.confidence ?? 'medium',
    })
    .select('id')
    .single();

  if (error) {
    memoryWriteFailures++;
    logMemoryError('noteObservation', error);
    return null;
  }
  if (opts.supersedes != null) {
    const { error: updErr } = await supabase
      .from('agent_observations')
      .update({ superseded_by: data.id })
      .eq('id', opts.supersedes);
    if (updErr) logMemoryError('noteObservation(supersede)', updErr);
  }
  return (data?.id as number) ?? null;
}

export async function loadActiveGoals(): Promise<Goal[]> {
  const { data, error } = await supabase
    .from('agent_goals')
    .select('id, goal_key, goal_value, active')
    .eq('active', true)
    .order('created_at', { ascending: false });

  if (error) {
    memoryReadFailures++;
    logMemoryError('loadActiveGoals', error);
    return [];
  }
  return (data ?? []) as Goal[];
}

export async function setGoal(
  goalKey: string,
  goalValue: string,
  chatId?: number | string,
): Promise<void> {
  const { error: deactivateErr } = await supabase
    .from('agent_goals')
    .update({ active: false })
    .eq('goal_key', goalKey)
    .eq('active', true);
  if (deactivateErr) logMemoryError('setGoal(deactivate)', deactivateErr);

  const { error: insertErr } = await supabase.from('agent_goals').insert({
    chat_id: chatId != null ? String(chatId) : null,
    goal_key: goalKey,
    goal_value: goalValue,
  });
  if (insertErr) {
    memoryWriteFailures++;
    logMemoryError('setGoal', insertErr);
  }
}
