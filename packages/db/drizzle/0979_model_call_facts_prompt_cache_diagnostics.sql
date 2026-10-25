-- deployment-mode: rolling
-- Per-call prompt-cache diagnostics so warm-cache misses can be explained and
-- alerted on per cause: a truncated wire fingerprint of the request (tools,
-- system prompt, chained history checkpoints), signed thinking blocks the
-- provider dropped, and the warm-miss classification against the previous
-- call of the same model in the session. A nullable column without default or
-- check is a catalog-only change; the previous release never writes it and
-- older facts stay null.
ALTER TABLE model_call_facts
  ADD COLUMN IF NOT EXISTS prompt_cache_diagnostics jsonb;
COMMENT ON COLUMN model_call_facts.prompt_cache_diagnostics IS
  'Prompt-cache observation (request fingerprint digests, dropped thinking blocks by reason) and warm-miss classification. Contains digests and counts only, never request text.';
