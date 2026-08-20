-- deployment-mode: rolling
ALTER TABLE "channels"
  ADD COLUMN "pinned" boolean NOT NULL DEFAULT false;

CREATE INDEX "channels_workspace_pinned_name_idx"
  ON "channels" ("workspace_id", "pinned" DESC, "name", "id");
