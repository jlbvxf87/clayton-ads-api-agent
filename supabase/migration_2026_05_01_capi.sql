-- Sprint 2.5: CAPI bridge — forward CIO events to Meta Conversions API.
-- Closes the gap where CIO knows about post-form events (booking, payment,
-- show) but Meta only sees the original Pixel form-submit. Meta then
-- optimizes on bad signal.
--
-- capi_config       — singleton row: pixel_id, enabled, defaults
-- capi_event_map    — which CIO event_name maps to which Meta event_name
-- capi_forwards     — audit trail of every CAPI POST (for dedup + debugging)
--
-- Idempotent.

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

insert into capi_config (id) values (1) on conflict (id) do nothing;

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

create index if not exists idx_capi_event_map_enabled
    on capi_event_map (cio_event_name) where enabled = true;

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

create index if not exists idx_capi_forwards_cio_event
    on capi_forwards (cio_event_name, created_at desc);

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('capi_config','capi_event_map','capi_forwards')
order by table_name;
