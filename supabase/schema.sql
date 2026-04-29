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
