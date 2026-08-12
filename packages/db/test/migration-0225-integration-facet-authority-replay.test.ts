import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { stableJson, type CapabilityPack } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import {
  adoptPackComponentReferences,
  bootstrapWorkspace,
  configureIntegrationFacet,
  createDb,
  enablePackInstallation,
  getPackInstallation,
  getWorkspacePack,
  installApiIntegration,
  listIntegrationInstanceFacets,
  listPackInstallationComponents,
  registerWorkspacePack,
  type InstallApiIntegrationInput,
} from "../src";
import { migrate } from "../src/migrate";

const migrationName = "0225_integration_facet_authority_cutover.sql";

describe("Integration Facet authority migration replay", () => {
  test("upgrades physical, Pack, owner, and receipt identity without fallback", async () => {
    const shared = await acquireSharedTestDatabase("migration-0225-facet-authority");
    if (!shared) return;
    let app = createDb(shared.appUrl);
    try {
      const grant = (
        await bootstrapWorkspace(app.db, {
          accountExternalSource: "test",
          accountExternalId: `facet-cutover-account-${crypto.randomUUID()}`,
          accountName: "Facet cutover account",
          workspaceExternalSource: "test",
          workspaceExternalId: `facet-cutover-workspace-${crypto.randomUUID()}`,
          workspaceName: "Facet cutover workspace",
          subjectId: "user:facet-cutover",
        })
      ).workspaceGrants[0]!;

      const integration = integrationInput({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
      });
      const installed = await installApiIntegration(app.db, integration);
      const facetConfig = { mailbox: "finance", includeArchived: false };
      const configured = await configureIntegrationFacet(app.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        capabilityId: integration.capabilityId,
        instanceKey: installed.instanceKey,
        facetKey: "mail-inbox",
        displayName: "Finance inbox",
        config: facetConfig,
        idempotencyKey: crypto.randomUUID(),
      });

      const pack: CapabilityPack = {
        id: "facet-cutover-pack",
        name: "Facet cutover Pack",
        description: "Pins one exact Integration Facet binding.",
        role: "operations",
        category: "integrations",
        version: "1.0.0",
        skills: [],
        components: [
          {
            key: "finance-mail",
            kind: "facet",
            capabilityId: integration.capabilityId,
            instanceKey: installed.instanceKey,
            facetKey: "mail-inbox",
            bindingKey: installed.instanceKey,
            configDigest: sha256(stableJson(facetConfig)),
            required: true,
          },
        ],
        tools: [],
        connectors: [],
        knowledge: [],
        scheduledTaskTemplates: [],
        metadata: {},
      };
      const packDigest = sha256(stableJson(pack));
      await registerWorkspacePack(app.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        pack,
      });
      const installation = await enablePackInstallation(app.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        packId: pack.id,
        manifestSnapshot: pack,
        manifestDigest: packDigest,
        installedBySubjectId: grant.subjectId,
        metadata: { platformVersion: 2 },
      });
      await adoptPackComponentReferences(app.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        packInstallationId: installation.id,
        references: pack.components,
      });

      await app.close();

      const oldPack = featureEraPack(pack);
      const oldPackDigest = sha256(stableJson(oldPack));
      await shared.admin`
        update workspace_packs
        set manifest = ${JSON.stringify(oldPack)}::jsonb
        where workspace_id = ${grant.workspaceId} and pack_id = ${pack.id}
      `;
      await shared.admin`
        update pack_installations
        set manifest_snapshot = ${JSON.stringify(oldPack)}::jsonb,
            manifest_digest = ${oldPackDigest}
        where id = ${installation.id}
      `;
      await shared.admin`
        update capability_installations
        set metadata = jsonb_set(metadata, '{manifestDigest}', to_jsonb(${oldPackDigest}::text), true)
        where workspace_id = ${grant.workspaceId}
          and capability_id = ${`pack:${pack.id}`}
      `;
      await shared.admin`
        update pack_installation_components
        set kind = 'feature',
            metadata = (metadata - 'facetKey') || jsonb_build_object(
              'featureKey', metadata -> 'facetKey'
            )
        where pack_installation_id = ${installation.id}
      `;
      await shared.admin`
        update integration_facet_binding_owners
        set owner_id = 'feature:' || substr(owner_id, length('facet:') + 1)
        where binding_id = ${configured.binding.id}
          and owner_kind = 'direct'
      `;
      await shared.admin`
        update capability_operations
        set result = (result - 'facetKey' - 'binding') || jsonb_build_object(
          'featureKey', result -> 'facetKey',
          'binding', (result -> 'binding' - 'facetKey') || jsonb_build_object(
            'featureKey', result -> 'binding' -> 'facetKey'
          )
        where workspace_id = ${grant.workspaceId}
          and target_kind = 'facet_binding'
      `;
      await shared.admin`
        insert into capability_operations (
          account_id,
          workspace_id,
          idempotency_key,
          request_digest,
          kind,
          target_kind,
          target_id,
          status,
          phase,
          result,
          created_by_subject_id,
          completed_at
        ) values (
          ${grant.accountId},
          ${grant.workspaceId},
          ${crypto.randomUUID()},
          ${"f".repeat(64)},
          'install',
          'pack',
          ${pack.id},
          'completed',
          'completed',
          ${JSON.stringify({ status: "installed", packId: pack.id, manifestDigest: oldPackDigest })}::jsonb,
          ${grant.subjectId},
          now()
        )
      `;

      await downgradePhysicalFacetAuthority(shared.admin);
      await shared.admin`delete from schema_migrations where name = ${migrationName}`;
      await migrate(shared.adminUrl);

      const [catalog] = await shared.admin<
        Array<{
          oldDefinitions: string | null;
          oldBindings: string | null;
          oldOwners: string | null;
          definitions: string | null;
          bindings: string | null;
          owners: string | null;
        }>
      >`
        select
          to_regclass('integration_feature_facets')::text as "oldDefinitions",
          to_regclass('integration_feature_bindings')::text as "oldBindings",
          to_regclass('integration_feature_binding_owners')::text as "oldOwners",
          to_regclass('integration_facet_definitions')::text as definitions,
          to_regclass('integration_facet_bindings')::text as bindings,
          to_regclass('integration_facet_binding_owners')::text as owners
      `;
      expect(catalog).toMatchObject({
        oldDefinitions: null,
        oldBindings: null,
        oldOwners: null,
        definitions: "integration_facet_definitions",
        bindings: "integration_facet_bindings",
        owners: "integration_facet_binding_owners",
      });

      app = createDb(shared.appUrl);
      const registered = await getWorkspacePack(app.db, grant.workspaceId, pack.id);
      expect(registered?.pack.components).toEqual(pack.components);
      const migratedInstallation = await getPackInstallation(app.db, grant.workspaceId, pack.id);
      expect(migratedInstallation?.manifestSnapshot?.components).toEqual(pack.components);
      expect(migratedInstallation?.manifestDigest).toBe(packDigest);
      const components = await listPackInstallationComponents(
        app.db,
        grant.workspaceId,
        installation.id,
      );
      expect(components).toEqual([
        expect.objectContaining({
          kind: "facet",
          metadata: expect.objectContaining({ facetKey: "mail-inbox" }),
        }),
      ]);
      const facets = await listIntegrationInstanceFacets(
        app.db,
        grant.workspaceId,
        grant.subjectId,
        integration.capabilityId,
        installed.instanceKey,
      );
      expect(facets.facets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            definition: expect.objectContaining({ facetKey: "mail-inbox" }),
            binding: expect.objectContaining({ facetKey: "mail-inbox", config: facetConfig }),
          }),
        ]),
      );
      await app.close();

      const [owner] = await shared.admin<Array<{ ownerId: string }>>`
        select owner_id as "ownerId"
        from integration_facet_binding_owners
        where binding_id = ${configured.binding.id} and owner_kind = 'direct'
      `;
      expect(owner?.ownerId).toStartWith("facet:");
      const [legacyReceipts] = await shared.admin<Array<{ count: number }>>`
        select count(*)::int as count
        from capability_operations
        where workspace_id = ${grant.workspaceId}
          and (
            target_kind = 'pack'
            or (
              target_kind = 'facet_binding'
              and result is not null
              and (
                result ? 'featureKey'
                or (jsonb_typeof(result -> 'binding') = 'object' and result -> 'binding' ? 'featureKey')
              )
            )
          )
      `;
      expect(legacyReceipts?.count).toBe(0);

      app = createDb(shared.appUrl);
      const postCutoverReceiptKey = crypto.randomUUID();
      await configureIntegrationFacet(app.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        capabilityId: integration.capabilityId,
        instanceKey: installed.instanceKey,
        facetKey: "mail-inbox",
        displayName: "Finance inbox updated",
        config: facetConfig,
        expectedVersion: configured.binding.version,
        idempotencyKey: postCutoverReceiptKey,
      });
      await app.close();

      await shared.admin`delete from schema_migrations where name = ${migrationName}`;
      await migrate(shared.adminUrl);
      const [receipt] = await shared.admin<Array<{ count: number }>>`
        select count(*)::int as count
        from capability_operations
        where workspace_id = ${grant.workspaceId}
          and idempotency_key = ${postCutoverReceiptKey}
      `;
      expect(receipt?.count).toBe(1);
    } finally {
      await app.close().catch(() => undefined);
      await shared.release();
    }
  }, 180_000);
});

function integrationInput(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
}): InstallApiIntegrationInput {
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    capabilityId: "api:openapi:facet-cutover-123456789abc",
    pluginKey: "integration/openapi/facet-cutover-123456789abc",
    serverId: "api_openapi_facet_cutover_123456789abc",
    name: "Facet cutover integration",
    category: "integrations",
    tags: ["integration", "openapi"],
    definitionId: "facet-cutover-123456789abc",
    definitionProvenance: "workspace",
    providerDomain: "mail.example.test",
    protocol: "openapi",
    baseUrl: "https://mail.example.test/v1/",
    sourceUrl: "https://mail.example.test/openapi.json",
    authScheme: { kind: "none" },
    ownership: "workspace",
    instanceKey: "finance",
    facetDefinitions: [
      {
        facetKey: "mail-inbox",
        kind: "knowledge_source",
        configSchema: {
          type: "object",
          required: ["mailbox", "includeArchived"],
          properties: {
            mailbox: { type: "string", minLength: 1, maxLength: 120 },
            includeArchived: { type: "boolean" },
          },
          additionalProperties: false,
        },
        capabilities: { connectionRequired: false },
      },
    ],
    revision: {
      id: "openapi:facet-cutover-123456789abc",
      protocol: "openapi",
      definitionId: "facet-cutover-123456789abc",
      contentSha256: "a".repeat(64),
      source: { url: "https://mail.example.test/openapi.json" },
      title: "Facet cutover integration",
      tools: [
        {
          id: "list_messages",
          operationKey: "listMessages",
          name: "List messages",
          description: "List messages.",
          inputSchema: { type: "object", properties: {} },
          safety: "read",
          approvalMode: "never",
          deprecated: false,
        },
      ],
      bindings: {
        list_messages: {
          method: "get",
          pathTemplate: "/messages",
          serverUrl: "https://mail.example.test/v1/",
          parameters: [],
        },
      },
    },
  };
}

function featureEraPack(pack: CapabilityPack): Record<string, unknown> {
  return {
    ...pack,
    components: pack.components.map((component) =>
      component.kind === "facet"
        ? {
            ...component,
            kind: "feature",
            featureKey: component.facetKey,
            facetKey: undefined,
          }
        : component,
    ),
  };
}

async function downgradePhysicalFacetAuthority(admin: SharedTestDatabase["admin"]): Promise<void> {
  await admin.unsafe(`
    DROP TRIGGER IF EXISTS integration_facet_bindings_validate ON integration_facet_bindings;
    DROP TRIGGER IF EXISTS integration_facet_binding_owners_validate ON integration_facet_binding_owners;
    DROP FUNCTION IF EXISTS capability_v2_validate_facet_binding();
    DROP FUNCTION IF EXISTS capability_v2_validate_facet_binding_owner();

    ALTER TABLE integration_facet_definitions RENAME TO integration_feature_facets;
    ALTER TABLE integration_facet_bindings RENAME TO integration_feature_bindings;
    ALTER TABLE integration_facet_binding_owners RENAME TO integration_feature_binding_owners;
    ALTER TABLE integration_feature_facets RENAME COLUMN facet_key TO feature_key;
    ALTER TABLE integration_feature_bindings RENAME COLUMN facet_definition_id TO feature_facet_id;

    DO $reverse_constraints$
    DECLARE
      target_table text;
      constraint_row record;
      new_name text;
    BEGIN
      FOREACH target_table IN ARRAY ARRAY[
        'integration_feature_facets',
        'integration_feature_bindings',
        'integration_feature_binding_owners'
      ]
      LOOP
        FOR constraint_row IN
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = to_regclass(target_table)
            AND conname LIKE '%facet%'
          ORDER BY conname
        LOOP
          new_name := replace(constraint_row.conname, 'integration_facet_definitions', 'integration_feature_facets');
          new_name := replace(new_name, 'integration_facet_bindings', 'integration_feature_bindings');
          new_name := replace(new_name, 'integration_facet_binding_owners', 'integration_feature_binding_owners');
          new_name := replace(new_name, 'facet_definition', 'feature_facet');
          new_name := replace(new_name, 'facet_key', 'feature_key');
          new_name := replace(new_name, 'integration_facet', 'integration_feature');
          new_name := replace(new_name, 'facet', 'feature');
          IF constraint_row.conname <> new_name THEN
            EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', target_table, constraint_row.conname, new_name);
          END IF;
        END LOOP;
      END LOOP;
    END
    $reverse_constraints$;

    DO $reverse_indexes$
    DECLARE
      index_row record;
      new_name text;
    BEGIN
      FOR index_row IN
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename IN (
            'integration_feature_facets',
            'integration_feature_bindings',
            'integration_feature_binding_owners'
          )
          AND indexname LIKE '%facet%'
        ORDER BY indexname
      LOOP
        new_name := replace(index_row.indexname, 'integration_facet_definitions', 'integration_feature_facets');
        new_name := replace(new_name, 'integration_facet_bindings', 'integration_feature_bindings');
        new_name := replace(new_name, 'integration_facet_binding_owners', 'integration_feature_binding_owners');
        new_name := replace(new_name, 'facet_definition', 'feature_facet');
        new_name := replace(new_name, 'facet_key', 'feature_key');
        new_name := replace(new_name, 'integration_facet', 'integration_feature');
        new_name := replace(new_name, 'facet', 'feature');
        IF index_row.indexname <> new_name THEN
          EXECUTE format('ALTER INDEX %I RENAME TO %I', index_row.indexname, new_name);
        END IF;
      END LOOP;
    END
    $reverse_indexes$;

    CREATE OR REPLACE FUNCTION capability_v2_validate_feature_binding()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM integration_feature_facets definition
        JOIN capability_facet_installations installation
          ON installation.id = NEW.integration_facet_installation_id
         AND installation.facet_id = definition.integration_facet_id
        WHERE definition.id = NEW.feature_facet_id
          AND installation.account_id = NEW.account_id
          AND installation.workspace_id = NEW.workspace_id
      ) THEN
        RAISE EXCEPTION 'feature binding does not match its integration installation or tenant'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $function$;

    CREATE OR REPLACE FUNCTION capability_v2_validate_feature_binding_owner()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM integration_feature_bindings binding
        WHERE binding.id = NEW.binding_id
          AND binding.account_id = NEW.account_id
          AND binding.workspace_id = NEW.workspace_id
      ) THEN
        RAISE EXCEPTION 'feature binding owner does not match its binding tenant'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $function$;

    CREATE TRIGGER integration_feature_bindings_validate
      BEFORE INSERT OR UPDATE ON integration_feature_bindings
      FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_feature_binding();
    CREATE TRIGGER integration_feature_binding_owners_validate
      BEFORE INSERT OR UPDATE ON integration_feature_binding_owners
      FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_feature_binding_owner();
  `);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
