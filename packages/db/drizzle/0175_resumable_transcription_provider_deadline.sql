-- deployment-mode: rolling

ALTER TABLE "transcription_recording_segments"
  ADD COLUMN "attempt_deadline_at" timestamptz;

-- Rows already in flight when this migration rolls out retain the original
-- fifteen-minute reclaim fence. New attempts receive the shorter provider
-- deadline from the API claim path.
UPDATE "transcription_recording_segments"
SET "attempt_deadline_at" = "attempt_started_at" + interval '10 minutes'
WHERE "attempt_id" IS NOT NULL
  AND "attempt_started_at" IS NOT NULL
  AND "attempt_deadline_at" IS NULL;

ALTER TABLE "transcription_recording_segments"
  ADD CONSTRAINT "transcription_recording_segments_attempt_deadline_check"
  CHECK (
    ("attempt_id" IS NULL AND "attempt_started_at" IS NULL AND "attempt_deadline_at" IS NULL)
    OR (
      "attempt_id" IS NOT NULL
      AND "attempt_started_at" IS NOT NULL
      AND "attempt_deadline_at" IS NOT NULL
    )
  );