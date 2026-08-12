-- deployment-mode: rolling
-- Shared capability and Integration definitions are globally readable catalog
-- data, not tenant lifecycle rows. Revoke ordinary runtime deletion authority
-- without narrowing the installation, binding, owner, or operation lifecycle.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE DELETE ON
      "capability_plugins",
      "capability_plugin_versions",
      "capability_facets",
      "capability_integration_facets",
      "capability_mcp_facets",
      "capability_api_facets",
      "capability_skill_facets",
      "capability_skill_files",
      "integration_spec_revisions",
      "integration_tools",
      "integration_feature_facets"
    FROM opengeni_app;

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "capability_plugin_installations",
      "capability_facet_installations",
      "capability_component_owners",
      "integration_feature_bindings",
      "integration_feature_binding_owners",
      "capability_operations"
    TO opengeni_app;
  END IF;
END $$;