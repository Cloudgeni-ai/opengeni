-- deployment-mode: rolling
-- Pause and Stop end an adopted Modal background command by its process group.
--
-- A turn wraps each sandbox command so it leads its own process group and
-- publishes its PID/PGID to a randomized marker file whose name (the token)
-- also appears in the leader's arguments. The turn uses that identity to
-- TERM-then-KILL its own commands. Once a long command becomes a session
-- background command, the turn that knew the identity is gone, and the lease
-- reaper had no way to signal an unsupervised Modal command: Pause/Stop only
-- marked it stopping and the process ran on until it exited by itself.
--
-- process_group_control keeps that identity ({"markerPath", "token"}) with the
-- background command, written once at adoption. The reaper reads it only to
-- run the same in-box helper; it is never returned by the API.
--
-- Rolling: a nullable column the previous release neither reads nor writes.
-- Rows adopted by the previous release keep NULL and keep today's behaviour.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE session_background_commands
  ADD COLUMN IF NOT EXISTS process_group_control jsonb;
