-- deployment-mode: rolling
ALTER TABLE "channels"
  ADD COLUMN "sort_order" integer NOT NULL DEFAULT 0;

-- channels is FORCE-RLS. Migration backfills run as the schema owner without
-- workspace GUCs, so temporarily let only that owner see every row while the
-- deterministic project order is initialized, then restore the runtime fence.
ALTER TABLE "channels" NO FORCE ROW LEVEL SECURITY;

WITH ordered_channels AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "workspace_id"
      ORDER BY "pinned" DESC, "name" ASC, "id" ASC
    ) - 1 AS "sort_order"
  FROM "channels"
)
UPDATE "channels" AS channel_row
SET "sort_order" = ordered_channels."sort_order"
FROM ordered_channels
WHERE channel_row."id" = ordered_channels."id";

ALTER TABLE "channels" FORCE ROW LEVEL SECURITY;

CREATE INDEX "channels_workspace_pinned_order_idx"
  ON "channels" ("workspace_id", "pinned" DESC, "sort_order", "id");
