-- Sprint 2: real-time monitor inbox.
-- Continuous tick detects deltas (cpl spike, zero leads, ctr drop, spend velocity, etc.).
-- Each open observation lives as one row keyed by (signal_kind, target_id).
-- Auto-resolves itself when the condition stops holding.

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

create index if not exists idx_agent_inbox_recent
    on agent_inbox (created_at desc);

-- Only one open row per (signal_kind, target_id) — re-detections update last_seen_at.
create unique index if not exists idx_agent_inbox_open_unique
    on agent_inbox (signal_kind, target_id)
    where resolved_at is null;

select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'agent_inbox';
