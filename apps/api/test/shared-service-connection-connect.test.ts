// Adding a shared key (docs/secrets.md "Shared service connections"): an
// admin connects an API-key MCP server for the workspace with a vault
// reference. Opengeni checks the key once with the workspace's own vault
// reach, stores only the reference, and never returns the value.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { McpCapabilityProbeInput } from "@opengeni/core";
import type { Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  createDb,
  createVault,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  upsertVaultItem,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

const DELEGATION_SECRET = "shared-service-connection-delegation-secret-0123456789";
const rawKey = randomBytes(32);
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_shared_service_connection");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: rawKey.toString("base64"),
    integrationsEnabled: true,
    integrationsStateSecret: "shared-service-connection-state-secret-0123456789",
    publicBaseUrl: "https://api.opengeni.test",
  }) as Settings;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const ADMIN: Permission[] = [
  "workspace:read",
  "connections:read",
  "connections:write",
  "capabilities:manage",
  "secrets:use",
];
const REFERENCE = "{{secret:Team/Example key}}";

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "shared service connections through connect",
  () => {
    test("an admin adds a shared key by reference; only the reference is stored", async () => {
      const userId = `shared-key-${randomUUID()}`;
      const access = await ensureManagedAccessForUser(client.db, {
        userId,
        email: `${userId}@example.test`,
        name: "Admin",
      });
      const grant = access.workspaceGrants[0]!;
      const subjectId = `user:${userId}`;
      const context = {
        kind: "subject" as const,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId,
      };
      const write = async (vaultId: string, name: string, value: string) =>
        await upsertVaultItem(client.db, context, {
          vaultId,
          name,
          type: "api_key",
          fields: [
            {
              name: "value",
              kind: "concealed",
              valueEncrypted: encryptEnvironmentValue(rawKey, value),
              valueSize: Buffer.byteLength(value),
            },
          ],
        });
      const team = await createVault(client.db, context, { name: "Team", ownerKind: "workspace" });
      const mine = await createVault(client.db, context, { name: "Mine", ownerKind: "user" });
      await write(team.id, "Example key", "synthetic-shared-key");
      await write(mine.id, "My key", "synthetic-personal-key");

      const probed: Array<Record<string, string> | undefined> = [];
      const api = createApp({
        settings,
        db: client.db,
        bus: {} as never,
        workflowClient: {} as never,
        managedAuth: null,
        mcpCapabilityProbe: async ({ headers }: McpCapabilityProbeInput) => {
          probed.push(headers);
          return { toolCount: 1 };
        },
      } as never);
      const headersFor = async (permissions: Permission[]) => ({
        authorization: `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId,
          permissions,
          principalKind: "human_session",
          exp: Math.floor(Date.now() / 1000) + 3600,
        })}`,
        "content-type": "application/json",
      });
      const base = `/v1/workspaces/${grant.workspaceId}/connect/attempts`;
      const attempt = async (
        ownership: "workspace" | "personal",
        headerValue: string,
        permissions: Permission[] = ADMIN,
      ) => {
        const headers = await headersFor(permissions);
        const begun = await api.request(base, {
          method: "POST",
          headers: await headersFor(ADMIN),
          body: JSON.stringify({
            providerId: "mcp-headers",
            ownership,
            idempotencyKey: randomUUID(),
            returnUrl: "https://console.example.test/connections",
          }),
        });
        expect(begun.status, await begun.clone().text()).toBe(200);
        const { id, revision } = (await begun.json()) as { id: string; revision: number };
        return await api.request(`${base}/${id}/advance`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            expectedRevision: revision,
            idempotencyKey: randomUUID(),
            action: {
              type: "credentials",
              values: {
                mcpUrl: "https://mcp.example.test/mcp",
                headers: JSON.stringify({ Authorization: headerValue }),
              },
            },
          }),
        });
      };

      // A reference is for a connection shared with the workspace.
      const personal = await attempt("personal", `Bearer ${REFERENCE}`);
      expect(personal.status).toBe(422);
      // Only an admin who may use secrets adds one.
      const member = await attempt("workspace", `Bearer ${REFERENCE}`, [
        "workspace:read",
        "connections:read",
        "connections:write",
        "capabilities:manage",
      ]);
      expect(member.status).toBe(403);
      expect(await member.text()).toContain("Only a workspace admin can add a shared key");
      // Someone's Only me vault and missing items fail now, readably, naming nothing.
      for (const reference of ["{{secret:Mine/My key}}", "{{secret:Team/Missing}}"]) {
        const refused = await attempt("workspace", `Bearer ${reference}`);
        expect(refused.status).toBe(422);
        const text = await refused.text();
        expect(text).toContain("wasn't found in a workspace or organization vault");
        expect(text).not.toContain("synthetic-personal-key");
      }
      expect(probed).toHaveLength(0);

      const connected = await attempt("workspace", `Bearer ${REFERENCE}`);
      expect(connected.status, await connected.clone().text()).toBe(200);
      const receipt = await connected.text();
      expect(JSON.parse(receipt)).toMatchObject({ state: "complete", ownership: "workspace" });
      expect(receipt).not.toContain("synthetic-shared-key");
      // The stored credential is the reference.
      const [row] = await shared!.admin<
        { credential_encrypted: string; subject_id: string | null; metadata: Record<string, unknown> }[]
      >`select credential_encrypted, subject_id, metadata from connections
        where workspace_id = ${grant.workspaceId} and provider_domain = 'mcp.example.test'`;
      expect(row!.subject_id).toBeNull();
      expect(row!.metadata).toMatchObject({
        credentialSource: "vault",
        credentialReferences: [REFERENCE],
      });
      const stored = decryptEnvironmentValue(rawKey, row!.credential_encrypted);
      expect(stored).toContain(REFERENCE);
      expect(stored).not.toContain("synthetic-shared-key");
    }, 60_000);
  },
);
