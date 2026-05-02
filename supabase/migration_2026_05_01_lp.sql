-- Sprint 5.5: landing-page intelligence.
-- Competitor list + daily snapshot + recommendation engine + lift tracker.
-- Idempotent.

create table if not exists lp_competitors (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    url text not null unique,
    label text,
    type text not null default 'landing_page'
        check (type in ('landing_page','ad_library','blog','other')),
    enabled boolean not null default true,
    notes text
);

create index if not exists idx_lp_competitors_enabled
    on lp_competitors (created_at desc) where enabled = true;

create table if not exists lp_snapshots (
    id bigserial primary key,
    competitor_id bigint references lp_competitors(id) on delete cascade,
    url text not null,
    captured_at timestamptz not null default now(),
    capture_source text not null default 'cron'
        check (capture_source in ('cron','manual','agent_tool')),
    screenshot_present boolean not null default false,
    screenshot_size_bytes int,
    rendered_html_excerpt text,
    raw_text_excerpt text,
    parsed_structure jsonb,
    analysis_model text,
    analysis_input_tokens int,
    analysis_output_tokens int,
    analysis_error text
);

create index if not exists idx_lp_snapshots_competitor
    on lp_snapshots (competitor_id, captured_at desc);

create index if not exists idx_lp_snapshots_recent
    on lp_snapshots (captured_at desc);

create table if not exists lp_recommendations (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    hypothesis text not null,
    evidence jsonb not null default '[]'::jsonb,
    competitor_evidence jsonb not null default '[]'::jsonb,
    claya_data_evidence jsonb not null default '[]'::jsonb,
    implementation_steps jsonb not null default '[]'::jsonb,
    expected_lift_band text check (expected_lift_band in ('low','medium','high')),
    expected_lift_pct numeric,
    priority int not null default 0,
    status text not null default 'proposed'
        check (status in ('proposed','sent','implemented','measured','rejected','superseded')),
    deploy_date date,
    pre_deploy_baseline jsonb,
    post_deploy_lift jsonb,
    notes text
);

create index if not exists idx_lp_recommendations_open
    on lp_recommendations (priority desc, created_at desc) where status in ('proposed','sent','implemented');

create index if not exists idx_lp_recommendations_recent
    on lp_recommendations (created_at desc);

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('lp_competitors','lp_snapshots','lp_recommendations')
order by table_name;
