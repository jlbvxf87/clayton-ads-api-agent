-- Memory + observations + goals + rules + briefings tables.
-- These were defined in schema.sql but never executed against the live DB,
-- so every recordMessage / noteObservation / setGoal call has been silently
-- failing. Run this once in the Supabase SQL editor.
--
-- All statements are idempotent — safe to re-run.

-- ---------- chat_messages ----------
create table if not exists chat_messages (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    chat_id text not null,
    role text not null check (role in ('user','assistant')),
    content text not null
);

alter table chat_messages add column if not exists from_user_id text;
alter table chat_messages add column if not exists from_username text;

create index if not exists idx_chat_messages_lookup
    on chat_messages (chat_id, created_at desc);

create index if not exists idx_chat_messages_user
    on chat_messages (from_user_id, created_at desc) where from_user_id is not null;

-- ---------- agent_observations ----------
create table if not exists agent_observations (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    chat_id text,
    topic text not null,
    observation text not null,
    confidence text default 'medium',
    superseded_by bigint references agent_observations(id) on delete set null
);

create index if not exists idx_agent_observations_topic
    on agent_observations (topic, created_at desc) where superseded_by is null;

-- ---------- agent_goals ----------
create table if not exists agent_goals (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    chat_id text,
    goal_key text not null,
    goal_value text not null,
    active boolean not null default true
);

create index if not exists idx_agent_goals_active
    on agent_goals (goal_key, created_at desc) where active = true;

-- ---------- agent_rules ----------
create table if not exists agent_rules (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    chat_id text,
    name text not null,
    description text not null,
    rule_kind text not null,
    params jsonb not null,
    auto_execute boolean not null default false,
    active boolean not null default true,
    last_evaluated_at timestamptz,
    last_triggered_at timestamptz,
    trigger_count int not null default 0
);

create index if not exists idx_agent_rules_active
    on agent_rules (active) where active = true;

-- ---------- agent_briefings ----------
create table if not exists agent_briefings (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    briefing_kind text not null check (briefing_kind in ('morning','recap','rule_alert','pulse')),
    chat_id text not null,
    content text not null,
    triggered_rule_ids bigint[]
);

create index if not exists idx_agent_briefings_recent
    on agent_briefings (chat_id, created_at desc);

-- Verify: this should return 7 tables.
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'campaign_snapshots','agent_actions','chat_messages',
    'agent_observations','agent_goals','agent_rules','agent_briefings'
  )
order by table_name;
