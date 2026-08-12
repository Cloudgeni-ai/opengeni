import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { stableJson } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  installApiIntegration,
  listInstalledApiIntegrations,
  type InstallApiIntegrationInput,
} from "../src";
import { migrate } from "../src/migrate";

const migrationName = "0231_integration_definition_identity_cutover.sql";

describe("Integration Definition identity migration replay", () => {
  test("upgrades old curated/workspace definitions and OAuth metadata without fallback", async () => {
    const shared = await acquireDefinitionIdentityDatabase();
    if (!shared) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error(
          "[migration-0231-definition-identity] PostgreSQL is required but unavailable",
        );
      }
      return;
    }
    let app = createDb(shared.appUrl);
    try {
      const grant = (
        await bootstrapWorkspace(app.db, {
          accountExternalSource: "test",
          accountExternalId: `definition-cutover-account-${crypto.randomUUID()}`,
          accountName: "Definition cutover account",
          workspaceExternalSource: "test",
          workspaceExternalId: `definition-cutover-workspace-${crypto.randomUUID()}`,
          workspaceName: "Definition cutover workspace",
          subjectId: "user:definition-cutover",
        })
      ).workspaceGrants[0]!;

      const workspaceDefinition = integrationInput({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        definitionId: "inventory-source-123456789abc",
        definitionProvenance: "workspace",
        capabilityId: "api:openapi:inventory-source-123456789abc",
        pluginKey: "integration/openapi/inventory-source-123456789abc",
        serverId: "api_openapi_inventory_source_123456789abc",
        sourceUrl: "https://inventory.example.test/openapi.json",
        baseUrl: "https://inventory.example.test/v1/",
        providerDomain: "inventory.example.test",
        digestCharacter: "1",
      });
      const curatedDefinition = integrationInput({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        definitionId: "google-gmail",
        definitionProvenance: "curated",
        capabilityId: "api:openapi:google-gmail-abcdef123456",
        pluginKey: "integration/openapi/google-gmail-abcdef123456",
        serverId: "api_openapi_google_gmail_abcdef123456",
        sourceUrl: "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
        baseUrl: "https://gmail.googleapis.com/",
        providerDomain: "gmail.googleapis.com",
        digestCharacter: "2",
      });

      await installApiIntegration(app.db, workspaceDefinition);
      await installApiIntegration(app.db, curatedDefinition);
      const connection = await createConnection(app.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        providerDomain: "gmail.googleapis.com",
        kind: "oauth2",
        credentialEncrypted: "test-only-encrypted-oauth-bundle",
        grantedScopes: ["openid", "email"],
        metadata: {
          credentialRole: "api_integration_oauth",
          providerFamily: "google",
          providerPrincipalId: "google-user-1",
          authorizedDefinitionIds: ["google-drive", "google-gmail"],
        },
        createdBySubjectId: grant.subjectId,
      });

      await app.close();

      const versions = await shared.admin<
        Array<{
          id: string;
          pluginKey: string;
          manifest: Record<string, postgres.JSONValue | undefined>;
        }>
      >`
        select
          version.id,
          plugin.plugin_key as "pluginKey",
          version.manifest
        from capability_plugin_versions version
        join capability_plugins plugin on plugin.id = version.plugin_id
        where plugin.workspace_id = ${grant.workspaceId}
          and plugin.plugin_key in (${workspaceDefinition.pluginKey}, ${curatedDefinition.pluginKey})
        order by plugin.plugin_key
      `;
      expect(versions).toHaveLength(2);

      await shared.admin`alter table integration_spec_revisions disable trigger integration_spec_revisions_immutable`;
      await shared.admin`alter table capability_plugin_versions disable trigger capability_plugin_versions_restrict_update`;
      try {
        for (const version of versions) {
          const definitionId = String(version.manifest.definitionId);
          const oldManifest = { ...version.manifest };
          delete oldManifest.definitionId;
          delete oldManifest.definitionProvenance;
          if (version.pluginKey === curatedDefinition.pluginKey) {
            oldManifest.presetId = definitionId;
          }
          await shared.admin`
            update capability_plugin_versions
            set manifest = ${shared.admin.json(oldManifest)}::jsonb,
                manifest_digest = ${sha256(stableJson(oldManifest))}
            where id = ${version.id}
          `;
          await shared.admin`
            update integration_spec_revisions revision
            set spec = (revision.spec - 'definitionId') || jsonb_build_object(
              'integrationId',
              ${definitionId}::text
            )
            from capability_facets facet
            join capability_api_facets api on api.facet_id = facet.id
            where revision.api_facet_id = api.facet_id
              and facet.plugin_version_id = ${version.id}
          `;
        }
      } finally {
        await shared.admin`alter table capability_plugin_versions enable trigger capability_plugin_versions_restrict_update`;
        await shared.admin`alter table integration_spec_revisions enable trigger integration_spec_revisions_immutable`;
      }
      await shared.admin`
        update connections
        set metadata = (metadata - 'authorizedDefinitionIds') || jsonb_build_object(
          'authorizedPresetIds',
          metadata -> 'authorizedDefinitionIds'
        )
        where id = ${connection.id}
      `;
      await shared.admin`delete from schema_migrations where name = ${migrationName}`;

      await migrate(shared.adminUrl);

      const migrated = await shared.admin<
        Array<{
          pluginKey: string;
          manifest: Record<string, unknown>;
          manifestDigest: string;
          spec: Record<string, unknown>;
        }>
      >`
        select
          plugin.plugin_key as "pluginKey",
          version.manifest,
          version.manifest_digest as "manifestDigest",
          revision.spec
        from capability_plugin_versions version
        join capability_plugins plugin on plugin.id = version.plugin_id
        join capability_facets facet on facet.plugin_version_id = version.id
        join capability_api_facets api on api.facet_id = facet.id
        join integration_spec_revisions revision on revision.api_facet_id = api.facet_id
        where plugin.workspace_id = ${grant.workspaceId}
          and plugin.plugin_key in (${workspaceDefinition.pluginKey}, ${curatedDefinition.pluginKey})
        order by plugin.plugin_key
      `;
      expect(migrated).toHaveLength(2);
      for (const row of migrated) {
        const expected =
          row.pluginKey === curatedDefinition.pluginKey ? curatedDefinition : workspaceDefinition;
        expect(row.manifest).toMatchObject({
          definitionId: expected.definitionId,
          definitionProvenance: expected.definitionProvenance,
        });
        expect(row.manifest).not.toHaveProperty("presetId");
        expect(row.manifestDigest).toBe(sha256(stableJson(row.manifest)));
        expect(row.spec).toMatchObject({ definitionId: expected.definitionId });
        expect(row.spec).not.toHaveProperty("integrationId");
      }
      const [migratedConnection] = await shared.admin<
        Array<{ metadata: Record<string, unknown> }>
      >`select metadata from connections where id = ${connection.id}`;
      expect(migratedConnection?.metadata).toMatchObject({
        authorizedDefinitionIds: ["google-drive", "google-gmail"],
      });
      expect(migratedConnection?.metadata).not.toHaveProperty("authorizedPresetIds");

      app = createDb(shared.appUrl);
      expect(
        await listInstalledApiIntegrations(app.db, grant.workspaceId, grant.subjectId),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            definitionId: workspaceDefinition.definitionId,
            definitionProvenance: "workspace",
          }),
          expect.objectContaining({
            definitionId: curatedDefinition.definitionId,
            definitionProvenance: "curated",
          }),
        ]),
      );
      await app.close();

      await shared.admin`delete from schema_migrations where name = ${migrationName}`;
      await migrate(shared.adminUrl);
      const [receipt] = await shared.admin<Array<{ count: number }>>`
        select count(*)::int as count
        from schema_migrations
        where name = ${migrationName}
      `;
      expect(receipt?.count).toBe(1);
    } finally {
      await app.close().catch(() => undefined);
      await shared.release();
    }
  }, 180_000);
});

async function acquireDefinitionIdentityDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_DEFINITION_IDENTITY_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_DEFINITION_IDENTITY_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_DEFINITION_IDENTITY_TEST_POSTGRES_ADMIN_URL and OPENGENI_DEFINITION_IDENTITY_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  if (!adminUrl || !appUrl) {
    return await acquireSharedTestDatabase("migration-0231-definition-identity");
  }
  await migrate(adminUrl);
  const admin = postgres(adminUrl, { max: 4 });
  return {
    admin,
    adminUrl,
    appUrl,
    release: async () => await admin.end().catch(() => undefined),
  };
}

function integrationInput(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  definitionId: string;
  definitionProvenance: "curated" | "workspace";
  capabilityId: string;
  pluginKey: string;
  serverId: string;
  sourceUrl: string;
  baseUrl: string;
  providerDomain: string;
  digestCharacter: string;
}): InstallApiIntegrationInput {
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    capabilityId: input.capabilityId,
    pluginKey: input.pluginKey,
    serverId: input.serverId,
    name: input.definitionId,
    category: "integrations",
    tags: ["integration", "openapi"],
    definitionId: input.definitionId,
    definitionProvenance: input.definitionProvenance,
    providerDomain: input.providerDomain,
    protocol: "openapi",
    baseUrl: input.baseUrl,
    sourceUrl: input.sourceUrl,
    authScheme: { kind: "none" },
    ownership: "workspace",
    revision: {
      id: `openapi:${input.digestCharacter.repeat(24)}`,
      protocol: "openapi",
      definitionId: input.definitionId,
      contentSha256: input.digestCharacter.repeat(64),
      source: { url: input.sourceUrl },
      title: input.definitionId,
      tools: [
        {
          id: "list_items",
          operationKey: "listItems",
          name: "List items",
          description: "List items.",
          inputSchema: { type: "object", properties: {} },
          safety: "read",
          approvalMode: "never",
          deprecated: false,
        },
      ],
      bindings: {
        list_items: {
          method: "get",
          pathTemplate: "/items",
          serverUrl: input.baseUrl,
          parameters: [],
        },
      },
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
