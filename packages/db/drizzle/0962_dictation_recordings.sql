-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: recordings holds one row per meeting or browser recording and the feature is days old, so validating in this file is instant.
-- Dictation moves onto recordings. Speech someone records to type it, such as
-- into the chat box, becomes a recording whose purpose is "dictation": private,
-- one microphone track, transcribed by the worker with the workspace's voice
-- input model, never listed and deleted a day after it is transcribed.
ALTER TABLE recordings DROP CONSTRAINT recordings_purpose_chk;
ALTER TABLE recordings ADD CONSTRAINT recordings_purpose_chk
  CHECK (
    purpose IN ('meeting', 'browser', 'dictation')
    AND (error_code IS NULL OR octet_length(error_code) BETWEEN 1 AND 128)
    AND (error_message IS NULL OR octet_length(error_message) BETWEEN 1 AND 2048)
  ) NOT VALID;
ALTER TABLE recordings VALIDATE CONSTRAINT recordings_purpose_chk;

-- Who a transcript's credit debit is attributed to, as the request that
-- asked for it established: a person, a chat turn or a service. Deployment-
-- funded transcription is admitted and settled against it in the worker.
ALTER TABLE recording_transcript_versions ADD COLUMN credit_attribution jsonb;
