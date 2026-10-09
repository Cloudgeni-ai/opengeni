import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import * as db from "../src";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureCodexRotationSettings,
  ensureManagedAccessForUser,
  getSubscriptionCoreCodexCurrentSelections,
  getWorkspaceConnectionModelRestrictions,
  isCodexBilledTurn,
  listSubscriptionCoreCodexServingConnections,
  setInitialActiveCodexCredential,
  subscriptionCoreCodexConnectionAllowlist,
  subscriptionCoreCodexConnectionAllowsModel,
  upsertCodexSubscriptionCredential,
  withSessionRlsActorContext,
  workspaceCodexSubscriptionActive,
  type DbClient,
} from "../src";
import { encryptEnvironmentValue } from "../src/environment-crypto";

// Codex readiness after the drained cutover (0680): every organization is
// born with an enabled Codex cutover row, the legacy Codex tables are frozen,
// and readiness, model restrictions and the billing bypass come from the
// shared core. A disabled row fails closed; no row keeps the legacy readers.

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 43);
const settings = {
  environmentsEncryptionKey: key.toString("base64"),
  codexSubscriptionEnabled: true,
} as Settings;
const MODEL = "codex/gpt-5.5";

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-codex-catalog-v1");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Org = {
  accountId: string;
  ownerSubjectId: string;
  ownerMembershipId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
};

function encryptedTokens(label: string): string {
  return encryptEnvironmentValue(
    key,
    JSON.stringify({
      access_token: `access-${label}`,
      refresh_token: `refresh-${label}`,
      id_token: `id-${label}`,
    }),
  );
}

/** A new organization exactly as 0680 seeds it: Codex cutover enabled. */
async function organization(): Promise<Org> {
  const userId = `core-codex-catalog-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Core Codex catalog fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null limit 1`;
  const [sharedWorkspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Core Codex catalog shared workspace') returning id::text as id`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${sharedWorkspace!.id}::uuid, ${ownerSubjectId}, 'owner')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${sharedWorkspace!.id}::uuid, ${accountId}::uuid)`;
  const [cutover] = await shared!.admin<{ enabled: boolean }[]>`
    select enabled from subscription_provider_cutovers
    where account_id = ${accountId}::uuid and provider = 'codex'`;
  expect(cutover?.enabled).toBe(true);
  return {
    accountId,
    ownerSubjectId,
    ownerMembershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: sharedWorkspace!.id,
  };
}

async function setCutover(org: Org, enabled: boolean | null): Promise<void> {
  if (enabled === null) {
    await shared!.admin`delete from subscription_provider_cutovers
      where account_id = ${org.accountId}::uuid and provider = 'codex'`;
    return;
  }
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${org.accountId}::uuid, 'codex', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

async function sharedConnection(
  org: Org,
  label: string,
  options: { allowedModelIds?: string[] | null } = {},
): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, plan_type, provider_state, expires_at, allowed_model_ids, label
    ) values (
      ${org.accountId}::uuid, 'codex', 'subscription', ${encryptedTokens(label)},
      'shared', 'organization', ${`chatgpt-${label}`}, 'pro',
      ${shared!.admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz,
      ${options.allowedModelIds ?? null}::text[], ${label}
    ) returning id::text as id`;
  return row!.id;
}

async function personalConnection(org: Org, label: string): Promise<string> {
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await shared!.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (
      ${authorityId}::uuid, ${org.accountId}::uuid, ${org.ownerMembershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, 1, 'active'
    )`;
  await shared!.admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id, provider_state, expires_at
    ) values (
      ${connectionId}::uuid, ${org.accountId}::uuid, 'codex', ${encryptedTokens(label)},
      'personal', 'people', ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId},
      ${authorityId}::uuid, 'subscription_connection', 1, ${`chatgpt-${label}`},
      ${shared!.admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz
    )`;
  return connectionId;
}

async function allowPersonalFallback(org: Org, allowed: boolean): Promise<void> {
  await shared!.admin`
    update subscription_settings set personal_fallback_allowed = ${allowed}
    where account_id = ${org.accountId}::uuid and workspace_id is null`;
}

/** A legacy Personal-workspace-style credential, written before any cutover row. */
async function legacyCredential(org: Org, workspaceId: string): Promise<string> {
  const upserted = await upsertCodexSubscriptionCredential(client!.db, {
    accountId: org.accountId,
    workspaceId,
    credentialEncrypted: encryptedTokens(`legacy-${workspaceId}`),
    chatgptAccountId: `chatgpt-legacy-${workspaceId}`,
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 86_400_000),
    lastRefreshAt: new Date(),
  });
  if (upserted.kind === "unresolved_redemption") throw new Error("unexpected redemption fence");
  await ensureCodexRotationSettings(client!.db, org.accountId, workspaceId);
  await setInitialActiveCodexCredential(client!.db, workspaceId, upserted.id);
  return upserted.id;
}

function serving(org: Org, workspaceId: string, subjectId: string | null) {
  return listSubscriptionCoreCodexServingConnections(client!.db, {
    accountId: org.accountId,
    workspaceId,
    subjectId,
  });
}

describe.skipIf(!realDb)("Codex readiness on the shared core after the cutover", () => {
  test("a core-only shared connection makes Codex ready, unrestricted and subscription-billed", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org, "shared-ready");
    const ws = org.sharedWorkspaceId;
    expect((await serving(org, ws, org.ownerSubjectId)).map((row) => row.connectionId)).toEqual([
      connectionId,
    ]);
    // Subjectless readers see the same shared capacity.
    expect((await serving(org, ws, null)).map((row) => row.connectionId)).toEqual([connectionId]);
    const legacyList = spyOn(db, "listCodexAccountStatuses");
    try {
      expect(await workspaceCodexSubscriptionActive(client!.db, settings, ws)).toBe(true);
      expect(
        await isCodexBilledTurn({ db: client!.db, settings, workspaceId: ws, model: MODEL }),
      ).toBe(true);
      const restrictions = await getWorkspaceConnectionModelRestrictions(
        client!.db,
        ws,
        org.ownerSubjectId,
      );
      expect(restrictions["codex/"]).toBeNull();
      expect(legacyList).not.toHaveBeenCalled();
    } finally {
      legacyList.mockRestore();
    }
  });

  test("a born-enabled organization without a core connection is not ready, even with frozen legacy rows", async () => {
    const org = await organization();
    const ws = org.sharedWorkspaceId;
    // A legacy credential written in the pre-cutover world, then the row returns.
    await setCutover(org, null);
    await legacyCredential(org, ws);
    expect(await workspaceCodexSubscriptionActive(client!.db, settings, ws)).toBe(true);
    expect(
      (await getWorkspaceConnectionModelRestrictions(client!.db, ws, org.ownerSubjectId))["codex/"],
    ).toBeNull();
    await setCutover(org, true);
    expect(await workspaceCodexSubscriptionActive(client!.db, settings, ws)).toBe(false);
    expect(
      await isCodexBilledTurn({ db: client!.db, settings, workspaceId: ws, model: MODEL }),
    ).toBe(false);
    // No connection can serve: every Codex model is closed.
    expect(
      (await getWorkspaceConnectionModelRestrictions(client!.db, ws, org.ownerSubjectId))["codex/"],
    ).toEqual([]);
  });

  test("a disabled cutover fails closed without reading a legacy Codex table", async () => {
    const org = await organization();
    const ws = org.sharedWorkspaceId;
    await sharedConnection(org, "shared-maintenance");
    await setCutover(org, false);
    const legacyList = spyOn(db, "listCodexAccountStatuses");
    try {
      expect(await serving(org, ws, org.ownerSubjectId)).toEqual([]);
      expect(await workspaceCodexSubscriptionActive(client!.db, settings, ws)).toBe(false);
      expect(
        await isCodexBilledTurn({ db: client!.db, settings, workspaceId: ws, model: MODEL }),
      ).toBe(false);
      expect(
        (await getWorkspaceConnectionModelRestrictions(client!.db, ws, org.ownerSubjectId))[
          "codex/"
        ],
      ).toEqual([]);
      expect(legacyList).not.toHaveBeenCalled();
    } finally {
      legacyList.mockRestore();
    }
  });

  test("the model allowlist intersects the connection and the workspace assignment policy", async () => {
    const org = await organization();
    const ws = org.sharedWorkspaceId;
    const connectionId = await sharedConnection(org, "shared-allowlist", {
      allowedModelIds: ["codex/gpt-5.5", "codex/gpt-5.4"],
    });
    await shared!.admin`
      insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool, allowed_model_ids
      ) values (${org.accountId}::uuid, ${connectionId}::uuid, ${ws}::uuid, 'organization',
        ${["codex/gpt-5.5", "codex/gpt-5.3"]}::text[])`;
    const [connection] = await serving(org, ws, org.ownerSubjectId);
    expect(connection?.connectionId).toBe(connectionId);
    expect(subscriptionCoreCodexConnectionAllowsModel(connection!, "codex/gpt-5.5")).toBe(true);
    expect(subscriptionCoreCodexConnectionAllowsModel(connection!, "codex/gpt-5.4")).toBe(false);
    expect(subscriptionCoreCodexConnectionAllowsModel(connection!, "codex/gpt-5.3")).toBe(false);
    expect(subscriptionCoreCodexConnectionAllowlist(connection!)).toEqual(["codex/gpt-5.5"]);
    expect(
      (await getWorkspaceConnectionModelRestrictions(client!.db, ws, org.ownerSubjectId))["codex/"],
    ).toEqual(["codex/gpt-5.5"]);
  });

  test("a personal connection serves only its owner, in their own Personal workspace, with personal fallback allowed", async () => {
    const org = await organization();
    const personal = await personalConnection(org, "personal-owner");
    // 0680 seeds new organizations with personal fallback off: placement
    // would not use the connection, so the catalog does not count it.
    expect(await serving(org, org.personalWorkspaceId, org.ownerSubjectId)).toEqual([]);
    await allowPersonalFallback(org, true);
    const own = await serving(org, org.personalWorkspaceId, org.ownerSubjectId);
    expect(own.map((row) => [row.connectionId, row.ownership])).toEqual([[personal, "personal"]]);
    expect(
      await workspaceCodexSubscriptionActive(
        client!.db,
        settings,
        org.personalWorkspaceId,
        undefined,
        { accountId: org.accountId, subjectId: org.ownerSubjectId },
      ),
    ).toBe(true);
    expect(
      await isCodexBilledTurn({
        db: client!.db,
        settings,
        workspaceId: org.personalWorkspaceId,
        model: MODEL,
        subjectId: org.ownerSubjectId,
      }),
    ).toBe(true);
    // Never another person's, never a subjectless reader's, never elsewhere.
    expect(
      await serving(
        org,
        org.personalWorkspaceId,
        `user:core-codex-stranger-${crypto.randomUUID()}`,
      ),
    ).toEqual([]);
    expect(await serving(org, org.personalWorkspaceId, null)).toEqual([]);
    expect(await serving(org, org.sharedWorkspaceId, org.ownerSubjectId)).toEqual([]);
    expect(
      await workspaceCodexSubscriptionActive(client!.db, settings, org.personalWorkspaceId),
    ).toBe(false);
    // A recorded plan refusal for one model is a live cooldown on that model.
    await shared!.admin`
      insert into subscription_connection_quota (account_id, connection_id, quota,
        observed_refresh_generation, revision)
      values (${org.accountId}::uuid, ${personal}::uuid,
        ${shared!.admin.json({
          windows: [],
          modelCooldowns: { [MODEL]: Date.now() + 3_600_000 },
          exhaustedUntil: null,
          exhaustedKind: null,
          source: "refusal",
        })}::jsonb, 1, 1)`;
    const [cooled] = await serving(org, org.personalWorkspaceId, org.ownerSubjectId);
    expect(cooled?.cooledDownModelIds).toEqual([MODEL]);
  });

  test("a session's current Codex selection comes from its core lease or explicit choice", async () => {
    const org = await organization();
    const ws = org.sharedWorkspaceId;
    const connectionId = await sharedConnection(org, "shared-selection");
    const session = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      createSession(client!.db, {
        accountId: org.accountId,
        workspaceId: ws,
        initialMessage: "core codex catalog fixture",
        resources: [],
        metadata: {},
        model: MODEL,
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        subjectId: org.ownerSubjectId,
        createdBy: { kind: "subject" as const, subjectId: org.ownerSubjectId },
        createdByContext: {},
      }),
    );
    const idle = await getSubscriptionCoreCodexCurrentSelections(client!.db, {
      accountId: org.accountId,
      workspaceId: ws,
      sessionIds: [session.id],
    });
    expect(idle.get(session.id)).toBeUndefined();
    const turn = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      enqueueSessionTurn(client!.db, {
        accountId: org.accountId,
        workspaceId: ws,
        sessionId: session.id,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `session-${session.id}`,
        source: "user",
        prompt: "core codex catalog fixture",
        resources: [],
        tools: [],
        model: MODEL,
        reasoningEffort: "medium",
        sandboxBackend: "none",
        metadata: {},
        initiator: { kind: "subject", subjectId: org.ownerSubjectId },
      }),
    );
    const claimed = await claimSessionWorkForAttempt(client!.db, ws, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    // Fixture only: the placement path that writes leases is PR 1's.
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        insert into subscription_leases (account_id, workspace_id, session_id, turn_id,
          connection_id, provider, holder_id, generation, leased_until)
        values (${org.accountId}::uuid, ${ws}::uuid, ${session.id}::uuid, ${turn.id}::uuid,
          ${connectionId}::uuid, 'codex', 'holder', 1, now() + interval '5 minutes')`;
    });
    const running = await getSubscriptionCoreCodexCurrentSelections(client!.db, {
      accountId: org.accountId,
      workspaceId: ws,
      sessionIds: [session.id],
    });
    expect(running.get(session.id)).toEqual({ waiting: false, credentialId: connectionId });
    // Waiting for capacity shows only an explicit choice.
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update session_turns set status = 'waiting_capacity' where id = ${turn.id}::uuid`;
      await tx`insert into subscription_session_bindings (
          account_id, workspace_id, session_id, provider, connection_id, model_id, choice
        ) values (${org.accountId}::uuid, ${ws}::uuid, ${session.id}::uuid, 'codex',
          ${connectionId}::uuid, ${MODEL}, 'automatic')`;
    });
    const waitingAutomatic = await getSubscriptionCoreCodexCurrentSelections(client!.db, {
      accountId: org.accountId,
      workspaceId: ws,
      sessionIds: [session.id],
    });
    expect(waitingAutomatic.get(session.id)).toEqual({ waiting: true, credentialId: null });
    await shared!.admin`update subscription_session_bindings set choice = 'explicit'
      where session_id = ${session.id}::uuid and provider = 'codex'`;
    const waitingExplicit = await getSubscriptionCoreCodexCurrentSelections(client!.db, {
      accountId: org.accountId,
      workspaceId: ws,
      sessionIds: [session.id],
    });
    expect(waitingExplicit.get(session.id)).toEqual({ waiting: true, credentialId: connectionId });
  });
});
