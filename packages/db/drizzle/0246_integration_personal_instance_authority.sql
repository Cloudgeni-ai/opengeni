-- deployment-mode: rolling
-- Bind every personal Integration Facet instance Connection replacement to the
-- exact current Connection subject. The application also checks this before
-- its upsert; this trigger is the fail-closed boundary for direct SQL writers.

CREATE OR REPLACE FUNCTION capability_v2_validate_facet_binding()
RETURNS trigger
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

  IF NEW.connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM connections connection
    WHERE connection.id = NEW.connection_id
      AND connection.account_id = NEW.account_id
      AND connection.workspace_id = NEW.workspace_id
  ) THEN
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