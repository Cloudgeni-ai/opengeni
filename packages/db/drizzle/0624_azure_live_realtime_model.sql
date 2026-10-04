-- deployment-mode: rolling
-- Admit configured Azure GPT Live WebRTC sessions.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE "session_realtime_modes"
  DROP CONSTRAINT "session_realtime_modes_model_check";

ALTER TABLE "session_realtime_modes"
  ADD CONSTRAINT "session_realtime_modes_model_check"
  CHECK (
    "model" IN (
      'opengeni-azure/gpt-live-1',
      'gpt-live-1-boulder-alpha',
      'supergrok/grok-voice-think-fast-2.0',
      'opengeni-gateway/openai/gpt-realtime-2.1',
      'opengeni-gateway/openai/gpt-realtime-mini',
      'opengeni-gateway/xai/grok-voice-think-fast-2.0',
      'workspace-gateway/openai/gpt-realtime-2.1',
      'workspace-gateway/openai/gpt-realtime-mini',
      'workspace-gateway/xai/grok-voice-think-fast-2.0'
    )
  ) NOT VALID;

ALTER TABLE "session_realtime_modes"
  VALIDATE CONSTRAINT "session_realtime_modes_model_check";

RESET statement_timeout;
RESET lock_timeout;
