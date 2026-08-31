-- deployment-mode: rolling
--
-- PostgreSQL grants PUBLIC EXECUTE on newly created functions by default.
-- Migration 0383 added this trigger function after the dedicated runtime-role
-- grants were established, so every login could execute it through PUBLIC.
-- The trigger itself does not require caller EXECUTE authority; remove only
-- the unintended default grant without changing its behavior or ownership.

REVOKE ALL ON FUNCTION opengeni_private.codex_cooldown_revision_guard() FROM PUBLIC;