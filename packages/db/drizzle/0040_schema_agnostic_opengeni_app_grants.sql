-- Correct historical opengeni_app grant blocks that hardcoded `public`.
-- Embedded hosts run migrations with search_path pointed at their dedicated
-- data schema, so grants must target current_schema().

DO $$
DECLARE
  target_schema text := current_schema();
  owner_role text := current_user;
  app_role text := 'opengeni_app';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', target_schema, app_role);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I',
      target_schema,
      app_role
    );
    EXECUTE format(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',
      target_schema,
      app_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
      owner_role,
      target_schema,
      app_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I',
      owner_role,
      target_schema,
      app_role
    );
  END IF;
END $$;
