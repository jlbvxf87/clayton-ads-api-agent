import { supabase } from './supabase.js';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
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

export async function loadRecentMessages(chatId: number | string): Promise<StoredMessage[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('chat_id', String(chatId))
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) {
    console.warn('loadRecentMessages failed:', error.message);
    return [];
  }
  // reverse to chronological order so the oldest message comes first
  return (data ?? []).reverse().map((r) => ({
    role: r.role as 'user' | 'assistant',
    content: r.content as string,
  }));
}

export async function recordMessage(
  chatId: number | string,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  if (!content.trim()) return;
  const { error } = await supabase.from('chat_messages').insert({
    chat_id: String(chatId),
    role,
    content,
  });
  if (error) console.warn('recordMessage failed:', error.message);
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
    console.warn('loadActiveObservations failed:', error.message);
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
    console.warn('noteObservation failed:', error.message);
    return null;
  }
  if (opts.supersedes != null) {
    await supabase
      .from('agent_observations')
      .update({ superseded_by: data.id })
      .eq('id', opts.supersedes);
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
    console.warn('loadActiveGoals failed:', error.message);
    return [];
  }
  return (data ?? []) as Goal[];
}

export async function setGoal(
  goalKey: string,
  goalValue: string,
  chatId?: number | string,
): Promise<void> {
  // deactivate prior goals with this key, then insert the new one
  await supabase.from('agent_goals').update({ active: false }).eq('goal_key', goalKey).eq('active', true);
  await supabase.from('agent_goals').insert({
    chat_id: chatId != null ? String(chatId) : null,
    goal_key: goalKey,
    goal_value: goalValue,
  });
}
