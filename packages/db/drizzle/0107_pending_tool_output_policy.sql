-- deployment-mode: rolling
-- Preserve the resolved exact-model tool-output policy with raw pending receipts
-- so any later recovery stores the same canonical model-facing bytes.
ALTER TABLE "session_pending_tool_calls"
  ADD COLUMN "model_tool_output_truncation_tokens" integer;
