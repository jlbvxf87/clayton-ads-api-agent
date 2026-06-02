-- Phase 1: Creative Intelligence + Customer Quality tables
-- 2026-05-31

-- Creative tagging — every ad gets structured metadata
create table if not exists ad_creative_tags (
  id                bigserial primary key,
  ad_id             text not null unique,
  ad_name           text,
  campaign_id       text,
  campaign_name     text,
  hook_type         text not null,   -- authority|fear|transformation|social_proof|curiosity|urgency|aspiration|education|ugc_personal
  emotional_angle   text not null,   -- fear_of_obesity|longevity|confidence|energy|medical_authority|fast_transformation|luxury_wellness|motherhood|self_improvement|clinical_proof
  format            text not null,   -- ugc_video|static_image|carousel|slideshow|text_only
  creator_led       boolean not null default false,
  claim_type        text not null,   -- clinical|testimonial|statistical|lifestyle|authority|comparative
  cta_language      text,
  hook_text         text,
  notes             text,
  tagged_by         text not null default 'auto',  -- auto|manual
  confidence        numeric(3,2) default 0.8,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Customer cohort quality — CPB (cost per retained customer) tracking
create table if not exists customer_cohorts (
  id                bigserial primary key,
  campaign_id       text not null,
  campaign_name     text,
  cohort_date       date not null,
  spend             numeric(10,2) default 0,
  lead_count        int default 0,
  intake_complete   int default 0,      -- completed full intake form
  approved_count    int default 0,      -- doctor approved
  rebill_count      int default 0,      -- rebilled at least once
  refund_count      int default 0,
  cpl               numeric(10,2),      -- cost per lead
  cpb               numeric(10,2),      -- cost per retained/billing customer
  intake_rate_pct   numeric(5,2),       -- intake_complete / lead_count
  approval_rate_pct numeric(5,2),       -- approved / intake_complete
  rebill_rate_pct   numeric(5,2),       -- rebill / approved
  data_source       text default 'cio', -- cio|manual
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique(campaign_id, cohort_date)
);

-- Spend tier log — track when campaigns cross spend thresholds
create table if not exists spend_tier_events (
  id                bigserial primary key,
  campaign_id       text not null,
  campaign_name     text,
  tier              text not null,    -- auto|approval|senior|founder
  daily_spend       numeric(10,2),
  triggered_at      timestamptz not null default now(),
  approved_by       text,
  approved_at       timestamptz
);

-- Creative fatigue predictions
create table if not exists creative_fatigue_predictions (
  id                bigserial primary key,
  ad_id             text not null,
  ad_name           text,
  campaign_id       text,
  frequency_at_flag numeric(5,2),
  ctr_at_flag       numeric(8,4),
  ctr_7d_baseline   numeric(8,4),
  days_to_fatigue   int,             -- estimated days remaining
  flagged_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  unique(ad_id, flagged_at)
);

-- Indexes
create index if not exists idx_creative_tags_campaign on ad_creative_tags(campaign_id);
create index if not exists idx_creative_tags_hook on ad_creative_tags(hook_type);
create index if not exists idx_creative_tags_angle on ad_creative_tags(emotional_angle);
create index if not exists idx_cohorts_campaign on customer_cohorts(campaign_id);
create index if not exists idx_cohorts_date on customer_cohorts(cohort_date desc);
create index if not exists idx_fatigue_ad on creative_fatigue_predictions(ad_id);
