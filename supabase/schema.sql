-- Facebook Ad Agent — Supabase schema
-- Run once in the Supabase SQL editor.

-- Hourly snapshots of every campaign.
create table if not exists campaign_snapshots (
    id bigserial primary key,
    snapshot_at timestamptz not null default now(),
    account_id text not null,
    campaign_id text not null,
    campaign_name text,
    status text,
    daily_budget_cents bigint,
    lifetime_budget_cents bigint,
    objective text,
    spend_today_cents bigint,
    leads_today int,
    impressions_today bigint,
    clicks_today bigint,
    ctr_today numeric,
    cpc_today numeric,
    cpm_today numeric,
    spend_yesterday_cents bigint,
    leads_yesterday int,
    raw jsonb
);

create index if not exists idx_campaign_snapshots_lookup
    on campaign_snapshots (account_id, snapshot_at desc);

create index if not exists idx_campaign_snapshots_campaign
    on campaign_snapshots (campaign_id, snapshot_at desc);

-- Per-chat conversation history (rolling memory for free-form Claude calls).
create table if not exists chat_messages (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    chat_id text not null,
    role text not null check (role in ('user','assistant')),
    content text not null
);

create index if not exists idx_chat_messages_lookup
    on chat_messages (chat_id, created_at desc);

-- Persistent observations the agent maintains about the account.
-- Things it learns over time: "Pixel was broken Aug-Oct 2025",
-- "Claya Images converts at $27 CPL", "user prefers we ask before pausing creative".
create table if not exists agent_observations (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    chat_id text,
    topic text not null,           -- short tag like 'pixel', 'pricing', 'preference', 'campaign:Claya Images'
    observation text not null,     -- the note itself, written by the agent
    confidence text default 'medium', -- 'low' | 'medium' | 'high'
    superseded_by bigint references agent_observations(id) on delete set null
);

create index if not exists idx_agent_observations_topic
    on agent_observations (topic, created_at desc) where superseded_by is null;

-- Goals the user has set for the account (target CPL, daily cap, etc.).
create table if not exists agent_goals (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    chat_id text,
    goal_key text not null,        -- 'cpl_target', 'daily_spend_cap', 'weekly_spend_cap', etc.
    goal_value text not null,      -- stored as text to keep flexible
    active boolean not null default true
);

create index if not exists idx_agent_goals_active
    on agent_goals (goal_key, created_at desc) where active = true;

-- Pre-approved automation rules.
-- auto_execute=false → agent only NOTIFIES when condition fires.
-- auto_execute=true  → agent EXECUTES the action (and notifies before/after).
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

-- Log of daily briefings + recaps sent.
create table if not exists agent_briefings (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    briefing_kind text not null check (briefing_kind in ('morning','recap','rule_alert')),
    chat_id text not null,
    content text not null,
    triggered_rule_ids bigint[]
);

create index if not exists idx_agent_briefings_recent
    on agent_briefings (chat_id, created_at desc);

-- Audit log for every write action the bot performs.
create table if not exists agent_actions (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    chat_id text,
    user_handle text,
    command text not null,
    target_campaign_id text,
    target_campaign_name text,
    before_state jsonb,
    after_state jsonb,
    meta_response jsonb,
    success boolean not null default false,
    error_message text
);

create index if not exists idx_agent_actions_recent
    on agent_actions (created_at desc);
