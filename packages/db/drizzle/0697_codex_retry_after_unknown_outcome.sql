-- deployment-mode: rolling
-- An explicit Retry of a failed turn may send new Codex model requests.
--
-- The admission trigger refuses a model request while an earlier request of
-- the same turn has an unresolved outcome. That keeps automatic recovery from
-- replaying an ambiguous request: a replacement attempt after a lost worker
-- and a resumed generation after an approval or capacity wait stay fenced.
-- But a provider error that leaves one request `unknown` also fails the turn
-- as retryable, and Retry reruns that same turn in a new execution generation.
-- The fence then refused every request of the retry, so Retry could never
-- succeed. A failed attempt from an earlier generation was already surfaced to
-- the person as that failure, and a failed turn only runs again through an
-- explicit Retry, so its unresolved requests no longer block admission. The
-- request rows themselves are unchanged and keep their recorded outcome.
DO $retry_after_unknown$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.guard_subscription_disconnect_admission()'::regprocedure);
  anchor := $old$OR (prior.request_outcome = 'reserved' AND prior.attempt_id <> NEW.attempt_id))) THEN$old$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'Codex request admission source changed';
  END IF;
  EXECUTE replace(definition, anchor, $new$OR (prior.request_outcome = 'reserved' AND prior.attempt_id <> NEW.attempt_id))
          AND NOT EXISTS (SELECT 1 FROM session_turn_attempts attempt
            WHERE attempt.account_id = prior.account_id AND attempt.workspace_id = prior.workspace_id
              AND attempt.session_id = prior.session_id AND attempt.turn_id = prior.turn_id
              AND attempt.id = prior.attempt_id AND attempt.execution_generation < NEW.generation
              AND attempt.state = 'closed' AND attempt.outcome = 'failed')) THEN$new$);
END
$retry_after_unknown$;
