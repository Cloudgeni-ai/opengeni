ALTER TABLE "session_command_receipts"
  DROP CONSTRAINT "session_command_receipts_actor_check",
  ADD CONSTRAINT "session_command_receipts_actor_check"
    CHECK (
      ("actor_type" = 'agent_attempt' AND "actor_attempt_id" IS NOT NULL
        AND "actor_subject_id" IS NULL)
      OR ("actor_type" IN ('human', 'operator', 'service')
        AND "actor_subject_id" IS NOT NULL
        AND "actor_attempt_id" IS NULL)
    );
