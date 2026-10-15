// Moving and copying vault items over HTTP through the composed API, against
// PostgreSQL: a connected (remote bridge) vault is installed, linked and
// synced through its configured provider factory, and every move or copy
// between it and a hosted vault goes through that same provider. A move whose
// copy was saved but whose original could not be archived reports the copy as
// saved, so it is never repeated.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  signDelegatedAccessToken,
  type Permission,
  type VaultProviderCredentials,
} from "@opengeni/contracts";
import type { ExternalVaultProviderFactories } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import { createProviderCallBudget, VaultProviderError } from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

const delegationSecret = randomBytes(32).toString("hex");
const encryptionKey = randomBytes(32).toString("base64");
const signingSecret = randomBytes(32).toString("hex");
let shared: SharedTestDatabase | null;
let client: DbClient;
let settings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-vault-move-routes");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret,
    environmentsEncryptionKey: encryptionKey,
    publicBaseUrl: "https://app.example.test",
  }) as Settings;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

type Scope = { accountId: string; workspaceId: string };

async function scope(): Promise<Scope> {
  const [account] = await shared!.admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('vault move test') returning id`;
  const [workspace] = await shared!.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${account!.id}, 'vault move test') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  await shared!
    .admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id) values (${account!.id}, 'person-a', 'active', ${workspace!.id})`;
  await shared!
    .admin`insert into workspace_memberships (account_id, workspace_id, subject_id, subject_label, role, permissions)
    values (${account!.id}, ${workspace!.id}, 'person-a', 'person-a', 'member', ${shared!.admin.json(GRANTED)})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

/** What the person may do; `secrets:use` lets the test reveal values it checks. */
const GRANTED: Permission[] = [
  "connections:read",
  "connections:write",
  "secrets:list",
  "secrets:write",
  "secrets:use",
];

/**
 * The app with a remote bridge factory over one fake provider that keeps its
 * state across requests, as a configured bridge would.
 */
function fixture() {
  const fake = createFakeVaultProvider({
    vaults: [
      {
        externalVaultId: "remote-vault",
        name: "Remote",
        items: [
          {
            name: "Deploy key",
            type: "api_key",
            fields: [{ name: "value", value: "deploy-secret" }],
          },
          { name: "Release token", type: "api_key", fields: [{ name: "value", value: "release" }] },
          { name: "Old token", type: "api_key", fields: [{ name: "value", value: "old-secret" }] },
        ],
      },
    ],
  });
  const archiveUpstream = fake.archiveItem!.bind(fake);
  let archiveFailure: VaultProviderError | null = null;
  const factories: ExternalVaultProviderFactories = {
    external: async ({ credentials }) => ({
      provider: {
        ...fake,
        id: "external" as const,
        validate: async () => ({ accountId: "bridge-account", accountName: "Bridge" }),
        async archiveItem(ctx, externalVaultId, externalItemId) {
          if (archiveFailure) {
            fake.calls.push({
              op: "archiveItem",
              connectionId: ctx.connectionId,
              externalVaultId,
              externalItemId,
            });
            throw archiveFailure;
          }
          await archiveUpstream(ctx, externalVaultId, externalItemId);
        },
      },
      credentials: credentials as Extract<VaultProviderCredentials, { provider: "external" }>,
    }),
  };
  const app = createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    externalVaultProviders: factories,
  } as never);
  async function request(
    target: Scope,
    path: string,
    method = "GET",
    body?: unknown,
    permissions: Permission[] = GRANTED,
  ) {
    const token = await signDelegatedAccessToken(delegationSecret, {
      ...target,
      subjectId: "person-a",
      permissions,
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    return app.request(`/v1/workspaces/${target.workspaceId}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function json<T>(response: Response, status: number): Promise<T> {
    const text = await response.text();
    if (response.status !== status) {
      throw new Error(`expected ${status}, got ${response.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  }
  /** Installs a workspace bridge connection, links its vault read-write and makes a hosted vault. */
  async function world() {
    const target = await scope();
    const installed = await json<{ connectionId: string }>(
      await request(target, "/vault-providers/connections", "POST", {
        ownership: "workspace",
        credentials: {
          provider: "external",
          endpoint: "https://vault.example.test/resolve",
          signingSecret,
        },
      }),
      201,
    );
    const remote = await json<{ id: string }>(
      await request(target, "/vaults/link", "POST", {
        provider: "external",
        connectionId: installed.connectionId,
        externalVaultId: "remote-vault",
        ownerKind: "workspace",
        mode: "read_write",
        name: "Remote",
      }),
      201,
    );
    const team = await json<{ id: string }>(
      await request(target, "/vaults", "POST", { name: "Team", ownerKind: "workspace" }),
      201,
    );
    return { target, remote, team };
  }
  type Item = {
    id: string;
    name: string;
    vaultId: string;
    archivedAt: string | null;
    fields: Array<{ id: string; name: string }>;
  };
  async function items(target: Scope, vaultId: string) {
    return (
      await json<{ items: Array<{ id: string; name: string; archivedAt: string | null }> }>(
        await request(target, `/vaults/${vaultId}/items`),
        200,
      )
    ).items;
  }
  async function itemNamed(target: Scope, vaultId: string, name: string) {
    const summary = (await items(target, vaultId)).find((item) => item.name === name);
    if (!summary) throw new Error(`${name} is not listed`);
    return await json<Item>(await request(target, `/vaults/${vaultId}/items/${summary.id}`), 200);
  }
  async function reveal(target: Scope, item: Item) {
    const field = item.fields.find((candidate) => candidate.name === "value")!;
    return (
      await json<{ value: string }>(
        await request(
          target,
          `/vaults/${item.vaultId}/items/${item.id}/fields/${field.id}/reveal`,
          "POST",
          {},
        ),
        200,
      )
    ).value;
  }
  /** The names the provider itself still lists (archived items are not listed). */
  const providerNames = async () =>
    (
      await fake.listItems(
        { connectionId: "inspection", budget: createProviderCallBudget(50) },
        "remote-vault",
      )
    ).map((item) => item.name);
  return {
    fake,
    request,
    json,
    world,
    items,
    itemNamed,
    reveal,
    providerNames,
    archives: () => fake.calls.filter((call) => call.op === "archiveItem"),
    writes: () => fake.calls.filter((call) => call.op === "writeItem"),
    failArchive: (failure: VaultProviderError | null) => {
      archiveFailure = failure;
    },
  };
}

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "moving vault items over HTTP through configured providers",
  () => {
    test("copies and moves from a connected vault into a hosted one", async () => {
      if (!shared) return;
      const f = fixture();
      const { target, remote, team } = await f.world();

      // Copy: the hosted copy holds the provider's value; the original stays.
      const deploy = await f.itemNamed(target, remote.id, "Deploy key");
      const copied = await f.json<{ id: string; vaultId: string; name: string }>(
        await f.request(target, `/vaults/${remote.id}/items/${deploy.id}/move`, "POST", {
          targetVaultId: team.id,
          mode: "copy",
        }),
        200,
      );
      expect(copied).toMatchObject({ vaultId: team.id, name: "Deploy key" });
      expect(await f.reveal(target, await f.itemNamed(target, team.id, "Deploy key"))).toBe(
        "deploy-secret",
      );
      expect(f.archives()).toHaveLength(0);
      expect(await f.providerNames()).toContain("Deploy key");

      // Move: saved in the hosted vault, then the original is archived upstream.
      const release = await f.itemNamed(target, remote.id, "Release token");
      const moved = await f.json<{ id: string; vaultId: string }>(
        await f.request(target, `/vaults/${remote.id}/items/${release.id}/move`, "POST", {
          targetVaultId: team.id,
          mode: "move",
        }),
        200,
      );
      expect(moved.vaultId).toBe(team.id);
      expect(await f.reveal(target, await f.itemNamed(target, team.id, "Release token"))).toBe(
        "release",
      );
      expect(f.archives()).toHaveLength(1);
      expect(f.archives()[0]).toMatchObject({ externalVaultId: "remote-vault" });
      expect(await f.providerNames()).not.toContain("Release token");

      // The copy was saved but the provider refused to archive the original:
      // the response says so (saved, not archived) with both sides' IDs.
      f.failArchive(new VaultProviderError("provider_unavailable", "bridge offline"));
      const old = await f.itemNamed(target, remote.id, "Old token");
      const response = await f.request(
        target,
        `/vaults/${remote.id}/items/${old.id}/move`,
        "POST",
        {
          targetVaultId: team.id,
          mode: "move",
        },
      );
      const body = (await response.json()) as {
        error: string;
        message: string;
        details: Record<string, unknown>;
      };
      expect(response.status).toBe(503);
      expect(body.error).toBe("provider_unavailable");
      const saved = await f.itemNamed(target, team.id, "Old token");
      expect(body.details).toEqual({
        saved: true,
        sourceArchived: false,
        vaultId: team.id,
        itemId: saved.id,
        sourceItemId: old.id,
        sourceVaultId: remote.id,
      });
      expect(body.message).toContain("Do not move it again");
      expect(await f.reveal(target, saved)).toBe("old-secret");
      expect(f.archives()).toHaveLength(2);
      expect(await f.providerNames()).toContain("Old token");
      expect((await f.itemNamed(target, remote.id, "Old token")).archivedAt).toBeNull();
    }, 60_000);

    test("copies and moves from a hosted vault into a connected one", async () => {
      if (!shared) return;
      const f = fixture();
      const { target, remote, team } = await f.world();
      const create = async (name: string, value: string) =>
        await f.json<{ id: string }>(
          await f.request(target, `/vaults/${team.id}/items`, "POST", {
            type: "api_key",
            name,
            fields: [{ name: "value", kind: "concealed", value }],
          }),
          201,
        );
      const shared1 = await create("Shared token", "shared-secret");
      const moving = await create("Moving token", "moving-secret");

      await f.json(
        await f.request(target, `/vaults/${team.id}/items/${shared1.id}/move`, "POST", {
          targetVaultId: remote.id,
          mode: "copy",
        }),
        200,
      );
      await f.json(
        await f.request(target, `/vaults/${team.id}/items/${moving.id}/move`, "POST", {
          targetVaultId: remote.id,
          mode: "move",
        }),
        200,
      );
      // Both were written through the provider and read back from it.
      expect(f.writes()).toHaveLength(2);
      expect(await f.reveal(target, await f.itemNamed(target, remote.id, "Shared token"))).toBe(
        "shared-secret",
      );
      expect(await f.reveal(target, await f.itemNamed(target, remote.id, "Moving token"))).toBe(
        "moving-secret",
      );
      // The copied original stays; the moved one is archived (recoverably) in the hosted vault.
      const hosted = await f.items(target, team.id);
      expect(hosted.map((item) => item.name)).toContain("Shared token");
      expect(hosted.map((item) => item.name)).not.toContain("Moving token");
    }, 60_000);

    test("moves keep their permission and path checks", async () => {
      if (!shared) return;
      const f = fixture();
      const { target, remote, team } = await f.world();
      const deploy = await f.itemNamed(target, remote.id, "Deploy key");
      const body = { targetVaultId: team.id, mode: "move" };
      const readOnly = await f.request(
        target,
        `/vaults/${remote.id}/items/${deploy.id}/move`,
        "POST",
        body,
        ["secrets:list"],
      );
      expect(readOnly.status).toBe(403);
      // The item must live in the vault the path names.
      const wrongPath = await f.request(
        target,
        `/vaults/${team.id}/items/${deploy.id}/move`,
        "POST",
        body,
      );
      expect(wrongPath.status).toBe(404);
      expect(f.archives()).toHaveLength(0);
      expect(f.writes()).toHaveLength(0);
      expect((await f.items(target, team.id)).map((item) => item.name)).toEqual([]);
    }, 60_000);
  },
);
