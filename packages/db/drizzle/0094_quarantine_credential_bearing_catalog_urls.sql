-- deployment-mode: rolling
-- Catalog endpoints are public data. Remove opaque query/fragment/userinfo/path URLs
-- imported before the catalog hygiene gate and prevent their continued use.
DELETE FROM "capability_installations" AS "installation"
WHERE EXISTS (
  SELECT 1
  FROM "capability_catalog_items" AS "registry_item"
  WHERE
    "registry_item"."id" = "installation"."capability_id"
    AND "registry_item"."workspace_id" IS NULL
    AND "registry_item"."source" = 'registry'
    AND "registry_item"."metadata" ->> 'registry' = 'integrations.sh'
    AND (
      "registry_item"."endpoint_url" LIKE '%?%'
      OR "registry_item"."endpoint_url" LIKE '%#%'
      OR "registry_item"."endpoint_url" ~* '^https?://[^/?#]*@'
      OR "registry_item"."endpoint_url" ~* '^https?://[^/?#]+/(?:[^/?#]*/)*[^/?#]{24,}(?:/|$)'
      OR "registry_item"."mcp_url" LIKE '%?%'
      OR "registry_item"."mcp_url" LIKE '%#%'
      OR "registry_item"."mcp_url" ~* '^https?://[^/?#]*@'
      OR "registry_item"."mcp_url" ~* '^https?://[^/?#]+/(?:[^/?#]*/)*[^/?#]{24,}(?:/|$)'
    )
)
AND NOT EXISTS (
  SELECT 1
  FROM "capability_catalog_items" AS "workspace_item"
  WHERE
    "workspace_item"."workspace_id" = "installation"."workspace_id"
    AND "workspace_item"."id" = "installation"."capability_id"
);

DELETE FROM "capability_catalog_items"
WHERE
  "source" = 'registry'
  AND "metadata" ->> 'registry' = 'integrations.sh'
  AND (
    "endpoint_url" LIKE '%?%'
    OR "endpoint_url" LIKE '%#%'
    OR "endpoint_url" ~* '^https?://[^/?#]*@'
    OR "endpoint_url" ~* '^https?://[^/?#]+/(?:[^/?#]*/)*[^/?#]{24,}(?:/|$)'
    OR "mcp_url" LIKE '%?%'
    OR "mcp_url" LIKE '%#%'
    OR "mcp_url" ~* '^https?://[^/?#]*@'
    OR "mcp_url" ~* '^https?://[^/?#]+/(?:[^/?#]*/)*[^/?#]{24,}(?:/|$)'
  );

-- Earlier import diagnostics may contain the same URLs. Counts remain in their
-- dedicated columns; the unstructured diagnostic payload is not authoritative.
UPDATE "import_batches"
SET "details" = '{}'::jsonb, "updated_at" = NOW()
WHERE "source" = 'integrations.sh';
