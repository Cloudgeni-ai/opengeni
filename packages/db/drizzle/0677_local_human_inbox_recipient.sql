-- deployment-mode: rolling
-- Local installs get the inbox. A local install has one human, the fixed
-- subject `dev` of the built-in `opengeni:local`/`default` organization. Its
-- sessions are owned or started by `dev` (or run on a schedule `dev` owns),
-- never by a `user:` person, so the person rule (0656, 0661) found nobody and
-- nothing reached an inbox. The person a session works for now also resolves
-- `dev`, but only inside that exact local organization: the same subject name
-- anywhere else (a configured or development deployment, a key, a service)
-- still has no inbox. A `user:` person keeps precedence exactly as before.
--
-- The inbox projection and enqueue_native_push_v1 both read this function, so
-- they are not replaced here. Pushes to `dev` find no device: a push device is
-- registered only by a native-app managed-auth session, which only a `user:`
-- person has. Local phone pushes need their own pairing and relay first.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Same signature and body as 0661, plus the local install's human last.
CREATE OR REPLACE FUNCTION opengeni_private.session_person_v1(
  p_workspace_id uuid, p_session_id uuid, p_owner text, p_creator text
) RETURNS text LANGUAGE sql STABLE AS $person$
  SELECT coalesce(
    opengeni_private.session_recipient_v1(p_owner, p_creator),
    (SELECT task.owner_subject_id
     FROM scheduled_task_runs run
     JOIN scheduled_tasks task ON task.id = run.task_id
     WHERE run.workspace_id = p_workspace_id AND run.session_id = p_session_id
       AND task.owner_subject_id LIKE 'user:%'
     ORDER BY run.created_at DESC
     LIMIT 1),
    (SELECT 'dev'
     FROM workspaces workspace
     JOIN managed_accounts account ON account.id = workspace.account_id
     WHERE workspace.id = p_workspace_id
       AND account.external_source = 'opengeni:local'
       AND account.external_id = 'default'
       AND ('dev' IN (p_owner, p_creator) OR EXISTS (
         SELECT 1
         FROM scheduled_task_runs run
         JOIN scheduled_tasks task ON task.id = run.task_id
         WHERE run.workspace_id = p_workspace_id AND run.session_id = p_session_id
           AND task.owner_subject_id = 'dev'
       )))
  )
$person$;

-- CREATE OR REPLACE resets the function's settings; restore 0661's.
REVOKE ALL ON FUNCTION opengeni_private.session_person_v1(uuid, uuid, text, text) FROM PUBLIC;
DO $local_inbox_person_search_path$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.session_person_v1(uuid,uuid,text,text) SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
END $local_inbox_person_search_path$;
