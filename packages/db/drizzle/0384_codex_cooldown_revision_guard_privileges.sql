-- deployment-mode: rolling
-- Trigger helpers are owner-internal implementation details. PostgreSQL grants
-- PUBLIC execute on new functions by default, so remove the inherited privilege
-- that exposed this guard to unrelated runtime roles.

REVOKE ALL ON FUNCTION opengeni_private.codex_cooldown_revision_guard() FROM PUBLIC;