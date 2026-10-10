// The shared subscription-core writers honour their provider binding: the
// TypeScript registry agrees with the SQL registry, unregistered providers
// and foreign primary columns are refused, and the extraCredits/apps
// capabilities, a missing primary column and a missing allocator hook gate
// exactly what they name. Variant bindings of the registered Codex provider
// stand in for future providers, as the restricted application role.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  designateSubscriptionCoreCodexApps,
  ensureManagedAccessForUser,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import {
  setSubscriptionCoreAllocator,
  setSubscriptionCoreExtraCredits,
  setSubscriptionCorePrimary,
  setSubscriptionCoreRotation,
} from "../src/subscription-core/administration";
import {
  connectSubscriptionCoreConnection,
  disconnectSubscriptionCoreConnection,
} from "../src/subscription-core/connections";
import {
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "../src/subscription-core/provider";
import {
  subscriptionCoreProvider,
  subscriptionCoreProviderIds,
} from "../src/subscription-core-providers";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 61);

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-binding-gates-v1");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const registered = () => subscriptionCoreProvider("codex");

/** The registered binding with one part replaced, as a future provider might differ. */
function variant(
  change: (base: SubscriptionCoreProvider) => Partial<SubscriptionCoreProvider>,
): SubscriptionCoreProvider {
  const base = registered();
  return { ...base, ...change(base) };
}

function withCapabilities(
  capabilities: Partial<SubscriptionCoreProvider["adapter"]["capabilities"]>,
): SubscriptionCoreProvider {
  return variant((base) => ({
    adapter: { ...base.adapter, capabilities: { ...base.adapter.capabilities, ...capabilities } },
  }));
}

type Org = {
  accountId: string;
  ownerSubjectId: string;
  sharedWorkspaceId: string;
  otherWorkspaceId: string;
};

async function organization(): Promise<Org> {
  const userId = `core-binding-gates-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Core binding gates fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const workspaces: string[] = [];
  for (const name of ["Core binding gates shared", "Core binding gates other"]) {
    const [workspace] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${accountId}::uuid, ${name}) returning id::text as id`;
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}::uuid, ${workspace!.id}::uuid, ${ownerSubjectId}, 'owner')`;
    await shared!.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}::uuid, ${accountId}::uuid)`;
    workspaces.push(workspace!.id);
  }
  await shared!.admin`
    delete from subscription_settings
    where account_id = ${accountId}::uuid and workspace_id is null`;
  await shared!.admin`
    insert into subscription_settings (
      account_id, rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed
    ) values (
      ${accountId}::uuid, ${shared!.admin.json({ codex: { mode: "spread" } })}::jsonb,
      '{}'::jsonb, false, '{}'::jsonb, true, false
    )`;
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', true)
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
  return {
    accountId,
    ownerSubjectId,
    sharedWorkspaceId: workspaces[0]!,
    otherWorkspaceId: workspaces[1]!,
  };
}

async function connectOrganizationConnection(
  org: Org,
  label: string,
  workspaceId: string | null = null,
): Promise<string> {
  const connected = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    connectSubscriptionCoreConnection(client!.db, registered(), {
      accountId: org.accountId,
      workspaceId,
      subjectId: org.ownerSubjectId,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: `a-${label}`, refresh_token: `r-${label}`, id_token: "i" }),
      ),
      providerAccountId: `upstream-${label}`,
      providerSubjectId: `person-${label}`,
      planType: "pro",
      expiresAt: new Date(Date.now() + 86_400_000),
      lastRefreshAt: new Date(),
      accountEmail: `${label}@example.test`,
      label,
      providerState: {},
    }),
  );
  if (connected.kind !== "connected") throw new Error(`connect failed: ${connected.kind}`);
  return connected.id;
}

async function settingsRow(org: Org, workspaceId: string | null) {
  const [row] = await shared!.admin<{ primary_id: string | null; mode: string | null }[]>`
    select codex_primary_connection_id::text as primary_id, rotation->'codex'->>'mode' as mode
    from subscription_settings
    where account_id = ${org.accountId}::uuid
      and workspace_id is not distinct from ${workspaceId}::uuid`;
  return row ?? null;
}

const asOwner = <T>(org: Org, fn: () => Promise<T>) =>
  withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, fn);

describe("subscription-core binding gates (pure)", () => {
  test("unregistered providers and another provider's primary column are refused", () => {
    expect(subscriptionCoreProviderId(registered())).toBe("codex");
    expect(() =>
      subscriptionCoreProviderId(
        variant((base) => ({ adapter: { ...base.adapter, provider: "unregistered-provider" } })),
      ),
    ).toThrow();
    expect(() =>
      subscriptionCoreProviderId(
        variant(() => ({ settings: { primaryColumn: "other_primary_connection_id" } })),
      ),
    ).toThrow("another provider's primary column");
    expect(subscriptionCoreProviderId(variant(() => ({ settings: { primaryColumn: null } })))).toBe(
      "codex",
    );
  });

  test("without the extraCredits capability the writer refuses before any query", async () => {
    const untouchable = new Proxy(
      {},
      {
        get() {
          throw new Error("the database must not be used");
        },
      },
    ) as never;
    await expect(
      setSubscriptionCoreExtraCredits(untouchable, withCapabilities({ extraCredits: false }), {
        accountId: crypto.randomUUID(),
        workspaceId: null,
        subjectId: "user:nobody",
        connectionId: crypto.randomUUID(),
        enabled: true,
        expectedVersion: 0,
      }),
    ).resolves.toEqual({ result: { kind: "not_found" }, wake: null });
  });
});

describe.skipIf(!realDb)("subscription-core binding gates (PostgreSQL)", () => {
  test("the TypeScript registry agrees with the SQL registry", async () => {
    const rows = await shared!.admin<
      { provider: string; extra_credits: boolean; primary_setting_column: string | null }[]
    >`select provider, extra_credits, primary_setting_column
      from opengeni_private.subscription_core_providers order by provider`;
    expect(rows.map((row) => row.provider)).toEqual([...subscriptionCoreProviderIds()].sort());
    for (const row of rows) {
      const binding = subscriptionCoreProvider(row.provider);
      expect(binding.settings.primaryColumn).toBe(row.primary_setting_column);
      expect(binding.adapter.capabilities.extraCredits).toBe(row.extra_credits);
    }
  });

  test("a provider without a primary column writes rotation but never a primary", async () => {
    const org = await organization();
    const connectionId = await connectOrganizationConnection(org, "primary-gate");
    const organizationRoute = {
      accountId: org.accountId,
      workspaceId: null,
      subjectId: org.ownerSubjectId,
    };
    await asOwner(org, () =>
      setSubscriptionCorePrimary(client!.db, registered(), { ...organizationRoute, connectionId }),
    );
    expect((await settingsRow(org, null))?.primary_id).toBe(connectionId);

    const noPrimary = variant(() => ({ settings: { primaryColumn: null } }));
    const organizationRotation = await asOwner(org, () =>
      setSubscriptionCoreRotation(client!.db, noPrimary, {
        ...organizationRoute,
        rotationEnabled: false,
      }),
    );
    expect(organizationRotation?.primaryConnectionId).toBeNull();
    // The column it does not own is left alone.
    expect(await settingsRow(org, null)).toEqual({
      primary_id: connectionId,
      mode: "primary_first",
    });

    // A workspace override carries no inherited primary for such a provider,
    // while the registered binding carries the organization's.
    await asOwner(org, () =>
      setSubscriptionCoreRotation(client!.db, noPrimary, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        subjectId: org.ownerSubjectId,
        rotationEnabled: true,
      }),
    );
    expect(await settingsRow(org, org.sharedWorkspaceId)).toEqual({
      primary_id: null,
      mode: "spread",
    });
    await asOwner(org, () =>
      setSubscriptionCoreRotation(client!.db, registered(), {
        accountId: org.accountId,
        workspaceId: org.otherWorkspaceId,
        subjectId: org.ownerSubjectId,
        rotationEnabled: true,
      }),
    );
    expect(await settingsRow(org, org.otherWorkspaceId)).toEqual({
      primary_id: connectionId,
      mode: "spread",
    });

    await expect(
      asOwner(org, () =>
        setSubscriptionCorePrimary(client!.db, noPrimary, { ...organizationRoute, connectionId }),
      ),
    ).rejects.toThrow("no primary connection setting");
    expect((await settingsRow(org, null))?.primary_id).toBe(connectionId);
  });

  test("the organization allocator hook is optional and receives the organization switch", async () => {
    const org = await organization();
    const connectionId = await connectOrganizationConnection(org, "allocator-gate");
    const calls: Array<[string, string]> = [];
    const recording = variant(() => ({
      organizationAllocatorChanged: async (_tx, accountId, changed) => {
        calls.push([accountId, changed]);
      },
    }));
    const switched = await asOwner(org, () =>
      setSubscriptionCoreAllocator(client!.db, recording, {
        accountId: org.accountId,
        workspaceId: null,
        subjectId: org.ownerSubjectId,
        connectionId,
        enabled: false,
        expectedVersion: 1,
      }),
    );
    expect(switched.result).toMatchObject({ kind: "updated", allocatorEnabled: false });
    expect(calls).toEqual([[org.accountId, connectionId]]);

    const withoutHook = variant(() => ({ organizationAllocatorChanged: null }));
    const again = await asOwner(org, () =>
      setSubscriptionCoreAllocator(client!.db, withoutHook, {
        accountId: org.accountId,
        workspaceId: null,
        subjectId: org.ownerSubjectId,
        connectionId,
        enabled: true,
        expectedVersion: 2,
      }),
    );
    expect(again.result).toMatchObject({ kind: "updated", allocatorEnabled: true });
  });

  test("only a provider with the apps capability reports the Apps designations a disconnect clears", async () => {
    for (const apps of [true, false]) {
      const org = await organization();
      // A workspace-managed account, removed on its workspace route.
      const connectionId = await connectOrganizationConnection(
        org,
        `apps-gate-${apps}`,
        org.sharedWorkspaceId,
      );
      const designated = await asOwner(org, () =>
        designateSubscriptionCoreCodexApps(client!.db, {
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
          subjectId: org.ownerSubjectId,
          connectionId,
          expectedVersion: 0,
        }),
      );
      expect(designated.kind).toBe("updated");
      const removed = await asOwner(org, () =>
        disconnectSubscriptionCoreConnection(client!.db, withCapabilities({ apps }), {
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
          subjectId: org.ownerSubjectId,
          connectionId,
        }),
      );
      expect(removed.outcome).toBe("removed");
      expect(removed.clearedAppsWorkspaceIds).toEqual(apps ? [org.sharedWorkspaceId] : []);
      const [audited] = await shared!.admin<{ count: number }[]>`
        select count(*)::int as count from audit_events
        where account_id = ${org.accountId}::uuid and target_id = ${connectionId}
          and action = 'codex_apps.cleared_on_disconnect'`;
      expect(audited!.count).toBe(apps ? 1 : 0);
      // The designation itself is gone either way (the cascade).
      const [left] = await shared!.admin<{ count: number }[]>`
        select count(*)::int as count from subscription_apps_designations
        where connection_id = ${connectionId}::uuid`;
      expect(left!.count).toBe(0);
    }
  });
});
