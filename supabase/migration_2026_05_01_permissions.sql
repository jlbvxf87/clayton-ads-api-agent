-- Sprint 1: standing-orders permission framework.
-- Lets the user pre-authorize Clayton for classes of write actions.
-- Every agent-initiated write tool consults agent_permissions before
-- executing; absent a matching grant, Clayton stages a one-time pending
-- and waits for explicit user confirmation.
--
-- Idempotent — safe to re-run.

create table if not exists agent_permissions (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    kind text not null,                  -- pause | resume | budget | create_* | clone_ad | targeting | audience | cio_event | rule
    scope jsonb not null default '{}'::jsonb,
    granted_by_user_id text,
    granted_by_username text,
    granted_at_chat_id text,
    expires_at timestamptz,              -- null = until revoked
    revoked_at timestamptz,
    revoke_reason text,
    notes text,
    uses_count int not null default 0,
    last_used_at timestamptz
);

-- NOTE: only revoked_at can sit in the partial-index predicate; now() isn't
-- IMMUTABLE so Postgres rejects it. Expiry filtering happens at query time.
create index if not exists idx_agent_permissions_active
    on agent_permissions (kind, created_at desc)
    where revoked_at is null;

create index if not exists idx_agent_permissions_grantor
    on agent_permissions (granted_by_user_id, created_at desc)
    where revoked_at is null;

-- Audit trail link: every action executed under a standing order
-- carries the permission_id forward into agent_actions.
alter table agent_actions add column if not exists permission_id bigint
    references agent_permissions(id) on delete set null;

create index if not exists idx_agent_actions_permission
    on agent_actions (permission_id, created_at desc)
    where permission_id is not null;

-- Verify
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'agent_permissions';
