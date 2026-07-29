-- deployment-mode: maintenance
-- Machine inputs become append-only model memory. This one-way cutover also
-- reconstructs every previously delivered batch and removes the old deferred
-- retry state; old workers must be drained before this migration runs.

ALTER TABLE "session_system_updates"
  ADD COLUMN "delivered_history_item_id" uuid;

UPDATE "session_system_updates"
SET "state" = 'pending'
WHERE "state" = 'deferred';

WITH ranked_pending_steers AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY workspace_id, session_id
      ORDER BY created_at DESC, id DESC
    ) AS rank
  FROM "session_system_updates"
  WHERE kind = 'agent_steer_instruction'
    AND state = 'pending'
)
UPDATE "session_system_updates" updates
SET state = 'superseded'
FROM ranked_pending_steers ranked
WHERE updates.id = ranked.id
  AND ranked.rank > 1;

ALTER TABLE "session_system_updates"
  DROP CONSTRAINT "system_updates_state_check";

ALTER TABLE "session_system_updates"
  ADD CONSTRAINT "system_updates_state_check"
  CHECK ("state" IN ('pending', 'delivered', 'cancelled', 'superseded', 'failed'));

WITH delivered_batches AS (
  SELECT
    updates.account_id,
    updates.workspace_id,
    updates.session_id,
    updates.delivered_turn_id AS turn_id,
    gen_random_uuid() AS history_item_id,
    min(updates.delivered_at) AS delivered_at,
    jsonb_build_object(
      'type', 'message',
      'role', 'system',
      'content',
        '[OpenGeni internal updates]' || E'\n' ||
        'These platform updates were delivered together for this inference. They are not human prompts.' || E'\n' ||
        jsonb_build_object(
          'updates',
          jsonb_agg(
            jsonb_build_object(
              'id', updates.id,
              'kind', updates.kind,
              'classification', updates.classification,
              'sourceId', updates.source_id,
              'summary', updates.summary,
              'payload', updates.payload,
              'lineage', updates.lineage
            )
            ORDER BY
              CASE WHEN updates.kind = 'agent_steer_instruction' THEN 1 ELSE 0 END,
              updates.created_at,
              updates.id
          )
        )::text
    ) AS item
  FROM "session_system_updates" updates
  WHERE updates.state = 'delivered'
    AND updates.delivered_turn_id IS NOT NULL
    AND updates.delivered_history_item_id IS NULL
  GROUP BY
    updates.account_id,
    updates.workspace_id,
    updates.session_id,
    updates.delivered_turn_id
),
anchored AS (
  SELECT
    batches.*,
    turns.position AS turn_position,
    turns.created_at AS turn_created_at,
    turns.id AS turn_order_id,
    NOT EXISTS (
      SELECT 1
      FROM "session_events" reset_event
      WHERE reset_event.workspace_id = batches.workspace_id
        AND reset_event.session_id = batches.session_id
        AND reset_event.type IN ('session.context.compacted', 'session.context.cleared')
        AND reset_event.occurred_at >= coalesce(batches.delivered_at, turns.created_at)
    ) AS preserve_active,
    (
      SELECT max(history.position)
      FROM "session_history_items" history
      WHERE history.workspace_id = batches.workspace_id
        AND history.session_id = batches.session_id
        AND history.turn_id = batches.turn_id
        AND history.active
        AND history.item ->> 'type' = 'message'
        AND history.item ->> 'role' = 'user'
    ) AS user_position,
    (
      SELECT min(history.position)
      FROM "session_history_items" history
      WHERE history.workspace_id = batches.workspace_id
        AND history.session_id = batches.session_id
        AND history.turn_id = batches.turn_id
        AND history.active
    ) AS turn_first_position,
    (
      SELECT coalesce(max(history.position), -1)
      FROM "session_history_items" history
      WHERE history.workspace_id = batches.workspace_id
        AND history.session_id = batches.session_id
        AND history.active
    ) AS active_tail_position,
    (
      SELECT coalesce(max(history.position), -1)
      FROM "session_history_items" history
      WHERE history.workspace_id = batches.workspace_id
        AND history.session_id = batches.session_id
    ) AS audit_tail_position,
    (
      SELECT max(history.position)
      FROM "session_history_items" history
      JOIN "session_turns" history_turn
        ON history_turn.workspace_id = history.workspace_id
       AND history_turn.id = history.turn_id
      WHERE history.workspace_id = batches.workspace_id
        AND history.session_id = batches.session_id
        AND history.active
        AND (history_turn.position, history_turn.created_at, history_turn.id)
          < (turns.position, turns.created_at, turns.id)
    ) AS previous_active_position,
    (
      SELECT min(history.position)
      FROM "session_history_items" history
      JOIN "session_turns" history_turn
        ON history_turn.workspace_id = history.workspace_id
       AND history_turn.id = history.turn_id
      WHERE history.workspace_id = batches.workspace_id
        AND history.session_id = batches.session_id
        AND history.active
        AND (history_turn.position, history_turn.created_at, history_turn.id)
          > (turns.position, turns.created_at, turns.id)
    ) AS next_active_position,
    row_number() OVER (
      PARTITION BY batches.workspace_id, batches.session_id
      ORDER BY turns.position, turns.created_at, turns.id
    ) AS turn_ordinal
  FROM delivered_batches batches
  JOIN "session_turns" turns
    ON turns.workspace_id = batches.workspace_id
   AND turns.id = batches.turn_id
),
gap_ranked AS (
  SELECT
    anchored.*,
    row_number() OVER (
      PARTITION BY
        workspace_id,
        session_id,
        preserve_active,
        user_position,
        turn_first_position,
        previous_active_position,
        next_active_position
      ORDER BY turn_position, turn_created_at, turn_order_id
    ) AS gap_ordinal,
    count(*) OVER (
      PARTITION BY
        workspace_id,
        session_id,
        preserve_active,
        user_position,
        turn_first_position,
        previous_active_position,
        next_active_position
    ) AS gap_count
  FROM anchored
),
positioned AS (
  SELECT
    gap_ranked.*,
    CASE
      WHEN NOT preserve_active THEN audit_tail_position + turn_ordinal
      WHEN user_position IS NOT NULL THEN
        user_position
          + (
            coalesce(
            (
              SELECT min(history.position)
              FROM "session_history_items" history
              WHERE history.workspace_id = gap_ranked.workspace_id
                AND history.session_id = gap_ranked.session_id
                AND history.position > user_position
            ),
            user_position + 1
          )
            - user_position
          ) * gap_ordinal / (gap_count + 1)
      WHEN turn_first_position IS NOT NULL THEN
        coalesce(
            (
              SELECT max(history.position)
              FROM "session_history_items" history
              WHERE history.workspace_id = gap_ranked.workspace_id
                AND history.session_id = gap_ranked.session_id
                AND history.position < turn_first_position
            ),
            turn_first_position - 2
          )
          + (
            turn_first_position
            - coalesce(
              (
                SELECT max(history.position)
                FROM "session_history_items" history
                WHERE history.workspace_id = gap_ranked.workspace_id
                  AND history.session_id = gap_ranked.session_id
                  AND history.position < turn_first_position
              ),
              turn_first_position - 2
            )
          ) * gap_ordinal / (gap_count + 1)
      WHEN previous_active_position IS NOT NULL AND next_active_position IS NOT NULL THEN
        previous_active_position
          + (next_active_position - previous_active_position) * gap_ordinal / (gap_count + 1)
      WHEN previous_active_position IS NOT NULL THEN
        previous_active_position + gap_ordinal
      WHEN next_active_position IS NOT NULL THEN
        next_active_position - (gap_count - gap_ordinal + 1)
      ELSE active_tail_position + gap_ordinal
    END AS history_position
  FROM gap_ranked
),
existing_gaps AS (
  SELECT
    positioned.*,
    coalesce(
      (
        SELECT max(history.position)
        FROM "session_history_items" history
        WHERE history.workspace_id = positioned.workspace_id
          AND history.session_id = positioned.session_id
          AND history.position < positioned.history_position
      ),
      positioned.history_position - 1
    ) AS existing_gap_left,
    coalesce(
      (
        SELECT min(history.position)
        FROM "session_history_items" history
        WHERE history.workspace_id = positioned.workspace_id
          AND history.session_id = positioned.session_id
          AND history.position > positioned.history_position
      ),
      positioned.history_position + 1
    ) AS existing_gap_right
  FROM positioned
),
final_positioned AS (
  SELECT
    existing_gaps.*,
    existing_gap_left
      + (existing_gap_right - existing_gap_left)
        * row_number() OVER (
          PARTITION BY
            workspace_id,
            session_id,
            existing_gap_left,
            existing_gap_right
          ORDER BY history_position, turn_position, turn_created_at, turn_order_id
        )
        / (
          count(*) OVER (
            PARTITION BY
              workspace_id,
              session_id,
              existing_gap_left,
              existing_gap_right
          ) + 1
        ) AS final_history_position
  FROM existing_gaps
),
inserted AS (
  INSERT INTO "session_history_items" (
    "id",
    "account_id",
    "workspace_id",
    "session_id",
    "turn_id",
    "position",
    "item",
    "active",
    "producer_codex_credential_id",
    "created_at"
  )
  SELECT
    history_item_id,
    account_id,
    workspace_id,
    session_id,
    turn_id,
    final_history_position,
    item,
    preserve_active,
    NULL,
    coalesce(delivered_at, now())
  FROM final_positioned
  RETURNING id, workspace_id, session_id, turn_id
)
UPDATE "session_system_updates" updates
SET "delivered_history_item_id" = inserted.id
FROM inserted
WHERE updates.workspace_id = inserted.workspace_id
  AND updates.session_id = inserted.session_id
  AND updates.delivered_turn_id = inserted.turn_id
  AND updates.state = 'delivered'
  AND updates.delivered_history_item_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "session_system_updates"
    WHERE state = 'delivered'
      AND delivered_history_item_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'cannot prove model-memory position for one or more delivered machine inputs';
  END IF;
END
$$;

ALTER TABLE "session_system_updates"
  ADD CONSTRAINT "session_system_updates_history_item_fk"
  FOREIGN KEY ("delivered_history_item_id")
  REFERENCES "session_history_items"("id")
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "session_system_updates"
  ADD CONSTRAINT "session_system_updates_delivery_history_check"
  CHECK (
    ("state" = 'delivered' AND "delivered_history_item_id" IS NOT NULL)
    OR
    ("state" <> 'delivered' AND "delivered_history_item_id" IS NULL)
  );

CREATE INDEX "session_system_updates_history_item_idx"
  ON "session_system_updates" ("workspace_id", "delivered_history_item_id")
  WHERE "delivered_history_item_id" IS NOT NULL;

CREATE UNIQUE INDEX "session_system_updates_one_pending_steer_idx"
  ON "session_system_updates" ("workspace_id", "session_id")
  WHERE "kind" = 'agent_steer_instruction' AND "state" = 'pending';
