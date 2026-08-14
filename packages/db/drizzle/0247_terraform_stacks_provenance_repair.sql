-- deployment-mode: maintenance
-- Repair the reviewed Terraform Stacks provenance URL embedded by migration
-- 0233 without rewriting published migration history. The affected Skill
-- facet and Plugin version are immutable, so all opengeni_app writers must be
-- stopped while the two exact metadata fields and manifest digest are repaired.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $maintenance_preflight_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'Terraform Stacks provenance repair requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_preflight_guard$;

LOCK TABLE capability_plugins IN ACCESS EXCLUSIVE MODE;
LOCK TABLE capability_plugin_versions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE capability_facets IN ACCESS EXCLUSIVE MODE;
LOCK TABLE capability_skill_facets IN ACCESS EXCLUSIVE MODE;
LOCK TABLE workspace_packs IN ACCESS EXCLUSIVE MODE;
LOCK TABLE pack_installations IN ACCESS EXCLUSIVE MODE;
LOCK TABLE pack_installation_components IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION opengeni_private.terraform_stacks_provenance_rewrite_pack(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $rewrite_pack$
DECLARE
  components jsonb;
BEGIN
  IF NOT (value ? 'components') THEN
    RETURN value;
  END IF;
  IF jsonb_typeof(value -> 'components') <> 'array' THEN
    RAISE EXCEPTION 'Pack components must be an array' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN component.value ->> 'kind' = 'plugin'
          AND component.value ->> 'pluginKey' = 'skill/library/terraform-stacks'
          AND component.value ->> 'version' = '0.0.1'
          AND component.value ->> 'manifestDigest' = 'd484ccc1279954e5dbcdd9b8b57bc21e6a0fa47d38dc11854ffcf8e61289e883'
        THEN jsonb_set(
          component.value,
          '{manifestDigest}',
          to_jsonb('3a58c98b725573b8fd524555b7ed9dbff04df4df9f8fad44e2e850bac3824809'::text),
          false
        )
        ELSE component.value
      END
      ORDER BY component.ordinality
    ),
    '[]'::jsonb
  )
  INTO components
  FROM jsonb_array_elements(value -> 'components') WITH ORDINALITY AS component(value, ordinality);
  RETURN jsonb_set(value, '{components}', components, false);
END
$rewrite_pack$;

-- Runtime stableJson() sorts keys with the default en-US Intl comparator and
-- preserves the input order of comparator-equal keys. jsonb_each ordinality is
-- the stable order emitted when the stored snapshot is read back into runtime.
-- The exact old-digest precondition below remains authoritative: an ICU/version
-- or scalar-rendering mismatch aborts before any row is changed.
CREATE COLLATION opengeni_private.terraform_stacks_provenance_js_en_us (
  provider = icu,
  locale = 'en-US',
  deterministic = false
);

CREATE OR REPLACE FUNCTION opengeni_private.terraform_stacks_provenance_canonical_json(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $canonical_json$
DECLARE
  rendered text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT COALESCE(
        '{' || string_agg(
          to_jsonb(entry.key)::text || ':' ||
            opengeni_private.terraform_stacks_provenance_canonical_json(entry.value),
          ',' ORDER BY
            entry.key COLLATE opengeni_private.terraform_stacks_provenance_js_en_us,
            entry.ordinality
        ) || '}',
        '{}'
      )
      INTO rendered
      FROM jsonb_each(value) WITH ORDINALITY AS entry(key, value, ordinality);
      RETURN rendered;
    WHEN 'array' THEN
      SELECT COALESCE(
        '[' || string_agg(
          opengeni_private.terraform_stacks_provenance_canonical_json(entry.value),
          ',' ORDER BY entry.ordinality
        ) || ']',
        '[]'
      )
      INTO rendered
      FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(value, ordinality);
      RETURN rendered;
    ELSE
      RETURN value::text;
  END CASE;
END
$canonical_json$;

DO $provenance_precondition$
DECLARE
  old_url constant text := 'https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/code-generation/skills/terraform-stacks';
  new_url constant text := 'https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/module-generation/skills/terraform-stacks';
  old_digest constant text := 'd484ccc1279954e5dbcdd9b8b57bc21e6a0fa47d38dc11854ffcf8e61289e883';
  new_digest constant text := '3a58c98b725573b8fd524555b7ed9dbff04df4df9f8fad44e2e850bac3824809';
  old_manifest constant jsonb := '{"schemaVersion":1,"kind":"skill","source":"library","sourceUrl":"https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/code-generation/skills/terraform-stacks","repositoryUrl":"https://github.com/hashicorp/agent-skills","version":"0.0.1","sourceCommit":"de4323afdfbc30d1387f287b55062fa8d82b62e8","sourcePath":"terraform-stacks","sourceProvenance":"Vendored from hashicorp/agent-skills; reviewed immutable opt-in entry.","contentSha256":"0a6244ecddf1cce0357db41b41b3b20a1bfa71f331092ebc8bbd15e649733d35","fileCount":7,"totalBytes":104793}'::jsonb;
  new_manifest constant jsonb := '{"schemaVersion":1,"kind":"skill","source":"library","sourceUrl":"https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/module-generation/skills/terraform-stacks","repositoryUrl":"https://github.com/hashicorp/agent-skills","version":"0.0.1","sourceCommit":"de4323afdfbc30d1387f287b55062fa8d82b62e8","sourcePath":"terraform-stacks","sourceProvenance":"Vendored from hashicorp/agent-skills; reviewed immutable opt-in entry.","contentSha256":"0a6244ecddf1cce0357db41b41b3b20a1bfa71f331092ebc8bbd15e649733d35","fileCount":7,"totalBytes":104793}'::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM capability_skill_facets skill
    JOIN capability_facets facet ON facet.id = skill.facet_id
    JOIN capability_plugin_versions version ON version.id = facet.plugin_version_id
    JOIN capability_plugins plugin ON plugin.id = version.plugin_id
    WHERE skill.capability_id = 'skill:terraform-stacks'
      AND (
        plugin.plugin_key <> 'skill/library/terraform-stacks'
        OR version.version <> '0.0.1'
        OR facet.facet_key <> 'skill'
        OR facet.kind <> 'skill'
        OR skill.name <> 'terraform-stacks'
        OR skill.description <>
          'Create, modify, validate, and troubleshoot Terraform Stack component and deployment configurations.'
        OR skill.source_url NOT IN (old_url, new_url)
        OR skill.source_commit <> 'de4323afdfbc30d1387f287b55062fa8d82b62e8'
        OR skill.source_path <> 'terraform-stacks'
        OR skill.content_sha256 <> '0a6244ecddf1cce0357db41b41b3b20a1bfa71f331092ebc8bbd15e649733d35'
        OR skill.file_count <> 7
        OR skill.total_bytes <> 104793
        OR skill.license IS DISTINCT FROM 'MPL-2.0'
        OR NOT (
          (version.manifest = old_manifest AND version.manifest_digest = old_digest)
          OR (version.manifest = new_manifest AND version.manifest_digest = new_digest)
        )
      )
  ) THEN
    RAISE EXCEPTION 'Terraform Stacks provenance repair found unexpected immutable state'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workspace_packs pack,
      LATERAL jsonb_array_elements(COALESCE(pack.manifest -> 'components', '[]'::jsonb)) component
    WHERE component ->> 'pluginKey' = 'skill/library/terraform-stacks'
      AND component ->> 'version' = '0.0.1'
      AND (
        component ->> 'kind' IS DISTINCT FROM 'plugin'
        OR (
          component ->> 'manifestDigest' IS DISTINCT FROM old_digest
          AND component ->> 'manifestDigest' IS DISTINCT FROM new_digest
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pack_installations installation,
      LATERAL jsonb_array_elements(
        COALESCE(installation.manifest_snapshot -> 'components', '[]'::jsonb)
      ) component
    WHERE installation.manifest_snapshot IS NOT NULL
      AND component ->> 'pluginKey' = 'skill/library/terraform-stacks'
      AND component ->> 'version' = '0.0.1'
      AND (
        component ->> 'kind' IS DISTINCT FROM 'plugin'
        OR (
          component ->> 'manifestDigest' IS DISTINCT FROM old_digest
          AND component ->> 'manifestDigest' IS DISTINCT FROM new_digest
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pack_installation_components component
    WHERE (
        component.capability_id = 'plugin:skill/library/terraform-stacks'
        OR component.metadata ->> 'pluginKey' = 'skill/library/terraform-stacks'
        OR EXISTS (
          SELECT 1
          FROM capability_plugin_installations installation
          JOIN capability_plugins plugin ON plugin.id = installation.plugin_id
          WHERE installation.id::text = component.resolved_id
            AND plugin.plugin_key = 'skill/library/terraform-stacks'
        )
      )
      AND (
        component.kind IS DISTINCT FROM 'plugin'
        OR component.capability_id IS DISTINCT FROM
          'plugin:skill/library/terraform-stacks'
        OR component.metadata ->> 'pluginKey' IS DISTINCT FROM
          'skill/library/terraform-stacks'
        OR component.metadata ->> 'version' IS DISTINCT FROM '0.0.1'
        OR (
          component.digest IS DISTINCT FROM old_digest
          AND component.digest IS DISTINCT FROM new_digest
        )
      )
  ) THEN
    RAISE EXCEPTION 'Terraform Stacks provenance repair found unexpected Pack state'
      USING ERRCODE = '23514';
  END IF;
END
$provenance_precondition$;

ALTER TABLE capability_skill_facets
  DISABLE TRIGGER capability_skill_facets_immutable;
ALTER TABLE capability_plugin_versions
  DISABLE TRIGGER capability_plugin_versions_restrict_update;

UPDATE capability_skill_facets skill
SET source_url = 'https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/module-generation/skills/terraform-stacks'
FROM capability_facets facet
JOIN capability_plugin_versions version ON version.id = facet.plugin_version_id
JOIN capability_plugins plugin ON plugin.id = version.plugin_id
WHERE skill.facet_id = facet.id
  AND skill.capability_id = 'skill:terraform-stacks'
  AND plugin.plugin_key = 'skill/library/terraform-stacks'
  AND version.version = '0.0.1'
  AND skill.source_url = 'https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/code-generation/skills/terraform-stacks';

UPDATE capability_plugin_versions version
SET manifest = '{"schemaVersion":1,"kind":"skill","source":"library","sourceUrl":"https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/module-generation/skills/terraform-stacks","repositoryUrl":"https://github.com/hashicorp/agent-skills","version":"0.0.1","sourceCommit":"de4323afdfbc30d1387f287b55062fa8d82b62e8","sourcePath":"terraform-stacks","sourceProvenance":"Vendored from hashicorp/agent-skills; reviewed immutable opt-in entry.","contentSha256":"0a6244ecddf1cce0357db41b41b3b20a1bfa71f331092ebc8bbd15e649733d35","fileCount":7,"totalBytes":104793}'::jsonb,
    manifest_digest = '3a58c98b725573b8fd524555b7ed9dbff04df4df9f8fad44e2e850bac3824809'
FROM capability_facets facet
JOIN capability_skill_facets skill ON skill.facet_id = facet.id
CROSS JOIN capability_plugins plugin
WHERE facet.plugin_version_id = version.id
  AND plugin.id = version.plugin_id
  AND skill.capability_id = 'skill:terraform-stacks'
  AND plugin.plugin_key = 'skill/library/terraform-stacks'
  AND version.version = '0.0.1'
  AND version.manifest = '{"schemaVersion":1,"kind":"skill","source":"library","sourceUrl":"https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/code-generation/skills/terraform-stacks","repositoryUrl":"https://github.com/hashicorp/agent-skills","version":"0.0.1","sourceCommit":"de4323afdfbc30d1387f287b55062fa8d82b62e8","sourcePath":"terraform-stacks","sourceProvenance":"Vendored from hashicorp/agent-skills; reviewed immutable opt-in entry.","contentSha256":"0a6244ecddf1cce0357db41b41b3b20a1bfa71f331092ebc8bbd15e649733d35","fileCount":7,"totalBytes":104793}'::jsonb
  AND version.manifest_digest = 'd484ccc1279954e5dbcdd9b8b57bc21e6a0fa47d38dc11854ffcf8e61289e883';

UPDATE workspace_packs pack
SET manifest = opengeni_private.terraform_stacks_provenance_rewrite_pack(pack.manifest)
WHERE pack.manifest IS DISTINCT FROM
  opengeni_private.terraform_stacks_provenance_rewrite_pack(pack.manifest);

CREATE TEMP TABLE terraform_stacks_pack_snapshot_repair ON COMMIT DROP AS
SELECT
  installation.id,
  installation.manifest_snapshot AS previous_manifest_snapshot,
  installation.manifest_digest AS previous_manifest_digest,
  opengeni_private.terraform_stacks_provenance_rewrite_pack(
    installation.manifest_snapshot
  ) AS manifest_snapshot,
  encode(
    digest(
      convert_to(
        opengeni_private.terraform_stacks_provenance_canonical_json(
          opengeni_private.terraform_stacks_provenance_rewrite_pack(
            installation.manifest_snapshot
          )
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) AS manifest_digest
FROM pack_installations installation
WHERE installation.manifest_snapshot IS NOT NULL
  AND installation.manifest_snapshot IS DISTINCT FROM
    opengeni_private.terraform_stacks_provenance_rewrite_pack(
      installation.manifest_snapshot
    );

DO $pack_digest_precondition$
BEGIN
  -- The repair changes only one same-shaped JSON string value. Reproducing the
  -- already-stored runtime digest proves this renderer's bytes for every other
  -- key and value in that exact snapshot before it computes the new digest.
  IF EXISTS (
    SELECT 1
    FROM terraform_stacks_pack_snapshot_repair repaired
    WHERE repaired.previous_manifest_digest IS DISTINCT FROM encode(
      digest(
        convert_to(
          opengeni_private.terraform_stacks_provenance_canonical_json(
            repaired.previous_manifest_snapshot
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
  ) THEN
    RAISE EXCEPTION
      'Terraform Stacks provenance repair cannot reproduce the stored runtime Pack digest'
      USING ERRCODE = '23514';
  END IF;
END
$pack_digest_precondition$;

UPDATE pack_installations installation
SET manifest_snapshot = repaired.manifest_snapshot,
    manifest_digest = repaired.manifest_digest
FROM terraform_stacks_pack_snapshot_repair repaired
WHERE installation.id = repaired.id;

UPDATE pack_installation_components component
SET digest = '3a58c98b725573b8fd524555b7ed9dbff04df4df9f8fad44e2e850bac3824809'
WHERE component.kind = 'plugin'
  AND component.capability_id = 'plugin:skill/library/terraform-stacks'
  AND component.metadata ->> 'pluginKey' = 'skill/library/terraform-stacks'
  AND component.metadata ->> 'version' = '0.0.1'
  AND component.digest = 'd484ccc1279954e5dbcdd9b8b57bc21e6a0fa47d38dc11854ffcf8e61289e883';

ALTER TABLE capability_plugin_versions
  ENABLE TRIGGER capability_plugin_versions_restrict_update;
ALTER TABLE capability_skill_facets
  ENABLE TRIGGER capability_skill_facets_immutable;

DO $provenance_postcondition$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM capability_skill_facets skill
    JOIN capability_facets facet ON facet.id = skill.facet_id
    JOIN capability_plugin_versions version ON version.id = facet.plugin_version_id
    JOIN capability_plugins plugin ON plugin.id = version.plugin_id
    WHERE skill.capability_id = 'skill:terraform-stacks'
      AND (
        plugin.plugin_key <> 'skill/library/terraform-stacks'
        OR version.version <> '0.0.1'
        OR skill.source_url <> 'https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/module-generation/skills/terraform-stacks'
        OR version.manifest ->> 'sourceUrl' <> 'https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/module-generation/skills/terraform-stacks'
        OR version.manifest_digest <> '3a58c98b725573b8fd524555b7ed9dbff04df4df9f8fad44e2e850bac3824809'
      )
  ) THEN
    RAISE EXCEPTION 'Terraform Stacks provenance repair did not converge'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workspace_packs pack,
      LATERAL jsonb_array_elements(COALESCE(pack.manifest -> 'components', '[]'::jsonb)) component
    WHERE component ->> 'kind' = 'plugin'
      AND component ->> 'pluginKey' = 'skill/library/terraform-stacks'
      AND component ->> 'version' = '0.0.1'
      AND component ->> 'manifestDigest' IS DISTINCT FROM
        '3a58c98b725573b8fd524555b7ed9dbff04df4df9f8fad44e2e850bac3824809'
  ) OR EXISTS (
    SELECT 1
    FROM pack_installations installation,
      LATERAL jsonb_array_elements(
        COALESCE(installation.manifest_snapshot -> 'components', '[]'::jsonb)
      ) component
    WHERE installation.manifest_snapshot IS NOT NULL
      AND component ->> 'kind' = 'plugin'
      AND component ->> 'pluginKey' = 'skill/library/terraform-stacks'
      AND component ->> 'version' = '0.0.1'
      AND component ->> 'manifestDigest' IS DISTINCT FROM
        '3a58c98b725573b8fd524555b7ed9dbff04df4df9f8fad44e2e850bac3824809'
  ) OR EXISTS (
    SELECT 1
    FROM terraform_stacks_pack_snapshot_repair repaired
    JOIN pack_installations installation ON installation.id = repaired.id
    WHERE installation.manifest_snapshot IS DISTINCT FROM repaired.manifest_snapshot
      OR installation.manifest_digest IS DISTINCT FROM repaired.manifest_digest
  ) OR EXISTS (
    SELECT 1
    FROM pack_installation_components component
    WHERE (
        component.capability_id = 'plugin:skill/library/terraform-stacks'
        OR component.metadata ->> 'pluginKey' = 'skill/library/terraform-stacks'
        OR EXISTS (
          SELECT 1
          FROM capability_plugin_installations installation
          JOIN capability_plugins plugin ON plugin.id = installation.plugin_id
          WHERE installation.id::text = component.resolved_id
            AND plugin.plugin_key = 'skill/library/terraform-stacks'
        )
      )
      AND (
        component.kind IS DISTINCT FROM 'plugin'
        OR component.capability_id IS DISTINCT FROM
          'plugin:skill/library/terraform-stacks'
        OR component.metadata ->> 'pluginKey' IS DISTINCT FROM
          'skill/library/terraform-stacks'
        OR component.metadata ->> 'version' IS DISTINCT FROM '0.0.1'
        OR component.digest IS DISTINCT FROM
          '3a58c98b725573b8fd524555b7ed9dbff04df4df9f8fad44e2e850bac3824809'
      )
  ) THEN
    RAISE EXCEPTION 'Terraform Stacks Pack provenance repair did not converge'
      USING ERRCODE = '23514';
  END IF;
END
$provenance_postcondition$;

DROP FUNCTION opengeni_private.terraform_stacks_provenance_rewrite_pack(jsonb);
DROP FUNCTION opengeni_private.terraform_stacks_provenance_canonical_json(jsonb);
DROP COLLATION opengeni_private.terraform_stacks_provenance_js_en_us;

RESET statement_timeout;
RESET lock_timeout;