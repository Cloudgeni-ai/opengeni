// A tool call through the API's workspace tool gateway on a shared service
// connection (docs/secrets.md): the tool receives the vault value, the stored
// connection holds only the reference, the call's result and errors never
// carry the value, and a missing item fails closed before anything is sent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { startTestMcpServer } from "@opengeni/testing/mcp";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import type { Settings } from "@opengeni/config";
import {
  createDb,
  createVault,
  deleteWorkspace,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  upsertVaultItem,
  type DbClient,
} from "@opengeni/db";
import {
  accessGrantAuthorizationFromContext,
  mcpAccountRouteId,
  type ApiRouteDeps,
} from "@opengeni/core";
import { invokeWorkspaceToolTarget } from "../src/workspace-tool-target";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("shared-service-connection-gateway");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("Real PostgreSQL required");
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const VALUE = "synthetic-gateway-shared-key";

describe("shared service connections in the API tool gateway", () => {
  test("the tool gets the vault value; nothing returned carries it", async () => {
    if (!client || !shared) return;
    const key = randomBytes(32);
    const userId = `shared-gateway-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Admin",
    });
    const grant = access.workspaceGrants[0]!;
    const authorization = accessGrantAuthorizationFromContext(access, grant);
    authorization.canonicalManagedHumanSession = true;
    const context = {
      kind: "subject" as const,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
    };
    const team = await createVault(client.db, context, { name: "Team", ownerKind: "workspace" });
    await upsertVaultItem(client.db, context, {
      vaultId: team.id,
      name: "Probe key",
      type: "api_key",
      fields: [
        {
          name: "value",
          kind: "concealed",
          valueEncrypted: encryptEnvironmentValue(key, VALUE),
          valueSize: VALUE.length,
        },
      ],
    });
    const seen: Array<string | null> = [];
    const provider = startTestMcpServer({
      validateAuthorization: (header) => {
        seen.push(header);
        return header === `Bearer ${VALUE}`;
      },
    });
    const host = new URL(provider.url).hostname;
    const insertConnection = async (reference: string) => {
      const credential = encryptEnvironmentValue(
        key,
        JSON.stringify({ headers: { Authorization: `Bearer ${reference}` } }),
      );
      await shared!.admin`delete from connections where workspace_id = ${grant.workspaceId}`;
      const [row] = await shared!.admin<{ id: string }[]>`
        insert into connections (
          account_id, workspace_id, origin_workspace_id, subject_id, provider_domain, kind,
          credential_encrypted, status, metadata
        ) values (
          ${grant.accountId}, ${grant.workspaceId}, ${grant.workspaceId}, null, ${host}, 'api_key',
          ${credential}, 'active',
          ${shared!.admin.json({ mcpUrl: provider.url, credentialSource: "vault", credentialReferences: [reference] })}
        ) returning id`;
      return row!.id;
    };
    const settings = testSettings({
      environmentsEncryptionKey: key.toString("base64"),
      mcpServers: [
        {
          id: "shared-probe",
          url: provider.url,
          cacheToolsList: false,
          connectionRef: { providerDomain: host, kind: "api_key", subjectScope: "workspace" },
        },
      ],
    }) as Settings;
    const deps = { db: client.db, settings } as ApiRouteDeps;
    const live = { reauthorize: async () => undefined };
    const call = async (connectionId: string) => {
      const identity = {
        serverId: mcpAccountRouteId("shared-probe", connectionId),
        toolName: "search_documents",
      };
      return await invokeWorkspaceToolTarget(
        deps,
        authorization,
        {
          identity,
          target: { identity },
          operationId: crypto.randomUUID(),
          arguments: { query: "test" },
        },
        live,
      );
    };
    try {
      const called = await call(await insertConnection("{{secret:Team/Probe key}}"));
      expect(called.result.isError).not.toBe(true);
      expect(provider.calls).toHaveLength(1);
      expect(seen.every((value) => value === `Bearer ${VALUE}`)).toBe(true);
      expect(JSON.stringify(called)).not.toContain(VALUE);

      // A missing item: refused before anything is sent, without the value.
      const missing = await insertConnection("{{secret:Team/Missing key}}");
      const before = provider.requests.length;
      const failure = await call(missing).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).not.toBeNull();
      expect(JSON.stringify(failure)).not.toContain(VALUE);
      expect(
        provider.requests.slice(before).some((request) => request.jsonRpcMethod === "tools/call"),
      ).toBe(false);
      // The reference text itself is never sent as a credential.
      expect(seen.some((value) => value?.includes("secret:"))).toBe(false);
    } finally {
      provider.close();
      await deleteWorkspace(client.db, grant.workspaceId);
    }
  }, 180_000);
});
