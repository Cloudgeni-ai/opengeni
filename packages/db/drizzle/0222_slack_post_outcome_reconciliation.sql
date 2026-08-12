-- deployment-mode: rolling
-- Slack does not guarantee that chat.postMessage retries are deduplicated by
-- client_msg_id. Split pre-provider admission from unknown provider outcomes,
-- and fence rolling old writers from reclaiming an unknown outcome for resend.

ALTER TABLE "slack_bot_post_operations"
  ADD COLUMN IF NOT EXISTS "claim_mode" text;

CREATE OR REPLACE FUNCTION opengeni_private.fence_slack_bot_post_claim_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  acquires_claim boolean;
BEGIN
  IF NEW."claim_holder_id" IS NULL THEN
    NEW."claim_mode" := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Rolling old writers insert directly at provider_started. They remain
    -- compatible for their first attempt, but any abandoned attempt is fenced
    -- by the UPDATE branch below.
    IF NEW."claim_mode" IS NULL AND NEW."status" IN ('pending', 'provider_started') THEN
      NEW."claim_mode" := 'send';
    END IF;
    RETURN NEW;
  END IF;

  acquires_claim :=
    OLD."claim_holder_id" IS NULL
    OR OLD."claim_holder_id" IS DISTINCT FROM NEW."claim_holder_id"
    OR OLD."claim_expires_at" IS NULL
    OR OLD."claim_expires_at" <= statement_timestamp();

  IF acquires_claim AND OLD."status" IN ('provider_started', 'outcome_unknown') THEN
    IF NEW."status" <> 'outcome_unknown' OR NEW."claim_mode" <> 'reconcile' THEN
      RAISE EXCEPTION
        'Slack post outcome requires reconciliation before another provider mutation'
        USING ERRCODE = '23514';
    END IF;
  ELSIF acquires_claim AND OLD."status" = 'pending' AND NEW."claim_mode" IS NULL THEN
    -- A rolling old writer may safely claim a request that never crossed the
    -- provider-admission boundary.
    NEW."claim_mode" := 'send';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION opengeni_private.fence_slack_bot_post_claim_mode() FROM PUBLIC;

DROP TRIGGER IF EXISTS slack_bot_post_operations_claim_mode_fence
  ON "slack_bot_post_operations";
CREATE TRIGGER slack_bot_post_operations_claim_mode_fence
  BEFORE INSERT OR UPDATE ON "slack_bot_post_operations"
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.fence_slack_bot_post_claim_mode();

UPDATE "slack_bot_post_operations"
SET "claim_mode" = 'send'
WHERE "claim_holder_id" IS NOT NULL
  AND "claim_mode" IS NULL
  AND "status" = 'provider_started';

ALTER TABLE "slack_bot_post_operations"
  DROP CONSTRAINT IF EXISTS "slack_bot_post_operations_status_check",
  DROP CONSTRAINT IF EXISTS "slack_bot_post_operations_identity_check",
  DROP CONSTRAINT IF EXISTS "slack_bot_post_operations_completion_check";

ALTER TABLE "slack_bot_post_operations"
  ADD CONSTRAINT "slack_bot_post_operations_status_check"
    CHECK ("status" IN ('pending', 'provider_started', 'outcome_unknown', 'completed'))
    NOT VALID,
  ADD CONSTRAINT "slack_bot_post_operations_identity_check"
    CHECK (
      "client_message_id" = "operation_id"
      AND length("target_id") BETWEEN 1 AND 64
      AND "request_digest" ~ '^[0-9a-f]{64}$'
      AND "attempt_count" > 0
      AND (
        (
          "claim_holder_id" IS NULL
          AND "claim_expires_at" IS NULL
          AND "claim_mode" IS NULL
        )
        OR (
          "claim_holder_id" IS NOT NULL
          AND "claim_expires_at" IS NOT NULL
          AND (
            ("claim_mode" = 'send' AND "status" IN ('pending', 'provider_started'))
            OR ("claim_mode" = 'reconcile' AND "status" = 'outcome_unknown')
          )
        )
      )
    ) NOT VALID,
  ADD CONSTRAINT "slack_bot_post_operations_completion_check"
    CHECK (
      (
        "status" <> 'completed'
        AND "slack_channel_id" IS NULL
        AND "slack_message_timestamp" IS NULL
        AND "completed_at" IS NULL
      )
      OR (
        "status" = 'completed'
        AND "claim_holder_id" IS NULL
        AND "claim_expires_at" IS NULL
        AND "claim_mode" IS NULL
        AND "slack_channel_id" IS NOT NULL
        AND "slack_message_timestamp" IS NOT NULL
        AND "completed_at" IS NOT NULL
      )
    ) NOT VALID;

ALTER TABLE "slack_bot_post_operations"
  VALIDATE CONSTRAINT "slack_bot_post_operations_status_check";
ALTER TABLE "slack_bot_post_operations"
  VALIDATE CONSTRAINT "slack_bot_post_operations_identity_check";
ALTER TABLE "slack_bot_post_operations"
  VALIDATE CONSTRAINT "slack_bot_post_operations_completion_check";