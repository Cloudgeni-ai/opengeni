-- deployment-mode: rolling
-- A managed session background command records how to stop its process group.
--
-- An unsupervised command (every Modal command while native command
-- supervision is off) runs inside the turn shell wrapper, which writes its
-- process-group identity to a marker file named by a random token. Only the
-- turn that started the command knew that path, so once the command became a
-- session background command, Pause, terminal Cancel and an explicit stop
-- moved it to `stopping` but nothing could signal it: the reconciler only
-- waited for it to exit on its own. process_group_marker keeps the wrapper's
-- marker path, written once at adoption, so the reconciler can run the same
-- token/PGID-guarded TERM/KILL helper the turn used. NULL for supervised and
-- Connected Machine commands, and for rows adopted before this release.
--
-- Rolling: a nullable column without a default rewrites nothing, and the
-- previous release never reads or writes it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE session_background_commands
  ADD COLUMN process_group_marker text;
