-- deployment-mode: rolling
-- A turn recovered after worker shutdown, worker loss or a lost lease may send
-- new Codex model requests.
--
-- Recovery closes the interrupted attempt as `interrupted_recoverable` or
-- `lease_lost_recoverable` and runs the turn again in a new execution
-- generation from its durable checkpoint. A model request that was streaming
-- when the attempt stopped stays `unknown`, and the admission trigger refused
-- every request of the replacement, so a rolling deployment or a lost worker
-- failed each Codex turn in flight as not retryable. The closed attempt can no
-- longer write, so its ambiguous response is never consumed and a new request
-- is not a replay of it. Like a failed earlier generation, a recoverable
-- closed one no longer blocks admission. The request rows keep their recorded
-- outcome; a capacity or approval resume and an attempt without a closed
-- record stay fenced.
DO $recovery_after_interrupted_attempt$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.guard_subscription_disconnect_admission()'::regprocedure);
  anchor := $old$AND attempt.state = 'closed' AND attempt.outcome = 'failed')) THEN$old$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'Codex request admission source changed';
  END IF;
  EXECUTE replace(definition, anchor, $new$AND attempt.state = 'closed'
              AND attempt.outcome IN ('failed', 'interrupted_recoverable', 'lease_lost_recoverable'))) THEN$new$);
END
$recovery_after_interrupted_attempt$;
