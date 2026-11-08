-- deployment-mode: rolling
-- Existing clients only read active modes; preparing rows are private to their owner.
ALTER TABLE session_realtime_modes ADD COLUMN incoming_call_id uuid;
ALTER TABLE session_realtime_modes ADD COLUMN incoming_call_device text;
ALTER TABLE session_realtime_modes DROP CONSTRAINT session_realtime_modes_state_check;
ALTER TABLE session_realtime_modes ADD CONSTRAINT session_realtime_modes_state_check
  CHECK (state IN ('preparing', 'active', 'ended')) NOT VALID;
ALTER TABLE session_realtime_modes DROP CONSTRAINT session_realtime_modes_terminal_check;
ALTER TABLE session_realtime_modes ADD CONSTRAINT session_realtime_modes_terminal_check
  CHECK ((state IN ('preparing', 'active') AND ended_at IS NULL AND end_reason IS NULL)
      OR (state = 'ended' AND ended_at IS NOT NULL AND end_reason IS NOT NULL)) NOT VALID;
ALTER TABLE session_realtime_modes ADD CONSTRAINT session_realtime_modes_incoming_call_check
  CHECK ((incoming_call_id IS NULL AND incoming_call_device IS NULL AND state <> 'preparing')
      OR (incoming_call_id IS NOT NULL AND length(incoming_call_device) BETWEEN 1 AND 300)) NOT VALID;
