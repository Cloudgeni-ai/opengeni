-- deployment-mode: rolling
-- Per-call timing measured by the worker, in milliseconds, so model speed
-- (time to first token, duration, output tokens per second) can be analysed
-- per call and per scope later. Nullable columns without defaults or checks:
-- adding them is a catalog-only change that rewrites and scans nothing, and the
-- previous release never writes them. Older facts and calls the worker did not
-- stream stay null.
ALTER TABLE model_call_facts
  ADD COLUMN IF NOT EXISTS pre_dispatch_ms integer,
  ADD COLUMN IF NOT EXISTS time_to_first_token_ms integer,
  ADD COLUMN IF NOT EXISTS time_to_first_text_ms integer,
  ADD COLUMN IF NOT EXISTS duration_ms integer;
COMMENT ON COLUMN model_call_facts.pre_dispatch_ms IS
  'Opengeni work from SDK model entry to provider dispatch, in milliseconds.';
COMMENT ON COLUMN model_call_facts.time_to_first_token_ms IS
  'Provider dispatch to the first streamed reasoning or answer fragment, in milliseconds.';
COMMENT ON COLUMN model_call_facts.time_to_first_text_ms IS
  'Provider dispatch to the first streamed answer text fragment, in milliseconds.';
COMMENT ON COLUMN model_call_facts.duration_ms IS
  'Provider dispatch to the terminal response as read by the worker, in milliseconds.';
