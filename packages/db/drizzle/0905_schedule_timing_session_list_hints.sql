-- deployment-mode: rolling
-- Session lists now show a schedule icon only while an active schedule can
-- still run, which depends on the schedule spec (a one-time `runAt`, an
-- interval's `endAt`). 0888 sends list hints for schedule status, target and
-- audience changes, but not for an edit to the timing alone, so moving a
-- one-time run into the future left the icon stale until another change.
-- This adds a hint for spec changes using 0888's notify function, which sends
-- schedule changes as a workspace-wide hint. A row whose status and spec both
-- change fires both triggers with the same payload, which PostgreSQL folds
-- into one notification at commit.
SET LOCAL lock_timeout = '5s';

CREATE TRIGGER schedules_list_timing_update AFTER UPDATE OF schedule ON scheduled_tasks
FOR EACH ROW WHEN (OLD.schedule IS DISTINCT FROM NEW.schedule)
EXECUTE FUNCTION notify_session_list_change();
