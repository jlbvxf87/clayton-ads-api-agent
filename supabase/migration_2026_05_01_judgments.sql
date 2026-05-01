-- Sprint 3: judgment loop audit trail.
-- Every reasoning pass Clayton runs on an inbox signal stores its
-- hypothesis, evidence, recommendation, and confidence level here.
--
-- Idempotent.

create table if not exists agent_judgments (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    inbox_id bigint references agent_inbox(id) on delete set null,
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
    used_permission_id bigint references agent_permissions(id) on delete set null,

    model text,
    input_tokens int,
    output_tokens int,
    raw_llm_response jsonb
);

create index if not exists idx_agent_judgments_target
    on agent_judgments (target_id, created_at desc) where target_id is not null;

create index if not exists idx_agent_judgments_inbox
    on agent_judgments (inbox_id, created_at desc) where inbox_id is not null;

create index if not exists idx_agent_judgments_recent
    on agent_judgments (created_at desc);

select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'agent_judgments';
