-- deployment-mode: rolling
-- External users get the inbox. An external user is a product's own signed-in
-- user acting through the product's organization key (an `external_user:`
-- subject). The person rule (0656, 0661, 0677) only knew `user:` people, so a
-- product user's sessions reached no inbox and their questions, approvals,
-- paused goals and notifications were recorded as undelivered. An external
-- user now counts wherever a person did: the session's owner, else who started
-- it, else the owner of the schedule that ran it. The order is unchanged.
--
-- The inbox projection and native push delivery read these functions, so they
-- are not replaced here. Pushes to an external user find no device: only a
-- native-app sign-in of a `user:` person registers one. Signatures are
-- unchanged, so the previous release keeps calling the same functions.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Same signature as 0656; an external user is a person too.
CREATE OR REPLACE FUNCTION opengeni_private.session_recipient_v1(p_owner text, p_creator text)
RETURNS text LANGUAGE sql IMMUTABLE AS $recipient$
  SELECT CASE
    WHEN starts_with(p_owner, 'user:') OR starts_with(p_owner, 'external_user:') THEN p_owner
    WHEN starts_with(p_creator, 'user:') OR starts_with(p_creator, 'external_user:') THEN p_creator
  END
$recipient$;

-- Same signature and body as 0677, with an external user as a schedule owner.
CREATE OR REPLACE FUNCTION opengeni_private.session_person_v1(
  p_workspace_id uuid, p_session_id uuid, p_owner text, p_creator text
) RETURNS text LANGUAGE sql STABLE AS $person$
  SELECT coalesce(
    opengeni_private.session_recipient_v1(p_owner, p_creator),
    (SELECT task.owner_subject_id
     FROM scheduled_task_runs run
     JOIN scheduled_tasks task ON task.id = run.task_id
     WHERE run.workspace_id = p_workspace_id AND run.session_id = p_session_id
       AND (starts_with(task.owner_subject_id, 'user:')
         OR starts_with(task.owner_subject_id, 'external_user:'))
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

-- CREATE OR REPLACE resets the functions' settings; restore 0656's and 0677's.
REVOKE ALL ON FUNCTION opengeni_private.session_recipient_v1(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_person_v1(uuid, uuid, text, text) FROM PUBLIC;
DO $external_user_inbox_search_paths$
DECLARE
  target_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'session_recipient_v1(text,text)',
    'session_person_v1(uuid,uuid,text,text)'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp',
      signature, target_schema
    );
  END LOOP;
END $external_user_inbox_search_paths$;
