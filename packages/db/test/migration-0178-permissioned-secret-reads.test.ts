import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { bootstrapWorkspace, createApiKey, createDb, createSession, type DbClient } from "../src";

const migrationUrl = new URL("../drizzle/0178_permissioned_secret_reads.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const addedPermissions = [
  "variable-sets:list",
  "variable-sets:read",
  "variable-sets:write",
  "secrets:list",
  "secrets:read",
  "secrets:write",
] as const;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

setDefaultTimeout(180_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0178-permissioned-secret-reads");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0178] OPENGENI_REQUIRE_REAL_DB=1 but the PostgreSQL harness is unavailable",
      );
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("0178 permissioned secret reads migration", () => {
  test("upgrades only human admin memberships and is populated-path idempotent", async () => {
    if (!shared || !client) return;
    const suffix = crypto.randomUUID();
    const subjectId = `migration-0178-${suffix}`;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "migration-0178-test",
      accountExternalId: `account-${suffix}`,
      accountName: "Permissioned reads migration",
      workspaceExternalSource: "migration-0178-test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Permissioned reads migration",
      subjectId,
    });
    const grant = access.workspaceGrants[0]!;
    const legacyPermissions = ["workspace:admin", "variable-sets:use"] as const;
    await shared.admin`
      update workspace_memberships
         set permissions = ${shared.admin.json([...legacyPermissions])}
       where workspace_id = ${grant.workspaceId}
         and subject_id = ${subjectId}`;

    const apiKey = await createApiKey(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "Legacy wildcard API key",
      prefix: `pk_${suffix.slice(0, 8)}`,
      keyHash: `migration-0178-${suffix}`,
      permissions: [...legacyPermissions],
    });
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "preserve frozen permissions",
      resources: [],
      tools: [],
      metadata: {},
      model: "migration-test",
      sandboxBackend: "none",
      firstPartyMcpPermissions: [...legacyPermissions],
      subjectId,
    });

    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).not.toContain('"api_keys"');
    expect(migration).not.toContain('"sessions"');

    await shared.admin.unsafe(migration);
    await shared.admin.unsafe(migration);

    const [membership] = await shared.admin<Array<{ permissions: string[] }>>`
      select permissions
        from workspace_memberships
       where workspace_id = ${grant.workspaceId}
         and subject_id = ${subjectId}`;
    expect(membership?.permissions).toEqual([...legacyPermissions, ...addedPermissions]);
    expect(new Set(membership!.permissions).size).toBe(membership!.permissions.length);

    const [persistedApiKey] = await shared.admin<Array<{ permissions: string[] }>>`
      select permissions from api_keys where id = ${apiKey.id}`;
    expect(persistedApiKey?.permissions).toEqual([...legacyPermissions]);

    const [persistedSession] = await shared.admin<
      Array<{ firstPartyMcpPermissions: string[] | null }>
    >`
      select first_party_mcp_permissions as "firstPartyMcpPermissions"
        from sessions
       where id = ${session.id}`;
    expect(persistedSession?.firstPartyMcpPermissions).toEqual([...legacyPermissions]);
  });
});
