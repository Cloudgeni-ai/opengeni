// Shared service connections against PostgreSQL (migration 1525): a shared
// key resolves with the connection's own vault reach (the workspace's vaults
// and organization vaults that work here, never an Only me vault), each use
// is audited with the connection id and no value, and every failure is a
// readable error that names nothing secret.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import type { Settings } from "@opengeni/config";
import {
  createDb,
  createVault,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  upsertVaultItem,
  type DbClient,
  type VaultDbContext,
  type VaultRow,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  resolveServiceConnectionHeaders,
  ServiceConnectionCredentialError,
} from "../src/domain/vaults";

setDefaultTimeout(180_000);

const key = new Uint8Array(32).fill(7);
const settings = testSettings({
  environmentsEncryptionKey: Buffer.from(key).toString("base64"),
}) as Settings;
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("service-connection-credentials");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function world() {
  const db = client!.db;
  const userId = `service-connection-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Admin",
  });
  const grant = access.workspaceGrants[0]!;
  const context: VaultDbContext = {
    kind: "subject",
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: `user:${userId}`,
  };
  const write = async (vault: VaultRow, name: string, value: string) =>
    await upsertVaultItem(db, context, {
      vaultId: vault.id,
      name,
      type: "api_key",
      fields: [
        {
          name: "value",
          kind: "concealed",
          valueEncrypted: encryptEnvironmentValue(Buffer.from(key), value),
          valueSize: Buffer.byteLength(value),
        },
      ],
    });
  const connection = async (
    overrides: { subjectId?: string | null; status?: string; vault?: boolean } = {},
  ) => {
    // A personal connection is bound to its owner, who must be the caller.
    const rows = await shared!.admin.begin(async (tx) => {
      if (overrides.subjectId) {
        await tx`select set_config('opengeni.account_id', ${grant.accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${grant.workspaceId}, true)`;
        await tx`select set_config('opengeni.subject_id', ${overrides.subjectId}, true)`;
      }
      return await tx<{ id: string }[]>`
      insert into connections (
        account_id, workspace_id, origin_workspace_id, subject_id, provider_domain, kind,
        credential_encrypted, status, metadata
      ) values (
        ${grant.accountId}, ${grant.workspaceId}, ${grant.workspaceId},
        ${overrides.subjectId ?? null}, 'mcp.example.test', 'api_key',
        'ciphertext-never-read-here', ${overrides.status ?? "active"},
        ${shared!.admin.json(overrides.vault === false ? {} : { credentialSource: "vault" })}
      ) returning id`;
    });
    return rows[0]!.id;
  };
  return { db, grant, context, write, connection, subjectId: `user:${userId}` };
}

const RAW = (path: string) => `{{secret:${path}}}`;

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "shared service connection keys (PostgreSQL)",
  () => {
    test("reach workspace and organization vaults, never Only me; audited without the value", async () => {
      if (!client) return;
      const w = await world();
      const team = await createVault(w.db, w.context, { name: "Team", ownerKind: "workspace" });
      const org = await createVault(w.db, w.context, {
        name: "Org",
        ownerKind: "organization",
        allowOrganization: true,
      });
      const mine = await createVault(w.db, w.context, { name: "Mine", ownerKind: "user" });
      await w.write(team, "Team key", "team-synthetic");
      await w.write(org, "Org key", "org-synthetic");
      await w.write(mine, "My key", "mine-synthetic");
      const connectionId = await w.connection();
      const resolve = (headers: Record<string, string>, id: string | null = connectionId) =>
        resolveServiceConnectionHeaders(
          { db: w.db, settings },
          {
            connection: {
              id,
              accountId: w.grant.accountId,
              workspaceId: w.grant.workspaceId,
              providerDomain: "mcp.example.test",
            },
            headers,
            serverId: "example",
            toolName: "list_items",
            destinationUrl: "https://mcp.example.test/mcp",
          },
        );

      expect(
        await resolve({
          Authorization: `Bearer ${RAW("Team/Team key")}`,
          "X-Org": RAW("Org/Org key"),
          "X-Static": "plain",
        }),
      ).toEqual({
        Authorization: "Bearer team-synthetic",
        "X-Org": "org-synthetic",
        "X-Static": "plain",
      });
      // Before the connection exists (an admin checking a key): the same reach.
      expect(await resolve({ Authorization: RAW("Team/Team key") }, null)).toEqual({
        Authorization: "team-synthetic",
      });

      const failure = async (promise: Promise<unknown>) => {
        try {
          await promise;
        } catch (error) {
          return error;
        }
        throw new Error("expected a failure");
      };
      // Someone's Only me vault is out of reach, even its owner's.
      for (const headers of [{ Authorization: RAW("Mine/My key") }, { Authorization: RAW("My key") }]) {
        const error = await failure(resolve(headers));
        expect(error).toBeInstanceOf(ServiceConnectionCredentialError);
        expect((error as Error).message).not.toContain("My key");
        expect((error as Error).message).not.toContain("mine-synthetic");
      }
      expect(
        ((await failure(resolve({ Authorization: RAW("Team/Missing") }))) as ServiceConnectionCredentialError)
          .code,
      ).toBe("not_found");
      expect(
        ((await failure(resolve({ Authorization: "{{secret:" }))) as ServiceConnectionCredentialError).code,
      ).toBe("invalid");
      // Only an active, workspace-owned, vault-marked connection may resolve.
      for (const other of [
        await w.connection({ subjectId: w.subjectId }),
        await w.connection({ status: "revoked" }),
        await w.connection({ vault: false }),
      ]) {
        expect(await failure(resolve({ Authorization: RAW("Team/Team key") }, other))).toBeInstanceOf(
          ServiceConnectionCredentialError,
        );
      }

      const rows = await shared!.admin<{ subject_id: string | null; metadata: Record<string, unknown> }[]>`
        select subject_id, metadata from audit_events
        where account_id = ${w.grant.accountId}::uuid and action = 'vault.secret.used'
        order by occurred_at`;
      expect(rows.length).toBe(2);
      expect(rows[0]!.subject_id).toBeNull();
      expect(rows[0]!.metadata).toMatchObject({
        principalKind: "service_connection",
        connectionId,
        count: 2,
      });
      const audit = JSON.stringify(rows);
      for (const value of ["team-synthetic", "org-synthetic", "mine-synthetic"])
        expect(audit).not.toContain(value);
    });
  },
);
