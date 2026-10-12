-- deployment-mode: rolling
-- A published Site belongs to its workspace: every member who can list it can
-- read its versions and history. Migration 0225 installed a restrictive
-- "session_visibility_isolation" policy on every table with a foreign key to
-- sessions, which also caught the publication provenance columns of Site
-- versions and Site events (source_session_id). A Site published from an
-- "Only me" chat was therefore listed for the whole workspace while its
-- content stayed readable only by the chat's owner.
--
-- Provenance is not access control here. The API already redacts the source
-- chat, turn and attempt of a version or event for anyone who cannot read that
-- chat, so dropping the row policy exposes the published content only, never
-- the private chat. Workspace isolation is unchanged.
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS session_visibility_isolation ON workspace_artifact_versions;
DROP POLICY IF EXISTS session_visibility_isolation ON workspace_artifact_events;
