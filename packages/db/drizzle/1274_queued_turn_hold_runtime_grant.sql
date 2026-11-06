-- deployment-mode: rolling
-- Grants the runtime role EXECUTE on the queued-turn hold summary, which 0988
-- created withheld: the previous release now knows it (its runtime posture
-- accepts it granted or withheld). Readiness requires it from this release on,
-- and the control worker publishes `opengeni_turns_queued_by_hold{hold}` and
-- `opengeni_turns_queued_oldest_age_seconds{hold}`. The `ready` class is the
-- only signal for a prompt that waits for dispatch before any turn-queue task
-- exists, which the Temporal turn-queue backlog cannot show.
--
-- Every configured application role gets it, as provisioning does.
DO $queued_turn_hold_runtime_grant$
DECLARE
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.summarize_queued_turns_by_hold() TO %I',
      application_role
    );
  END LOOP;
END $queued_turn_hold_runtime_grant$;
