-- deployment-mode: rolling
-- Child lifecycle notices. A child session's requires_action freeze, its
-- resolution, a direct Pause, a provider-capacity wait, and an agent goal
-- progress note become typed `session_system_updates` rows for the parent, in
-- addition to the existing `child_terminal_result`. Every one of them is
-- produced through `session_system_update_outbox` by the child's own lifecycle
-- transaction and delivered to the parent by the worker.
--
-- Rolling: this only widens the accepted kind sets and adds one partial index.
-- No row is rewritten. A worker from before this change throws when it maps an
-- unknown kind, so the producers stay behind
-- OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED (default off) until the whole fleet
-- runs an image that understands the new kinds.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "session_system_updates" DROP CONSTRAINT "system_updates_kind_check";
ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_kind_check" CHECK (
  "kind" IN (
    'scheduled_occurrence', 'goal_continuation', 'agent_message',
    'agent_steer_instruction', 'child_terminal_result', 'media_generation_result',
    'child_requires_action', 'child_requires_action_resolved', 'child_paused',
    'child_waiting_capacity', 'child_progress'
  )
);

ALTER TABLE "session_system_update_outbox" DROP CONSTRAINT "system_update_outbox_kind_check";
ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_kind_check" CHECK (
  "kind" IN (
    'child_terminal_result', 'child_requires_action', 'child_requires_action_resolved',
    'child_paused', 'child_waiting_capacity', 'child_progress'
  )
);

ALTER TABLE "session_system_update_outbox" DROP CONSTRAINT "system_update_outbox_payload_kind_check";
ALTER TABLE "session_system_update_outbox" ADD CONSTRAINT "system_update_outbox_payload_kind_check" CHECK (
  "payload" ->> 'type' = "kind"
);

-- Producer-side supersession and resolution lookups address one child's still
-- pending notices of one kind on the parent: (parent session, kind, child id).
CREATE INDEX IF NOT EXISTS "session_system_updates_pending_kind_source_idx"
  ON "session_system_updates" ("workspace_id", "session_id", "kind", "source_id")
  WHERE "state" = 'pending';
