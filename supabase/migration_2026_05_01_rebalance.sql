-- Sprint 4: rebalance plans audit + execution trail.
--
-- Daily 9 AM + 6 PM PT cron generates a banded rebalance proposal.
-- Each plan is one row here. Status flows: proposed -> applied | rejected
-- | superseded | expired | partial.
--
-- Idempotent.

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

select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'agent_rebalance_plans';
