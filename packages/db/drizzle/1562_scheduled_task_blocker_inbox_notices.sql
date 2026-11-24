-- deployment-mode: rolling
-- Tell an automation's owner in their inbox when it is blocked and has no
-- chat to carry the notice (docs/scheduled-admission-diagnostics.md, "Owner
-- notices").
--
-- A blocked automation's owner is told by a notification in its chat (the
-- blocked run's, the chat it runs in, or its latest run's). An automation
-- whose runs were all refused before their chats started, such as a pull
-- request reviewer whose first run is refused, has no chat, so until now its
-- owner was told nothing and it paused itself silently.
--
-- * `opengeni_private.sync_scheduled_task_blocker_inbox_notice_v1(task)`
--   opens one inbox notice for the automation's owner while its blocker
--   review holds a blocker with no chat notice (one per blocked episode,
--   keyed by the blocked run), and resolves it once the review clears, a
--   chat notice takes over, or the automation is deleted. A new owner gets
--   the notice instead of the old one. The notice is a
--   chat-less inbox item (1503) linking to the automation. Everything it says
--   comes from the review and the automation as stored, so a caller can only
--   make it tell the truth; it reads both through their workspace policies,
--   so it sees only the workspace the calling transaction is scoped to.
-- * AFTER triggers call it whenever a review is written with a new state,
--   blocked run or chat notice, or deleted (with its automation), and
--   whenever an automation is deleted (`deleted_at`) or changes owner. They run an
--   ordinary (invoker) trigger function: the runtime role's EXECUTE on the sync is
--   withheld for one release (DEFERRED_RUNTIME_PRIVATE_ROUTINES), because the
--   previous release refuses a runtime grant on a definer it doesn't know.
--   Until a later migration grants it, a review writes no inbox notice, as
--   before. A failure to notify never fails the review.
--
-- Rolling: a new definer nobody can call yet and a trigger that does nothing
-- until then; the previous release never reads either.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $scheduled_task_blocker_inbox_notices$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.sync_scheduled_task_blocker_inbox_notice_v1(p_task_id uuid)
    RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      v_review record;
      v_task record;
      v_prefix text := 'scheduled-task-blocker:' || p_task_id::text || ':';
      v_key text;
      v_title text;
      v_body text;
      v_item uuid;
    BEGIN
      SELECT review.account_id, review.workspace_id, review.state, review.message,
          review.blocked_run_id, review.notice_session_id
        INTO v_review
      FROM scheduled_task_blocker_reviews review
      WHERE review.task_id = p_task_id;
      SELECT task.name, task.owner_subject_id, task.deleted_at
        INTO v_task
      FROM scheduled_tasks task
      WHERE task.id = p_task_id;
      IF v_review.state IS NULL OR v_review.state = 'clear' OR v_review.message IS NULL
        OR v_review.blocked_run_id IS NULL OR v_review.notice_session_id IS NOT NULL
        OR v_task.owner_subject_id IS NULL OR v_task.deleted_at IS NOT NULL
      THEN
        -- Nothing blocks it, its chat carries the notice, or it is gone.
        UPDATE opengeni_private.inbox_items item
        SET status = 'resolved', resolved_at = now(), updated_at = now()
        WHERE item.session_id IS NULL AND item.kind = 'notification' AND item.status = 'open'
          AND item.source_key LIKE v_prefix || '%%';
        RETURN 0;
      END IF;
      -- One notice per blocked episode, to its current owner; an earlier
      -- episode's, or an earlier owner's, is settled.
      v_key := v_prefix || v_review.blocked_run_id::text;
      UPDATE opengeni_private.inbox_items item
      SET status = 'resolved', resolved_at = now(), updated_at = now()
      WHERE item.session_id IS NULL AND item.kind = 'notification' AND item.status = 'open'
        AND item.source_key LIKE v_prefix || '%%'
        AND (item.source_key <> v_key OR item.recipient_subject_id <> v_task.owner_subject_id);
      v_title := CASE WHEN v_review.state = 'paused'
        THEN 'Automation paused itself' ELSE 'Automation needs attention' END;
      v_body := v_review.message || CASE WHEN v_review.state = 'paused'
        THEN ' It stays paused until someone resumes it.' ELSE '' END;
      INSERT INTO opengeni_private.inbox_items AS item (
        account_id, workspace_id, session_id, recipient_subject_id, kind, source_key,
        title, subtitle, body, link, urgency
      ) VALUES (
        v_review.account_id, v_review.workspace_id, NULL, v_task.owner_subject_id,
        'notification', v_key, v_title,
        left(coalesce(nullif(btrim(v_task.name), ''), 'Automation'), 120),
        left(v_body, 2000),
        jsonb_build_object(
          'url', '/workspaces/' || v_review.workspace_id::text || '/automations?taskId='
            || p_task_id::text,
          'label', 'Open automation'),
        'normal'
      )
      ON CONFLICT (account_id, recipient_subject_id, kind, source_key)
        WHERE session_id IS NULL DO NOTHING
      RETURNING item.id INTO v_item;
      RETURN CASE WHEN v_item IS NULL THEN 0 ELSE 1 END;
    END
    $body$
  $definition$, data_schema);

  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.scheduled_task_blocker_inbox_notice()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      v_task_id uuid;
    BEGIN
      -- Separate statements: each row type has only its own fields.
      IF TG_TABLE_NAME = 'scheduled_tasks' THEN
        v_task_id := NEW.id;
      ELSIF TG_OP = 'DELETE' THEN
        v_task_id := OLD.task_id;
      ELSE
        v_task_id := NEW.task_id;
      END IF;
      -- Runs as the writing role, which may sync the notice once its
      -- EXECUTE is granted; until then nobody is told anything new, as before.
      IF pg_catalog.has_function_privilege(
        'opengeni_private.sync_scheduled_task_blocker_inbox_notice_v1(uuid)', 'EXECUTE')
      THEN
        PERFORM opengeni_private.sync_scheduled_task_blocker_inbox_notice_v1(v_task_id);
      END IF;
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      -- Telling the owner never decides the write.
      RAISE WARNING 'scheduled task blocker inbox notice skipped for %%: %%', v_task_id, SQLERRM;
      RETURN NULL;
    END
    $body$
  $definition$, data_schema);
END
$scheduled_task_blocker_inbox_notices$;

REVOKE ALL ON FUNCTION opengeni_private.sync_scheduled_task_blocker_inbox_notice_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.scheduled_task_blocker_inbox_notice() FROM PUBLIC;

CREATE TRIGGER scheduled_task_blocker_reviews_inbox_notice_insert_trg
  AFTER INSERT ON scheduled_task_blocker_reviews
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.scheduled_task_blocker_inbox_notice();

CREATE TRIGGER scheduled_task_blocker_reviews_inbox_notice_update_trg
  AFTER UPDATE ON scheduled_task_blocker_reviews
  FOR EACH ROW
  WHEN (NEW.state IS DISTINCT FROM OLD.state
    OR NEW.blocked_run_id IS DISTINCT FROM OLD.blocked_run_id
    OR NEW.notice_session_id IS DISTINCT FROM OLD.notice_session_id)
  EXECUTE FUNCTION opengeni_private.scheduled_task_blocker_inbox_notice();

CREATE TRIGGER scheduled_task_blocker_reviews_inbox_notice_delete_trg
  AFTER DELETE ON scheduled_task_blocker_reviews
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.scheduled_task_blocker_inbox_notice();

CREATE TRIGGER scheduled_tasks_blocker_inbox_notice_update_trg
  AFTER UPDATE OF deleted_at, owner_subject_id ON scheduled_tasks
  FOR EACH ROW
  WHEN (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id)
  EXECUTE FUNCTION opengeni_private.scheduled_task_blocker_inbox_notice();
