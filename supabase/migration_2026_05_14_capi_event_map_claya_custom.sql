-- Update capi_event_map with Claya's confirmed custom pixel event names.
-- Joshua confirmed 2026-05-14: they use custom events instead of standard Meta events.
--   Lead            = "Request Submitted"
--   AddToCart       = ATC01
--   InitiateCheckout= CKT01
--   AddPaymentInfo  = ADP01
--   Purchase        = "Payment completed"
--
-- cio_event_name: what claya.com fires into Customer.io (best guess — confirm
--   by doing a test form submission and checking CIO activity log).
-- meta_event_name: the custom event name sent to Meta pixel / CAPI.
--
-- All kept disabled until CIO pipe is confirmed live and cio_event_names
-- are verified against an actual test submission.

-- Remove the guessed seed rows
delete from capi_event_map
where cio_event_name in (
  'lead_captured', 'booking_created', 'booking_completed', 'purchase_completed'
);

-- Insert confirmed custom event mappings
insert into capi_event_map (cio_event_name, meta_event_name, action_source, enabled, notes)
values
  ('Request Submitted',  'Request Submitted',  'website',          false,
   'Confirmed 2026-05-14 by Josh. Replaces standard Lead event. Enable after CIO pipe verified.'),
  ('ATC01',             'ATC01',              'website',          false,
   'Confirmed 2026-05-14. Replaces standard AddToCart. Verify cio_event_name matches actual CIO event.'),
  ('CKT01',             'CKT01',              'website',          false,
   'Confirmed 2026-05-14. Replaces standard InitiateCheckout. Verify cio_event_name.'),
  ('ADP01',             'ADP01',              'website',          false,
   'Confirmed 2026-05-14. Replaces standard AddPaymentInfo. Verify cio_event_name.'),
  ('Payment completed', 'Payment completed',  'website',          false,
   'Confirmed 2026-05-14. Replaces standard Purchase. Verify cio_event_name.')
on conflict (cio_event_name) do update set
  meta_event_name = excluded.meta_event_name,
  notes           = excluded.notes;

select cio_event_name, meta_event_name, enabled from capi_event_map order by cio_event_name;
