-- deployment-mode: rolling
-- Organization API integrations (docs/design/ownership-and-reach.md, OR-11):
-- an organization owner or admin adds an API integration (a curated
-- definition, or a custom OpenAPI or GraphQL API) once and picks where it
-- works, exactly like an organization MCP connector. It is the same kind of
-- row in organization_connectors, with the same reach, the same row
-- security, and the same "a workspace's own setup wins" rule; only `kind`
-- tells the readers which runtime builds it.
--
-- kind = 'api' rows keep the reviewed, compiled definition (tools and their
-- bindings, base URL, authentication) in custom_definition, so every
-- workspace it reaches runs exactly what the admin previewed, and a source
-- change never reaches workspaces without a new review.
--
-- Rolling: existing rows become kind = 'mcp', which is what they are. The
-- previous release does not know `kind`; it never runs an API row added
-- during the rollout, because that definition has no MCP endpoint, and at
-- most lists it as unavailable until it is replaced.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_connectors ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'mcp';

COMMENT ON COLUMN organization_connectors.kind IS 'mcp: a remote MCP connector. api: an API integration whose reviewed, compiled definition is custom_definition.';

ALTER TABLE organization_connectors
  ADD CONSTRAINT organization_connectors_kind_chk CHECK (
    kind IN ('mcp', 'api') AND (kind = 'mcp' OR custom_definition IS NOT NULL)
  ) NOT VALID;
