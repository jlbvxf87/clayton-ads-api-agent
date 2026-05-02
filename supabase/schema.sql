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
    from_user_id text,
    from_username text,
    role text not null check (role in ('user','assistant')),
    content text not null
);

alter table chat_messages add column if not exists from_user_id text;
alter table chat_messages add column if not exists from_username text;

create index if not exists idx_chat_messages_lookup
    on chat_messages (chat_id, created_at desc);

create index if not exists idx_chat_messages_user
    on chat_messages (from_user_id, created_at desc) where from_user_id is not null;

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
    briefing_kind text not null check (briefing_kind in ('morning','recap','rule_alert','pulse')),
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
    error_message text,
    permission_id bigint
);

create index if not exists idx_agent_actions_recent
    on agent_actions (created_at desc);

create index if not exists idx_agent_actions_permission
    on agent_actions (permission_id, created_at desc)
    where permission_id is not null;

-- Rebalance plans: daily 9 AM / 6 PM PT proposals + execution audit.
create table if not exists agent_rebalance_plans (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    generated_by text not null check (generated_by in ('cron_morning','cron_evening','manual','agent_tool')),
    status text not null default 'proposed'
        check (status in ('proposed','applied','rejected','expired','superseded','partial')),
    metric text not null check (metric in ('cpl','cpb')),
    metric_reason text,
    account_avg_metric numeric,
    total_daily_before_cents bigint,
    total_daily_after_cents bigint,
    changes jsonb not null,
    rationale text,
    resolved_at timestamptz,
    resolved_by text,
    applied_changes jsonb,
    error_messages jsonb,
    notes text
);

create index if not exists idx_agent_rebalance_plans_recent
    on agent_rebalance_plans (created_at desc);

create index if not exists idx_agent_rebalance_plans_open
    on agent_rebalance_plans (created_at desc) where status = 'proposed';

-- Judgment-loop audit: every reasoning pass Clayton runs on an inbox signal.
create table if not exists agent_judgments (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    inbox_id bigint,
    signal_kind text,
    target_type text,
    target_id text,
    target_name text,
    primary_hypothesis text not null,
    alternative_hypotheses jsonb not null default '[]'::jsonb,
    evidence jsonb not null default '[]'::jsonb,
    caveats jsonb not null default '[]'::jsonb,
    recommended_action jsonb not null,
    confidence text not null check (confidence in ('low','medium','high')),
    rationale text not null,
    surfaced_to_telegram boolean not null default false,
    surfaced_at timestamptz,
    acted_on boolean not null default false,
    action_result jsonb,
    used_permission_id bigint,
    model text,
    input_tokens int,
    output_tokens int,
    raw_llm_response jsonb
);

create index if not exists idx_agent_judgments_target
    on agent_judgments (target_id, created_at desc) where target_id is not null;

create index if not exists idx_agent_judgments_recent
    on agent_judgments (created_at desc);

-- CAPI bridge: forward CIO events to Meta Conversions API.
create table if not exists capi_config (
    id int primary key default 1,
    pixel_id text,
    enabled boolean not null default false,
    default_action_source text not null default 'system_generated',
    default_event_source_url text,
    test_event_code text,
    notes text,
    updated_at timestamptz not null default now(),
    updated_by_user_id text,
    updated_by_username text,
    constraint capi_config_singleton check (id = 1)
);

create table if not exists capi_event_map (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    cio_event_name text not null unique,
    meta_event_name text not null,
    action_source text not null default 'system_generated',
    enabled boolean not null default true,
    config jsonb not null default '{}'::jsonb,
    notes text
);

create table if not exists capi_forwards (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    cio_activity_id text not null,
    cio_event_name text not null,
    meta_event_name text not null,
    pixel_id text not null,
    meta_event_id text not null,
    customer_id text,
    customer_email text,
    event_time bigint,
    success boolean not null default false,
    http_status int,
    meta_response jsonb,
    error_message text
);

create unique index if not exists idx_capi_forwards_dedup
    on capi_forwards (cio_activity_id, meta_event_id);

create index if not exists idx_capi_forwards_recent
    on capi_forwards (created_at desc);

-- Real-time monitor inbox — open signals (cpl_spike, zero_leads, etc.).
create table if not exists agent_inbox (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    signal_kind text not null,
    severity text not null check (severity in ('info','notice','alert','critical')),
    target_type text,
    target_id text,
    target_name text,
    current_value numeric,
    baseline_value numeric,
    delta_pct numeric,
    message text not null,
    data jsonb,
    surfaced_to_telegram boolean not null default false,
    surfaced_at timestamptz,
    resolved_at timestamptz,
    resolved_by text,
    resolution_note text,
    auto_action_taken boolean not null default false,
    auto_action_permission_id bigint
);

create index if not exists idx_agent_inbox_open
    on agent_inbox (signal_kind, target_id, last_seen_at desc)
    where resolved_at is null;

create unique index if not exists idx_agent_inbox_open_unique
    on agent_inbox (signal_kind, target_id)
    where resolved_at is null;

-- Standing-order permissions Clayton checks before any agent-initiated write.
create table if not exists agent_permissions (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    kind text not null,
    scope jsonb not null default '{}'::jsonb,
    granted_by_user_id text,
    granted_by_username text,
    granted_at_chat_id text,
    expires_at timestamptz,
    revoked_at timestamptz,
    revoke_reason text,
    notes text,
    uses_count int not null default 0,
    last_used_at timestamptz
);

create index if not exists idx_agent_permissions_active
    on agent_permissions (kind, created_at desc)
    where revoked_at is null;
