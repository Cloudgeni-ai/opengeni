-- deployment-mode: rolling
-- Projects get the audiences chats have: the whole workspace, or only their
-- owner ("Only me"). An Only me project is visible to its owner alone, exactly
-- like an Only me chat: the owner, or an agent turn acting for them. Others,
-- workspace administrators included, do not see it or its name.
--
-- `visibility` defaults to 'workspace_shared', so every existing project keeps
-- the audience it has today and the previous release, which never writes these
-- columns, keeps creating shared projects.
--
-- An Only me project holds only its owner's own Only me chats and Only me
-- Sites; a shared project holds anything, as before. That keeps every place a
-- project shows up (the sidebar, filters, Insights) private by construction:
-- nobody else can see anything filed in an Only me project. The triggers below
-- keep it true whoever writes:
-- * A chat filed in an Only me project it does not fit is left unfiled, so a
--   chat that is shared later leaves its owner's Only me project.
-- * A Site placed in an Only me project it does not fit is refused, and a Site
--   that is shared later leaves it.
-- * A shared project cannot become Only me, and an owner never changes.
SET LOCAL lock_timeout = '5s';

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'workspace_shared',
  ADD COLUMN IF NOT EXISTS owner_subject_id text;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'channels_visibility_chk' AND conrelid = 'channels'::regclass
  ) THEN
    ALTER TABLE channels ADD CONSTRAINT channels_visibility_chk CHECK (
      visibility IN ('workspace_shared', 'user_private')
      AND (visibility = 'workspace_shared' OR owner_subject_id IS NOT NULL)
    );
  END IF;
END
$constraint$;

-- Names are unique within an audience: shared projects among themselves, and
-- each person's Only me projects among their own. A colleague's private name
-- therefore never blocks, or reveals itself to, anyone else. The shared index
-- keeps its name, so the previous release still recognises a duplicate.
DROP INDEX IF EXISTS channels_workspace_name_idx;
CREATE UNIQUE INDEX channels_workspace_name_idx
  ON channels (workspace_id, lower(name)) WHERE visibility = 'workspace_shared';
CREATE UNIQUE INDEX IF NOT EXISTS channels_owner_name_idx
  ON channels (workspace_id, owner_subject_id, lower(name)) WHERE visibility = 'user_private';

-- Who sees an Only me project: the same people who see its owner's Only me
-- chats (session_private_actor_visible_keys: the acting person, or the person
-- an agent turn acts for, while an active member with access here). A context
-- without a person (system work) sees every project, as it sees every chat.
DROP POLICY IF EXISTS channels_visibility_isolation ON channels;
CREATE POLICY channels_visibility_isolation ON channels AS RESTRICTIVE
  USING (
    nullif(current_setting('opengeni.subject_id', true), '') IS NULL
    OR visibility = 'workspace_shared'
    OR (
      workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      AND account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
      AND owner_subject_id = ANY (ARRAY(
        SELECT substr(actor_key, strpos(actor_key, ':') + 1)
        FROM unnest((SELECT session_private_actor_visible_keys())) AS actor_key
      ))
    )
  )
  WITH CHECK (
    nullif(current_setting('opengeni.subject_id', true), '') IS NULL
    OR visibility = 'workspace_shared'
    OR (
      workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      AND account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
      AND owner_subject_id = ANY (ARRAY(
        SELECT substr(actor_key, strpos(actor_key, ':') + 1)
        FROM unnest((SELECT session_private_actor_visible_keys())) AS actor_key
      ))
    )
  );

-- A shared project stays shared, and a project keeps its owner.
CREATE OR REPLACE FUNCTION channel_audience_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.visibility = 'workspace_shared' AND NEW.visibility = 'user_private' THEN
    RAISE EXCEPTION 'a shared project cannot be made Only me'
      USING ERRCODE = '23514', CONSTRAINT = 'channels_audience_widen_only';
  END IF;
  IF NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id THEN
    RAISE EXCEPTION 'a project keeps its owner'
      USING ERRCODE = '23514', CONSTRAINT = 'channels_audience_widen_only';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS channels_audience_guard ON channels;
CREATE TRIGGER channels_audience_guard
  BEFORE UPDATE OF visibility, owner_subject_id ON channels
  FOR EACH ROW EXECUTE FUNCTION channel_audience_guard();

-- A chat fits an Only me project only when it is that owner's Only me chat.
-- Otherwise it is left unfiled. Explicit filing is checked before it gets
-- here, so this catches a chat that is shared later, or whose owner changes.
-- A project this writer cannot see is left to the filing checks and the
-- foreign key: every filing path looks the project up as the person first.
CREATE OR REPLACE FUNCTION session_project_audience_fit() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE project_visibility text;
DECLARE project_owner text;
BEGIN
  SELECT project.visibility, project.owner_subject_id
    INTO project_visibility, project_owner
    FROM channels project
    WHERE project.id = NEW.channel_id AND project.workspace_id = NEW.workspace_id;
  IF project_visibility = 'user_private' AND NOT (
    NEW.visibility = 'user_private' AND NEW.owner_subject_id IS NOT DISTINCT FROM project_owner
  ) THEN
    NEW.channel_id := NULL;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS sessions_project_audience_fit ON sessions;
CREATE TRIGGER sessions_project_audience_fit
  BEFORE INSERT OR UPDATE OF channel_id, visibility, owner_subject_id ON sessions
  FOR EACH ROW WHEN (NEW.channel_id IS NOT NULL)
  EXECUTE FUNCTION session_project_audience_fit();

-- A Site fits an Only me project only when it is that owner's Only me Site.
-- Placing one that does not fit is refused (moves are explicit and checked
-- first); a Site shared later leaves the project, back to its chat's project.
CREATE OR REPLACE FUNCTION site_placement_project_audience_fit() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE project_visibility text;
DECLARE project_owner text;
BEGIN
  SELECT project.visibility, project.owner_subject_id
    INTO project_visibility, project_owner
    FROM channels project
    WHERE project.id = NEW.channel_id AND project.workspace_id = NEW.workspace_id;
  IF project_visibility = 'user_private' AND NOT EXISTS (
    SELECT 1 FROM workspace_artifacts site
    WHERE site.workspace_id = NEW.workspace_id AND site.id = NEW.site_id
      AND site.visibility = 'user_private' AND site.owner_subject_id = project_owner
  ) THEN
    RAISE EXCEPTION 'an Only me project holds only its owner''s Only me Sites'
      USING ERRCODE = '23514', CONSTRAINT = 'site_project_placements_audience_fit';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS site_project_placements_audience_fit ON site_project_placements;
CREATE TRIGGER site_project_placements_audience_fit
  BEFORE INSERT OR UPDATE OF channel_id ON site_project_placements
  FOR EACH ROW WHEN (NEW.channel_id IS NOT NULL)
  EXECUTE FUNCTION site_placement_project_audience_fit();

CREATE OR REPLACE FUNCTION site_audience_leaves_private_project() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  DELETE FROM site_project_placements placement
    USING channels project
    WHERE placement.workspace_id = NEW.workspace_id AND placement.site_id = NEW.id
      AND project.workspace_id = placement.workspace_id AND project.id = placement.channel_id
      AND project.visibility = 'user_private'
      AND NOT (
        NEW.visibility = 'user_private'
        AND NEW.owner_subject_id IS NOT DISTINCT FROM project.owner_subject_id
      );
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS workspace_artifacts_leave_private_project ON workspace_artifacts;
CREATE TRIGGER workspace_artifacts_leave_private_project
  AFTER UPDATE OF visibility, owner_subject_id ON workspace_artifacts
  FOR EACH ROW
  WHEN (
    OLD.visibility IS DISTINCT FROM NEW.visibility
    OR OLD.owner_subject_id IS DISTINCT FROM NEW.owner_subject_id
  )
  EXECUTE FUNCTION site_audience_leaves_private_project();

-- Sharing an Only me project must reach every open session list, like a
-- rename. Recreate the list hint trigger over the shown columns plus the
-- audience; an older binary only receives more hints, which it handles.
DROP TRIGGER IF EXISTS channels_list_update ON channels;
CREATE TRIGGER channels_list_update
  AFTER UPDATE OF name, description, avatar, pinned, sort_order, visibility ON channels
  FOR EACH ROW
  WHEN (
    old.name IS DISTINCT FROM new.name
    OR old.description IS DISTINCT FROM new.description
    OR old.avatar IS DISTINCT FROM new.avatar
    OR old.pinned IS DISTINCT FROM new.pinned
    OR old.sort_order IS DISTINCT FROM new.sort_order
    OR old.visibility IS DISTINCT FROM new.visibility
  )
  EXECUTE FUNCTION notify_session_list_change();
