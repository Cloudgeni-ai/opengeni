-- deployment-mode: rolling
-- The stretches of a recording each track has no audio for: its source was
-- lost (a microphone unplugged, tab sharing ended) or joined late. Worked
-- out from the chunk rows' declared places on the timeline when the
-- recording is finalized, and by the worker for a recording finalized
-- before this column, so the transcript can say where a voice is missing
-- instead of looking like it missed words. Null until then.
--
-- Rolling: a nullable column the previous release never reads or writes.
ALTER TABLE recording_tracks ADD COLUMN IF NOT EXISTS unrecorded jsonb;
