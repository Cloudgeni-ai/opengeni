-- deployment-mode: rolling
-- An update that keeps a facet binding's Connection and tenant is not checked
-- against the Connection again.
--
-- A new revision of an API Integration moves every instance of it in the
-- workspace to the new revision, including other people's personal instances
-- (installApiIntegration -> migrateApiIntegrationFacetInstallations). This
-- trigger looked the Connection up as the caller, and a personal Connection is
-- visible only to its owner under row-level security. So when one person
-- connected an integration at a newer revision than another person's personal
-- instance, moving that instance failed with "Facet binding Connection belongs
-- to another tenant", the install rolled back and the Connect attempt answered
-- 500.
--
-- The Connection was checked when it was bound. An update that keeps the same
-- Connection, account and workspace cannot move it to another tenant, so it is
-- not checked again. Inserts, and updates that change the Connection or the
-- tenant, are checked exactly as before, and the rule that a personal
-- instance's Connection cannot change owner is unchanged.
--
-- Rolling: same function name, signature and trigger; it only accepts updates
-- the previous definition refused, so the previous release is unaffected.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION capability_v2_validate_facet_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  previous_connection_subject_id text;
  requested_connection_subject_id text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM integration_facet_definitions definition
    JOIN capability_facet_installations installation
      ON installation.id = NEW.integration_facet_installation_id
     AND installation.facet_id = definition.integration_facet_id
    WHERE definition.id = NEW.facet_definition_id
      AND installation.account_id = NEW.account_id
      AND installation.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'Facet binding does not match its Integration installation or tenant'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.connection_id IS NOT NULL
    AND NOT (
      TG_OP = 'UPDATE'
      AND NEW.connection_id = OLD.connection_id
      AND NEW.account_id = OLD.account_id
      AND NEW.workspace_id = OLD.workspace_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM connections connection
      WHERE connection.id = NEW.connection_id
        AND connection.account_id = NEW.account_id
        AND connection.workspace_id = NEW.workspace_id
    )
  THEN
    RAISE EXCEPTION 'Facet binding Connection belongs to another tenant'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.connection_id IS NOT NULL
    AND NEW.connection_id IS DISTINCT FROM OLD.connection_id
  THEN
    SELECT connection.subject_id
    INTO previous_connection_subject_id
    FROM connections connection
    WHERE connection.id = OLD.connection_id
      AND connection.account_id = OLD.account_id
      AND connection.workspace_id = OLD.workspace_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Personal Integration instance belongs to another subject'
        USING ERRCODE = '42501';
    END IF;
    IF previous_connection_subject_id IS NOT NULL THEN
      IF NEW.connection_id IS NOT NULL THEN
        SELECT connection.subject_id
        INTO requested_connection_subject_id
        FROM connections connection
        WHERE connection.id = NEW.connection_id
          AND connection.account_id = NEW.account_id
          AND connection.workspace_id = NEW.workspace_id;
      END IF;
      IF requested_connection_subject_id IS DISTINCT FROM previous_connection_subject_id THEN
        RAISE EXCEPTION 'Personal Integration instance Connection ownership cannot be changed'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
