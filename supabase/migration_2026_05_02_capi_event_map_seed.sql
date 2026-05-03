-- Pre-seed capi_event_map with the standard healthcare-funnel events Clayton
-- expects from Claya once their Customer.io integration is restored.
--
-- The CAPI bridge polls CIO every 10 minutes and forwards any matching event
-- to Meta. Without these mappings the bridge runs but does nothing — every
-- activity falls through `mapByName.get(a.name)` returning undefined.
--
-- These names are guesses based on standard CIO event conventions and the
-- existing AGENT.md vocabulary. Adjust via `/capi map` once Claya confirms
-- their actual event_name strings.
--
-- All four are inserted disabled (enabled=false). The /capi enable command
-- requires at least one enabled mapping AND the singleton config to be
-- enabled, so seeding disabled prevents accidental forwarding before names
-- are confirmed.
--
-- Idempotent — re-running won't duplicate.

insert into capi_event_map (cio_event_name, meta_event_name, action_source, enabled, notes)
values
  ('lead_captured',       'Lead',                  'website',          false,
   'Auto-seeded 2026-05-02. Confirm event_name with Claya before enabling.'),
  ('booking_created',     'Schedule',              'system_generated', false,
   'Auto-seeded 2026-05-02. Confirm event_name with Claya before enabling.'),
  ('booking_completed',   'CompleteRegistration',  'system_generated', false,
   'Auto-seeded 2026-05-02. Confirm event_name with Claya before enabling.'),
  ('purchase_completed',  'Purchase',              'system_generated', false,
   'Auto-seeded 2026-05-02. Confirm event_name with Claya before enabling.')
on conflict (cio_event_name) do nothing;

select cio_event_name, meta_event_name, enabled
from capi_event_map
order by cio_event_name;
