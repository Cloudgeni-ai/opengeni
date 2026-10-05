-- deployment-mode: rolling
-- Persist the exact credit/allowance refusal on a resumable recording and its
-- segment, so a reloaded recording still explains why it stopped. Widening an
-- allowed-value CHECK only; no row is rewritten.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE "transcription_recordings"
  DROP CONSTRAINT "transcription_recordings_error_code_check";

ALTER TABLE "transcription_recordings"
  ADD CONSTRAINT "transcription_recordings_error_code_check"
  CHECK ("error_code" IS NULL OR "error_code" IN (
    'permission_denied', 'not_supported', 'network', 'provider', 'policy_blocked',
    'timeout', 'cancelled', 'unavailable', 'too_large', 'invalid_audio', 'unknown',
    'insufficient_credits', 'allowance_exhausted', 'monthly_model_cost_limit'
  ));

ALTER TABLE "transcription_recording_segments"
  DROP CONSTRAINT "transcription_recording_segments_error_code_check";

ALTER TABLE "transcription_recording_segments"
  ADD CONSTRAINT "transcription_recording_segments_error_code_check"
  CHECK ("error_code" IS NULL OR "error_code" IN (
    'permission_denied', 'not_supported', 'network', 'provider', 'policy_blocked',
    'timeout', 'cancelled', 'unavailable', 'too_large', 'invalid_audio', 'unknown',
    'insufficient_credits', 'allowance_exhausted', 'monthly_model_cost_limit'
  ));
