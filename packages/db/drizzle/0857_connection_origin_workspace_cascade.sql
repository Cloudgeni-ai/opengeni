-- deployment-mode: rolling
-- A connection's origin workspace is always its own workspace: the authority
-- trigger sets it from workspace_id on insert, both are immutable, and the
-- shape check requires it. Deleting that workspace already deletes the
-- connection through connections.workspace_id ON DELETE CASCADE.
--
-- The origin foreign key was ON DELETE SET NULL. PostgreSQL fires a deleted
-- workspace's foreign key actions in trigger-name order, and those names end in
-- the constraint OID compared as text. When the origin action ran before the
-- workspace cascade, it tried to update a live connection's origin to NULL, the
-- authority trigger refused ("connection owner authority is immutable"), and
-- the workspace could not be deleted. Which order a database gets depends only
-- on the OIDs it assigned, so some databases could never delete a workspace
-- that held a connection.
--
-- Cascading on the origin as well removes the same row either way, so deletion
-- no longer depends on trigger order, while the trigger keeps rejecting every
-- real change of a connection's owner authority or origin.
--
-- Rolling: only the delete action changes; no reader or writer sees a
-- difference, because origin_workspace_id always equals workspace_id.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "connections"
  DROP CONSTRAINT "connections_origin_workspace_fk",
  ADD CONSTRAINT "connections_origin_workspace_fk" FOREIGN KEY (
    "origin_workspace_id", "account_id"
  ) REFERENCES "workspaces"("id", "account_id")
    ON DELETE CASCADE NOT VALID;

ALTER TABLE "connections" VALIDATE CONSTRAINT "connections_origin_workspace_fk";
