import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { emptyClaudeUsage } from "@opengeni/config";
import { decidePlacement } from "@opengeni/subscriptions";
import {
  createDb,
  createSession,
  createXaiSubscriptionCredential,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  LegacyPlacementWorldDeadlineError,
  loadLegacySubscriptionPlacementWorld,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withSessionRlsActorContext,
  type DbClient,
  type LegacyPlacementWorldRequest,
} from "../src";

// Real PostgreSQL under the restricted application role, so FORCE RLS applies.
setDefaultTimeout(120_000);
const realTest = test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1");
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const encryptionKey = new Uint8Array(32).fill(7);

beforeAll(async () => {
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  shared = await acquireSharedTestDatabase("legacy-subscription-world");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

/** A managed human with a Personal workspace, a shared workspace and private sessions on. */
async function fixture() {
  const suffix = crypto.randomUUID();
  const userId = `legacy-world-${suffix}`;
  const owner = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Legacy world owner",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const grantWorkspaceId = access.workspaceGrants[0]!.workspaceId!;
  const [membership] = await shared!.admin<{ personal_workspace_id: string }[]>`
    select personal_workspace_id from organization_memberships
    where account_id = ${accountId} and subject_id = ${owner}`;
  const personalWorkspaceId = membership!.personal_workspace_id;
  await shared!.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;
  const privateSettings = await getOrganizationPrivateSessionSettings(client!.db, {
    organizationId: accountId,
    actorSubjectId: owner,
  });
  await updateOrganizationPrivateSessionSettings(client!.db, {
    organizationId: accountId,
    actorSubjectId: owner,
    enabled: true,
    expectedVersion: privateSettings.version,
    operationId: crypto.randomUUID(),
  });
  const [team] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, 'Team') returning id`;
  const [other] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, 'Other') returning id`;
  for (const id of [team!.id, other!.id]) {
    await shared!.admin`
      insert into workspace_inference_controls (account_id, workspace_id)
      values (${accountId}, ${id})`;
  }
  return {
    accountId,
    owner,
    grantWorkspaceId,
    personalWorkspaceId,
    teamWorkspaceId: team!.id,
    otherWorkspaceId: other!.id,
  };
}

async function session(workspaceId: string, accountId: string, subjectId?: string) {
  const create = () =>
    createSession(client!.db, {
      accountId,
      workspaceId,
      initialMessage: "legacy world",
      resources: [],
      metadata: {},
      model: "fixture-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      ...(subjectId
        ? { createdBy: { kind: "subject" as const, subjectId }, createdByContext: {} }
        : {}),
    });
  const created = subjectId
    ? await withSessionRlsActorContext({ subjectId }, create)
    : await create();
  return { sessionId: created.id, turnId: crypto.randomUUID() };
}

async function codexCredential(input: {
  accountId: string;
  workspaceId: string | null;
  scope: "workspace" | "organization";
  status?: string;
  allowedWorkspaceIds?: string[] | null;
  usedPercent?: number | null;
}): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into codex_subscription_credentials (
      account_id, workspace_id, organization_id, authority_scope, credential_encrypted,
      chatgpt_account_id, status, allowed_workspace_ids, primary_used_percent, usage_checked_at
    ) values (
      ${input.accountId}, ${input.workspaceId},
      ${input.scope === "organization" ? input.accountId : null}, ${input.scope}, 'v1:enc',
      ${crypto.randomUUID()}, ${input.status ?? "active"}, ${input.allowedWorkspaceIds ?? null},
      ${input.usedPercent ?? null}, ${input.usedPercent === undefined ? null : new Date()}
    ) returning id`;
  return row!.id;
}

function request(
  base: { accountId: string; workspaceId: string; sessionId: string; turnId: string },
  patch: Partial<LegacyPlacementWorldRequest> = {},
): LegacyPlacementWorldRequest {
  return {
    ...base,
    provider: "codex",
    productModelId: "codex/test-model",
    upstreamModelId: "test-model",
    reasoningLevel: "medium",
    modelPolicyProviderId: "codex-subscription",
    authorityScope: null,
    initiatingHumanSubjectId: null,
    now: new Date(),
    statementTimeoutMs: 5_000,
    ...patch,
  };
}

const asTurn = <T>(initiatingHumanSubjectId: string | null, fn: () => Promise<T>) =>
  withSessionRlsActorContext({ subjectId: "service:agent-turn", initiatingHumanSubjectId }, fn);

describe("legacy subscription world", () => {
  realTest(
    "maps a shared workspace's Codex pool, mode, rotation and manual pin without reading out-of-scope accounts",
    async () => {
      const setup = await fixture();
      const workspaceId = setup.teamWorkspaceId;
      const primary = await codexCredential({
        accountId: setup.accountId,
        workspaceId,
        scope: "workspace",
        usedPercent: 40,
      });
      const relogin = await codexCredential({
        accountId: setup.accountId,
        workspaceId,
        scope: "workspace",
        status: "needs_relogin",
      });
      const organization = await codexCredential({
        accountId: setup.accountId,
        workspaceId: null,
        scope: "organization",
      });
      // Assigned to another workspace only: invisible here under RLS.
      const elsewhere = await codexCredential({
        accountId: setup.accountId,
        workspaceId: null,
        scope: "organization",
        allowedWorkspaceIds: [setup.otherWorkspaceId],
      });
      await shared!.admin`
        insert into codex_rotation_settings (account_id, workspace_id, active_credential_id, rotation_enabled)
        values (${setup.accountId}, ${workspaceId}, ${primary}, false)`;
      await shared!.admin`
        insert into workspace_codex_subscription_preferences (account_id, workspace_id, mode)
        values (${setup.accountId}, ${workspaceId}, 'workspace')`;
      const { sessionId } = await session(workspaceId, setup.accountId);
      // The turn's frozen Codex policy names the pool it was accepted for;
      // the live mode changed afterwards.
      const turn = await enqueueSessionTurn(client!.db, {
        accountId: setup.accountId,
        workspaceId,
        sessionId,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `legacy-world-${sessionId}`,
        source: "user",
        prompt: "legacy world",
        resources: [],
        tools: [],
        model: "codex/test-model",
        reasoningEffort: "medium",
        sandboxBackend: "none",
        metadata: { codexCredentialPolicySnapshotV1: { source: "organization" } },
        initiator: { kind: "subject", subjectId: setup.owner },
      });
      const turnId = turn.id;
      await shared!.admin`
        update sessions set codex_pinned_credential_id = ${primary}, codex_pin_source = 'manual'
        where id = ${sessionId}`;
      const credentialRows = async () => [
        ...(await shared!.admin<{ id: string; updated_at: Date; version: number }[]>`
          select id, updated_at, version from codex_subscription_credentials
          where account_id = ${setup.accountId} order by id`),
      ];
      const before = await credentialRows();

      const loaded = await asTurn(setup.owner, () =>
        loadLegacySubscriptionPlacementWorld(
          client!.db,
          request({ accountId: setup.accountId, workspaceId, sessionId, turnId }),
        ),
      );
      if (loaded.status !== "loaded") throw new Error("expected a loaded world: " + loaded.reason);
      const ids = loaded.input.connections.map((connection) => connection.id);
      expect(ids).toEqual([primary, relogin, organization]);
      expect(ids).not.toContain(elsewhere);
      expect(loaded.input.connections[0]).toMatchObject({
        ownership: {
          kind: "shared",
          managedByWorkspaceId: workspaceId,
          scope: { kind: "workspaces", workspaceIds: [workspaceId] },
        },
        health: "healthy",
      });
      expect(loaded.input.connections[1]!.health).toBe("needs_reconnect");
      expect(loaded.input.connections[2]!.ownership).toEqual({
        kind: "shared",
        managedByWorkspaceId: null,
        scope: { kind: "organization" },
      });
      expect(loaded.input.settings.providers).toEqual({
        codex: { useOrganizationAccounts: false, enabled: true },
      });
      expect(loaded.input.settings.rotation).toEqual({
        codex: { mode: "primary_first", primaryConnectionId: primary },
      });
      expect(loaded.input.session).toMatchObject({
        visibility: "shared",
        binding: { connectionId: primary, choice: "explicit" },
        personalAuthority: [],
      });
      expect(loaded.legacy).toMatchObject({
        source: "organization",
        codexMode: "workspace",
        rotationEnabled: null,
        activeConnectionId: null,
        pin: { connectionId: primary, source: "manual" },
        poolOrder: [organization],
        workspaceModelPolicy: "none",
        truncated: false,
      });
      // The core keeps the explicit choice; the organization account is off here.
      expect(decidePlacement(loaded.input)).toMatchObject({
        kind: "run",
        connectionId: primary,
        switch: "pinned",
      });
      // Read only: nothing changed.
      expect(await credentialRows()).toEqual(before);
    },
  );

  realTest(
    "a private session is read only with its owner as the initiating human, never without an actor",
    async () => {
      const setup = await fixture();
      const workspaceId = setup.personalWorkspaceId;
      const own = await codexCredential({
        accountId: setup.accountId,
        workspaceId,
        scope: "workspace",
      });
      const { sessionId, turnId } = await session(workspaceId, setup.accountId, setup.owner);
      await transitionSessionVisibility(client!.db, {
        workspaceId,
        sessionId,
        actorSubjectId: setup.owner,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `legacy-world-private-${sessionId}`,
      });
      const base = { accountId: setup.accountId, workspaceId, sessionId, turnId };

      expect(await loadLegacySubscriptionPlacementWorld(client!.db, request(base))).toEqual({
        status: "skipped",
        reason: "no_session_actor",
      });
      expect(
        await asTurn(`user:someone-else-${sessionId}`, () =>
          loadLegacySubscriptionPlacementWorld(client!.db, request(base)),
        ),
      ).toEqual({ status: "skipped", reason: "session_not_visible" });
      expect(
        await asTurn(null, () => loadLegacySubscriptionPlacementWorld(client!.db, request(base))),
      ).toEqual({ status: "skipped", reason: "session_not_visible" });

      const loaded = await asTurn(setup.owner, () =>
        loadLegacySubscriptionPlacementWorld(
          client!.db,
          request(base, { initiatingHumanSubjectId: setup.owner }),
        ),
      );
      if (loaded.status !== "loaded") throw new Error("expected a loaded world: " + loaded.reason);
      // A Personal workspace's account is its owner's personal connection (D-15).
      expect(loaded.input.workspace).toMatchObject({
        kind: "personal",
        ownerMembershipId: setup.owner,
      });
      expect(loaded.input.connections).toEqual([
        expect.objectContaining({
          id: own,
          ownership: { kind: "personal", ownerMembershipId: setup.owner },
        }),
      ]);
      expect(loaded.input.session).toMatchObject({
        visibility: "private",
        ownerMembershipId: setup.owner,
        personalAuthority: [{ provider: "codex", ownerMembershipId: setup.owner }],
      });
      expect(loaded.input.people[0]).toEqual({
        membershipId: setup.owner,
        active: true,
        personalFallbackOptIn: true,
      });
      expect(decidePlacement(loaded.input)).toMatchObject({ kind: "run", connectionId: own });
    },
  );

  realTest(
    "reads a user-scope SuperGrok pool under its owner and maps quota, and honours the deadline",
    async () => {
      const setup = await fixture();
      const workspaceId = setup.grantWorkspaceId;
      const mine = await createXaiSubscriptionCredential(client!.db, {
        accountId: setup.accountId,
        workspaceId,
        subjectId: setup.owner,
        scope: "user",
        encryptionKey,
        secret: { version: 1, accessToken: "test-access-token" },
        providerAccountId: "personal",
      });
      const resetAt = new Date(Date.now() + 30 * 60_000);
      await shared!.admin`
        update xai_subscription_credentials
        set quota_used_percent = 100, quota_reset_at = ${resetAt}, quota_checked_at = now()
        where id = ${mine.account.id}`;
      const { sessionId, turnId } = await session(workspaceId, setup.accountId, setup.owner);
      await transitionSessionVisibility(client!.db, {
        workspaceId,
        sessionId,
        actorSubjectId: setup.owner,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `legacy-world-xai-private-${sessionId}`,
      });
      const base = { accountId: setup.accountId, workspaceId, sessionId, turnId };
      const xai = {
        provider: "xai" as const,
        productModelId: "supergrok/test-model",
        authorityScope: "user" as const,
        initiatingHumanSubjectId: setup.owner,
      };
      const loaded = await asTurn(setup.owner, () =>
        loadLegacySubscriptionPlacementWorld(client!.db, request(base, xai)),
      );
      if (loaded.status !== "loaded") throw new Error("expected a loaded world: " + loaded.reason);
      expect(loaded.input.connections).toEqual([
        expect.objectContaining({
          id: mine.account.id,
          provider: "xai",
          ownership: { kind: "personal", ownerMembershipId: setup.owner },
        }),
      ]);
      expect(loaded.input.connections[0]!.quota?.windows[0]).toMatchObject({
        status: "exhausted",
        resetsAt: resetAt.getTime(),
      });
      expect(loaded.legacy).toMatchObject({ source: "user", poolOrder: [mine.account.id] });
      expect(decidePlacement(loaded.input)).toEqual({
        kind: "wait",
        reason: "no_eligible_capacity",
        earliestResetAt: null,
      });
      await expect(
        asTurn(setup.owner, () =>
          loadLegacySubscriptionPlacementWorld(
            client!.db,
            request(base, { ...xai, deadlineAt: Date.now() - 1 }),
          ),
        ),
      ).rejects.toBeInstanceOf(LegacyPlacementWorldDeadlineError);
    },
  );

  realTest("maps Claude per-model cooldowns from the usage table and waits for them", async () => {
    const setup = await fixture();
    const workspaceId = setup.grantWorkspaceId;
    const [credential] = await shared!.admin<{ id: string; version: number }[]>`
        insert into claude_subscription_credentials (account_id, workspace_id, credential_encrypted)
        values (${setup.accountId}, ${workspaceId}, 'v1:enc') returning id, version`;
    const cooldownUntil = new Date(Date.now() + 10 * 60_000);
    const snapshot = emptyClaudeUsage(credential!.version);
    await shared!.admin`
        insert into claude_subscription_account_usage
          (credential_id, account_id, credential_version, snapshot, model_cooldowns)
        values (${credential!.id}, ${setup.accountId}, ${credential!.version},
          ${shared!.admin.json(snapshot as never)},
          ${shared!.admin.json({ "claude-test-model": cooldownUntil.toISOString() })})`;
    const { sessionId, turnId } = await session(workspaceId, setup.accountId, setup.owner);
    const loaded = await asTurn(setup.owner, () =>
      loadLegacySubscriptionPlacementWorld(
        client!.db,
        request(
          { accountId: setup.accountId, workspaceId, sessionId, turnId },
          {
            provider: "claude",
            productModelId: "claude/test-model",
            upstreamModelId: "claude-test-model",
            authorityScope: "workspace",
            initiatingHumanSubjectId: setup.owner,
          },
        ),
      ),
    );
    if (loaded.status !== "loaded") throw new Error("expected a loaded world: " + loaded.reason);
    expect(loaded.input.connections).toHaveLength(1);
    expect(loaded.input.connections[0]!.quota?.modelCooldowns).toEqual({
      "claude/test-model": cooldownUntil.getTime(),
    });
    expect(loaded.input.cacheFacts.claude).toEqual({ kind: "exact_ttl", ttlMs: 300_000 });
    expect(decidePlacement(loaded.input)).toEqual({
      kind: "wait",
      reason: "no_eligible_capacity",
      earliestResetAt: cooldownUntil.getTime(),
    });
  });
});
