-- deployment-mode: rolling
-- Persist the requires_action open suffix on pending tool-call receipts so
-- resume can pair history without materializing an SDK generatedItems heap.
ALTER TABLE "session_pending_tool_calls"
  ADD COLUMN "interruption_kind" text,
  ADD COLUMN "tied_reasoning_items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "tied_reasoning_items_codec_version" integer;

ALTER TABLE "session_pending_tool_calls"
  ADD CONSTRAINT "session_pending_tool_calls_interruption_kind_chk" CHECK (
    "interruption_kind" IS NULL
    OR "interruption_kind" IN ('human_input', 'approval', 'interaction_intervention')
  );

ALTER TABLE "session_pending_tool_calls"
  ADD CONSTRAINT "session_pending_tool_calls_tied_reasoning_items_chk" CHECK (
    jsonb_typeof("tied_reasoning_items") = 'array'
  );
