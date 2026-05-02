-- Sprint 5.5.1: own-property flag + lift measurement plumbing.
-- Adds is_own_property to lp_competitors so Clayton scrapes Claya's own
-- landing pages with the same depth as competitors and stops relying on
-- a hardcoded description.
--
-- Idempotent.

alter table lp_competitors
    add column if not exists is_own_property boolean not null default false;

create index if not exists idx_lp_competitors_own
    on lp_competitors (created_at desc) where is_own_property = true;

-- Verify
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'lp_competitors'
  and column_name = 'is_own_property';
