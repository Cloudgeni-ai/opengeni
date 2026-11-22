/**
 * M4 C2b: Claude on the shared core's writers, as the restricted application
 * role, with Claude registered and its cutover receipt recorded by the
 * migrations, so every new organization starts switched to the shared core.
 * Connect writes Claude's credential formats and the adapter-owned provider
 * state through the neutral writers; a personal connection exists only in the
 * person's own Personal workspace; a reconnect is fenced on the connection's
 * row version and keeps its Claude identity; acceptance writes the claude v2
 * entry next to Codex's for the exact owner only; and after the receipt no
 * acceptance computes Claude's v1 value from live state.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import type { ResolvedModelProvider } from "@opengeni/config";
import { AnthropicMessagesModel } from "../../runtime/src/anthropic-messages";
import { claudeCoreRefusal } from "../../../apps/worker/src/activities/agent-turn/claude-core";
import { recordCoreSubscriptionRefusal } from "../../../apps/worker/src/activities/agent-turn/subscription-core-settlement";
import * as realRegistry from "../src/subscription-core-providers";
import { failoverFixture } from "./helpers/subscription-core-failover-fixture";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

// Use the shipped provider registration; only the database cutover is staged.
const productionProviderIds = realRegistry.subscriptionCoreProviderIds();
const db = await import("../src");
const { rawRows } = await import("../src/database");
const { decryptEnvironmentValue } = await import("../src/environment-crypto");

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof db.createDb> | null = null;
const key = Buffer.alloc(32, 63);

type Org = {
  accountId: string;
  subjectId: string;
  membershipId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
};

async function organization(): Promise<Org> {
  const userId = `claude-acceptance-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await db.ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Claude acceptance fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships where account_id = ${accountId}::uuid
      and subject_id = ${subjectId} and status = 'active' and revoked_at is null limit 1`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Claude shared') returning id::text as id`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspace!.id}::uuid, ${subjectId}, 'owner')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${accountId}::uuid)`;
  await shared!.admin`
    update subscription_settings set personal_connections_allowed = true,
      personal_fallback_allowed = true
    where account_id = ${accountId}::uuid and workspace_id is null`;
  return {
    accountId,
    subjectId,
    membershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: workspace!.id,
  };
}

const oauthCredential = (accountUuid: string) => ({
  version: 1 as const,
  token: `sk-ant-oat01-${crypto.randomUUID()}`,
  identity: { accountUuid, deviceId: "d".repeat(64) },
  oauth: {
    refreshToken: `refresh-${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: ["user:inference", "user:profile"],
  },
});
const setupCredential = () => ({
  version: 1 as const,
  token: `sk-ant-oat01-${crypto.randomUUID()}`,
  identity: { accountUuid: "", deviceId: "d".repeat(64) },
});

function connectClaude(
  org: Org,
  input: {
    workspaceId: string | null;
    personal?: boolean;
    credential?: ReturnType<typeof oauthCredential> | ReturnType<typeof setupCredential>;
    providerAccountId?: string;
    reconnectTarget?: {
      connectionId: string;
      expectedVersion: number;
      providerAccountId: string | null;
    };
  },
) {
  const accountUuid = crypto.randomUUID();
  return db.connectSubscriptionCoreClaudeConnection(client!.db, {
    accountId: org.accountId,
    workspaceId: input.workspaceId,
    subjectId: org.subjectId,
    ...(input.personal ? { personal: true } : {}),
    encryptionKey: key,
    credential: input.credential ?? oauthCredential(accountUuid),
    providerAccountId: input.providerAccountId ?? accountUuid,
    accountEmail: "person@example.test",
    planType: "claude_max",
    label: "Claude",
    connectedBySubjectId: org.subjectId,
    ...(input.reconnectTarget ? { reconnectTarget: input.reconnectTarget } : {}),
  });
}

async function connection(id: string) {
  const [row] = await shared!.admin<
    {
      provider: string;
      ownership: string;
      credential_format: string;
      provider_state: unknown;
      provider_account_id: string;
      provider_subject_id: string;
      version: number;
      credential_encrypted: string;
    }[]
  >`select provider, ownership, credential_format, provider_state, provider_account_id,
      provider_subject_id, version, credential_encrypted
    from subscription_connections where id = ${id}::uuid`;
  return row!;
}

async function session(
  org: Org,
  workspaceId: string,
  visibility: "user_private" | "workspace_shared",
) {
  return await db.withSessionRlsActorContext({ subjectId: org.subjectId }, () =>
    db.createSession(client!.db, {
      accountId: org.accountId,
      workspaceId,
      initialMessage: "Claude acceptance fixture",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility,
      subjectId: org.subjectId,
      createdBy: { kind: "subject", subjectId: org.subjectId },
      createdByContext: {},
    }),
  );
}

async function accept(
  org: Org,
  workspaceId: string,
  sessionId: string,
  initiator: "owner" | "service",
) {
  const turn = await db.withSessionRlsActorContext(
    initiator === "owner"
      ? { subjectId: org.subjectId }
      : { subjectId: "service:claude-acceptance", initiatingHumanSubjectId: null },
    () =>
      db.enqueueSessionTurn(client!.db, {
        accountId: org.accountId,
        workspaceId,
        sessionId,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `session-${sessionId}`,
        source: "user",
        prompt: "Claude acceptance fixture",
        resources: [],
        tools: [],
        model: "scripted-model",
        reasoningEffort: "medium",
        sandboxBackend: "none",
        metadata: {},
        initiator:
          initiator === "owner"
            ? { kind: "subject", subjectId: org.subjectId }
            : { kind: "service", subjectId: "service:claude-acceptance" },
      }),
  );
  const [row] = await shared!.admin<{ v2: unknown; claude: unknown }[]>`
    select subscription_authority as v2, claude_provider_account_authority_snapshot as claude
    from session_turns where id = ${turn.id}::uuid`;
  return row!;
}

async function generation(org: Org, provider: string): Promise<number> {
  const [row] = await shared!.admin<{ generation: number }[]>`
    select max(connection.authority_generation)::int as generation
    from subscription_connections connection
    where connection.account_id = ${org.accountId}::uuid and connection.provider = ${provider}
      and connection.ownership = 'personal'`;
  return row!.generation;
}

let org: Org | null = null;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-claude-acceptance");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = db.createDb(shared.appUrl, { max: 4 });
  org = await organization();
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe.skipIf(!realDb)("Claude on the shared core's writers (M4 C2b)", () => {
  test("runs as the restricted application role with the shipped Claude registration", async () => {
    const [role] = await rawRows<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      client!.db,
      sql`select current_user as "currentUser", rolsuper as superuser,
          rolbypassrls as "bypassRls"
        from pg_catalog.pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });
    expect(productionProviderIds).toContain("claude");
    expect(realRegistry.subscriptionCoreProviderIds()).toContain("claude");
  });

  test("a Claude access change wakes from Claude's binding", () => {
    const accountId = crypto.randomUUID();
    expect(db.subscriptionCoreAccessChangeWake("claude_subscription", accountId)).toEqual({
      provider: "claude",
      displayName: "Claude",
      wake: { accountId, reason: "core_claude_access_changed" },
    });
  });

  test("a subscription HTTP 403 keeps the account out of rotation until reconnect", async () => {
    const provider = db.SUBSCRIPTION_CORE_CLAUDE;
    const model = {
      id: "organization-claude-subscription/claude-opus-4-6",
      upstreamModelId: "claude-opus-4-6",
      provider: "claude",
      reasoningLevels: ["high"],
    };
    const fixture = failoverFixture(shared!, [provider], [model]);
    try {
      const owner = await fixture.organization();
      const providerAccountId = crypto.randomUUID();
      const connect = (reconnectTarget?: {
        connectionId: string;
        expectedVersion: number;
        providerAccountId: string;
      }) =>
        connectClaude(
          { ...owner, sharedWorkspaceId: owner.workspaceId },
          {
            workspaceId: owner.workspaceId,
            providerAccountId,
            credential: oauthCredential(providerAccountId),
            ...(reconnectTarget ? { reconnectTarget } : {}),
          },
        );
      const first = await connect();
      if (first.kind !== "connected") throw new Error("Expected a workspace connection");
      const runtime = db.subscriptionCoreTurns(provider);
      const place = (work: Awaited<ReturnType<typeof fixture.turn>>) =>
        runtime.placeSubscriptionCoreTurn(fixture.client.db, work);
      const work = await fixture.turn(owner);
      const placed = await place(work);
      if (placed.kind !== "run") throw new Error("Expected initial placement");
      expect(placed.connectionId).toBe(first.id);
      const backup = await fixture.connection(owner, provider);
      expect(await fixture.binding(work, "claude")).toMatchObject({
        connection_id: first.id,
        choice: "automatic",
      });

      const transport: ResolvedModelProvider = {
        id: "organization-claude-subscription",
        label: "Claude subscription",
        kind: "claude-subscription-organization",
        api: "anthropic-messages",
        wireProfile: "openai",
        builtin: false,
        baseUrl: "https://example.test/v1",
        apiKey: "synthetic-bearer",
        credentialSource: { kind: "connected_subscription", provider: "claude" },
        billing: { upstreamPayer: "connected_subscription", metering: "external" },
        anthropic: {
          auth: "oauth",
          identity: { accountUuid: providerAccountId, deviceId: "d".repeat(64) },
          cacheTtl: "5m",
          maxOutputTokens: 32_000,
          streamIdleTimeoutMs: 1_000,
        },
      };
      const fetcher = Object.assign(
        async () =>
          Response.json(
            { error: { type: "permission_error", message: "private provider detail" } },
            { status: 403 },
          ),
        { preconnect: fetch.preconnect },
      );
      const upstream = new AnthropicMessagesModel(transport, model.upstreamModelId, fetcher);
      const error = await upstream
        .getResponse({
          input: "Test",
          modelSettings: {},
          tools: [],
          handoffs: [],
          outputType: "text",
          tracing: false,
        })
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: "anthropic_permission_denied", status: 403 });
      const binding = claudeCoreRefusal(model.id);
      const outcome = binding.classify(error);
      expect(outcome).toEqual({ kind: "forbidden" });
      if (!outcome) throw new Error("Expected an account refusal");
      // The same worker binding and fenced settlement used by the live turn.
      expect(
        await recordCoreSubscriptionRefusal({
          db: fixture.client.db,
          provider: binding.provider,
          core: {
            identity: work.identity,
            connectionId: placed.connectionId,
            personal: placed.personal,
            placedRefreshGeneration: placed.refreshGeneration,
          },
          lease: { holderId: work.holderId, generation: work.executionGeneration },
          outcome,
          credential: binding.credential,
        }),
      ).toEqual({ receipt: true, health: true });

      const listed = async () =>
        (
          await db.getSubscriptionCoreClaudeWorkspaceProjection(fixture.client.db, {
            accountId: owner.accountId,
            workspaceId: owner.workspaceId,
            viewerSubjectId: owner.subjectId,
          })
        ).accounts.find((account) => account.id === first.id);
      const quarantined = await listed();
      expect(quarantined).toMatchObject({
        status: "error",
        allocatorEnabled: true,
      });
      expect(quarantined?.lastError).toBe(
        "The provider denied model access for this account (HTTP 403). Check its permissions, then reconnect it.",
      );
      expect(
        await runtime.countSubscriptionCoreTurnRefusals(fixture.client.db, work.identity),
      ).toBe(1);

      const retry = await fixture.recover(work);
      expect(retry.identity.turnId).toBe(work.identity.turnId);
      expect(
        await runtime.recoverSubscriptionCoreConnectionHealth(fixture.client.db, retry.identity),
      ).toBe(0);
      expect(await place(retry)).toMatchObject({
        kind: "run",
        connectionId: backup,
        switch: "failover_same_provider",
      });
      await fixture.finish(retry);
      const fresh = await fixture.turn(owner);
      expect(await place(fresh)).toMatchObject({ kind: "run", connectionId: backup });
      await fixture.finish(fresh);
      expect(await listed()).toMatchObject({ status: "error" });

      expect(
        await connect({
          connectionId: first.id,
          expectedVersion: quarantined!.version,
          providerAccountId,
        }),
      ).toMatchObject({ kind: "connected", id: first.id, isNew: false });
      expect(await listed()).toMatchObject({
        status: "active",
        lastError: null,
        allocatorEnabled: true,
      });
    } finally {
      await fixture.client.close();
    }
  });

  test("OAuth and setup-token connections take Claude's formats and provider state", async () => {
    const accountUuid = crypto.randomUUID();
    const credential = oauthCredential(accountUuid);
    const oauth = await connectClaude(org!, {
      workspaceId: null,
      credential,
      providerAccountId: accountUuid,
    });
    if (oauth.kind !== "connected") throw new Error(`refused: ${oauth.reason}`);
    expect(oauth.version).toBeGreaterThan(0);
    const stored = await connection(oauth.id);
    expect(stored).toMatchObject({
      provider: "claude",
      ownership: "shared",
      credential_format: "claude_oauth_v1",
      provider_state: { oauthScopes: ["user:inference", "user:profile"] },
      provider_account_id: accountUuid,
      provider_subject_id: accountUuid,
      version: oauth.version,
    });
    // The stored plaintext is the legacy secret object unchanged.
    expect(JSON.parse(decryptEnvironmentValue(key, stored.credential_encrypted))).toEqual(
      credential,
    );

    const setupId = `setup:${"a".repeat(64)}`;
    const setup = await connectClaude(org!, {
      workspaceId: org!.sharedWorkspaceId,
      credential: setupCredential(),
      providerAccountId: setupId,
    });
    if (setup.kind !== "connected") throw new Error(`refused: ${setup.reason}`);
    expect(await connection(setup.id)).toMatchObject({
      ownership: "shared",
      credential_format: "claude_setup_token_v1",
      provider_state: { oauthScopes: [] },
      provider_account_id: setupId,
    });

    // The legacy listing shape, from the core rows.
    const projection = await db.getSubscriptionCoreClaudeOrganizationProjection(client!.db, {
      organizationId: org!.accountId,
      subjectId: org!.subjectId,
    });
    const listed = projection.accounts.find((account) => account.id === oauth.id)!;
    expect(listed).toMatchObject({
      scope: "organization",
      providerAccountId: accountUuid,
      accountEmail: "person@example.test",
      planType: "claude_max",
      label: "Claude",
      status: "active",
      version: oauth.version,
      allocatorEnabled: true,
      // C2a's projection: no reading yet; the OAuth scopes include the usage scope.
      usage: { connected: true, windows: [], refreshStatus: "not_checked" },
    });
    expect(JSON.stringify(projection)).not.toContain("sk-ant-");
  });

  test("a reconnect is fenced on the row version and keeps the Claude identity", async () => {
    const setupId = `setup:${"b".repeat(64)}`;
    const first = await connectClaude(org!, {
      workspaceId: null,
      credential: setupCredential(),
      providerAccountId: setupId,
    });
    if (first.kind !== "connected" || first.version === undefined) throw new Error("refused");
    const target = {
      connectionId: first.id,
      expectedVersion: first.version,
      providerAccountId: setupId,
    };
    // A new setup token computes another HMAC id; the reconnect keeps the target's.
    const replaced = await connectClaude(org!, {
      workspaceId: null,
      credential: setupCredential(),
      providerAccountId: `setup:${"c".repeat(64)}`,
      reconnectTarget: target,
    });
    expect(replaced).toMatchObject({ kind: "connected", id: first.id, isNew: false });
    if (replaced.kind !== "connected") throw new Error("refused");
    expect(replaced.version).toBe(first.version + 1);
    expect((await connection(first.id)).provider_account_id).toBe(setupId);
    // The same fence again is stale: nothing is written.
    const before = await connection(first.id);
    expect(
      await connectClaude(org!, {
        workspaceId: null,
        credential: setupCredential(),
        providerAccountId: `setup:${"d".repeat(64)}`,
        reconnectTarget: target,
      }),
    ).toEqual({ kind: "refused", reason: "changed" });
    expect(await connection(first.id)).toEqual(before);
    // A sign-in that proves an account never takes over an unproven target,
    // and a proven account reconnects only itself.
    expect(
      await connectClaude(org!, {
        workspaceId: null,
        reconnectTarget: { ...target, expectedVersion: replaced.version! },
      }),
    ).toEqual({ kind: "refused", reason: "sign_in_over_unverified" });
    const accountUuid = crypto.randomUUID();
    const proven = await connectClaude(org!, {
      workspaceId: null,
      credential: oauthCredential(accountUuid),
      providerAccountId: accountUuid,
    });
    if (proven.kind !== "connected") throw new Error("refused");
    const provenTarget = {
      connectionId: proven.id,
      expectedVersion: proven.version!,
      providerAccountId: accountUuid,
    };
    expect(await connectClaude(org!, { workspaceId: null, reconnectTarget: provenTarget })).toEqual(
      { kind: "refused", reason: "different_account" },
    );
    expect(
      await connectClaude(org!, {
        workspaceId: null,
        credential: setupCredential(),
        providerAccountId: `setup:${"e".repeat(64)}`,
        reconnectTarget: provenTarget,
      }),
    ).toEqual({ kind: "refused", reason: "setup_token_over_sign_in" });
    const again = await connectClaude(org!, {
      workspaceId: null,
      credential: oauthCredential(accountUuid),
      providerAccountId: accountUuid,
      reconnectTarget: provenTarget,
    });
    expect(again).toMatchObject({ kind: "connected", id: proven.id, version: proven.version! + 1 });
    // An earlier sign-in that recorded no account uuid is unverified too: a
    // proven sign-in gets the same add-again refusal as over a setup token.
    const unverifiedOauthId = `oauth:${"9".repeat(64)}`;
    const unverified = await connectClaude(org!, {
      workspaceId: null,
      credential: oauthCredential(""),
      providerAccountId: unverifiedOauthId,
    });
    if (unverified.kind !== "connected") throw new Error("refused");
    const unverifiedBefore = await connection(unverified.id);
    expect(
      await connectClaude(org!, {
        workspaceId: null,
        reconnectTarget: {
          connectionId: unverified.id,
          expectedVersion: unverified.version!,
          providerAccountId: unverifiedOauthId,
        },
      }),
    ).toEqual({ kind: "refused", reason: "sign_in_over_unverified" });
    expect(await connection(unverified.id)).toEqual(unverifiedBefore);
    // A reconnect never creates a connection: a gone target is `changed`.
    expect(
      await connectClaude(org!, {
        workspaceId: null,
        reconnectTarget: {
          connectionId: crypto.randomUUID(),
          expectedVersion: 1,
          providerAccountId: `setup:${"f".repeat(64)}`,
        },
        credential: setupCredential(),
        providerAccountId: `setup:${"0".repeat(64)}`,
      }),
    ).toEqual({ kind: "refused", reason: "changed" });
  });

  test("a personal connection exists only in the person's own Personal workspace", async () => {
    const accountUuid = crypto.randomUUID();
    const personal = await connectClaude(org!, {
      workspaceId: org!.personalWorkspaceId,
      personal: true,
      credential: oauthCredential(accountUuid),
      providerAccountId: accountUuid,
    });
    if (personal.kind !== "connected") throw new Error(`refused: ${personal.reason}`);
    expect(personal.ownership).toBe("personal");
    expect(await connection(personal.id)).toMatchObject({
      provider: "claude",
      ownership: "personal",
      credential_format: "claude_oauth_v1",
      provider_state: { oauthScopes: ["user:inference", "user:profile"] },
    });
    // Listed to its owner in the Personal workspace with its row version.
    const projection = await db.getSubscriptionCoreClaudeWorkspaceProjection(client!.db, {
      accountId: org!.accountId,
      workspaceId: org!.personalWorkspaceId,
      viewerSubjectId: org!.subjectId,
    });
    const listed = projection.accounts.find((account) => account.id === personal.id);
    expect(listed).toMatchObject({ scope: "user", version: personal.version });
    expect(projection.source).toBe("user");
    // A personal reconnect is fenced the same way.
    const target = {
      connectionId: personal.id,
      expectedVersion: personal.version!,
      providerAccountId: accountUuid,
    };
    const reconnected = await connectClaude(org!, {
      workspaceId: org!.personalWorkspaceId,
      personal: true,
      credential: oauthCredential(accountUuid),
      providerAccountId: accountUuid,
      reconnectTarget: target,
    });
    expect(reconnected).toMatchObject({
      kind: "connected",
      id: personal.id,
      version: personal.version! + 1,
    });
    expect(
      await connectClaude(org!, {
        workspaceId: org!.personalWorkspaceId,
        personal: true,
        credential: oauthCredential(accountUuid),
        providerAccountId: accountUuid,
        reconnectTarget: target,
      }),
    ).toEqual({ kind: "refused", reason: "changed" });
    expect((await connection(personal.id)).version).toBe(personal.version! + 1);
    // Never made from a shared workspace or the organization route.
    for (const workspaceId of [org!.sharedWorkspaceId, null]) {
      expect(await connectClaude(org!, { workspaceId, personal: true })).toEqual({
        kind: "refused",
        reason: "forbidden",
      });
    }
  });

  test("acceptance writes the claude entry next to Codex's, only for the exact owner", async () => {
    const codex = await db.withSessionRlsActorContext({ subjectId: org!.subjectId }, () =>
      db.connectSubscriptionCoreCodexConnection(client!.db, {
        accountId: org!.accountId,
        workspaceId: org!.personalWorkspaceId,
        subjectId: org!.subjectId,
        credentialEncrypted: db.encryptEnvironmentValue(
          key,
          JSON.stringify({ access_token: "a", refresh_token: "r", id_token: "i" }),
        ),
        providerAccountId: `chatgpt-${crypto.randomUUID()}`,
        providerSubjectId: "verified-fixture-person",
        planType: "pro",
        isFedramp: false,
        expiresAt: new Date(Date.now() + 86_400_000),
        lastRefreshAt: new Date(),
        accountEmail: null,
        label: "personal",
      }),
    );
    if (codex.kind !== "connected") throw new Error(`codex connect refused: ${codex.reason}`);
    const own = await session(org!, org!.personalWorkspaceId, "user_private");
    const owner = await accept(org!, org!.personalWorkspaceId, own.id, "owner");
    expect(owner.v2).toEqual({
      version: 2,
      personal: [
        {
          provider: "claude",
          ownerMembershipId: org!.membershipId,
          authorityGeneration: await generation(org!, "claude"),
        },
        {
          provider: "codex",
          ownerMembershipId: org!.membershipId,
          authorityGeneration: await generation(org!, "codex"),
        },
      ],
    });
    // After the receipt the v1 value is the column default, never live state.
    expect(owner.claude).toEqual({ version: 1, scope: "workspace" });
    // A shared session's turn, by its human or by a service, gains no
    // personal authority.
    const team = await session(org!, org!.sharedWorkspaceId, "workspace_shared");
    const sharedTurn = await accept(org!, org!.sharedWorkspaceId, team.id, "owner");
    expect(sharedTurn.v2).toEqual({ version: 2, personal: [] });
    expect(sharedTurn.claude).toEqual({ version: 1, scope: "workspace" });
    const service = await accept(org!, org!.sharedWorkspaceId, team.id, "service");
    expect(service.v2).toEqual({ version: 2, personal: [] });
  });

  test("a human prompt, its edit, a human scheduled task and an agent's child carry the claude entry", async () => {
    // Runs after the test above: the owner holds a personal Claude and a
    // personal Codex connection.
    const expected = {
      version: 2,
      personal: [
        {
          provider: "claude",
          ownerMembershipId: org!.membershipId,
          authorityGeneration: await generation(org!, "claude"),
        },
        {
          provider: "codex",
          ownerMembershipId: org!.membershipId,
          authorityGeneration: await generation(org!, "codex"),
        },
      ],
    };
    const workspaceId = org!.personalWorkspaceId;
    const turnAuthority = async (turnId: string) => {
      const [row] = await shared!.admin<{ v2: unknown; claude: unknown }[]>`
        select subscription_authority as v2, claude_provider_account_authority_snapshot as claude
        from session_turns where id = ${turnId}::uuid`;
      return row!;
    };
    const submit = (sessionId: string, text: string, expectedDraftRevision?: number) =>
      db.withWorkspaceSubjectSessionActivityRls(client!.db, workspaceId, org!.subjectId, (scoped) =>
        scoped.transaction((tx) =>
          db.submitHumanPromptInTransaction(tx as unknown as typeof scoped, {
            accountId: org!.accountId,
            workspaceId,
            sessionId,
            subjectId: org!.subjectId,
            actor: { type: "human", subjectId: org!.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text,
            resources: [],
            model: "scripted-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
            ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
          }),
        ),
      );

    // The human prompt writer (EP-S18..S24's submit path), twice queued.
    const own = await session(org!, workspaceId, "user_private");
    await submit(own.id, "first queued prompt");
    const queued = await submit(own.id, "second queued prompt");
    expect(await turnAuthority(queued.turnId)).toEqual({
      v2: expected,
      claude: { version: 1, scope: "workspace" },
    });

    // Its edit: the resubmitted prompt carries the withdrawn turn's authority.
    const [queuedRow] = await shared!.admin<{ version: number }[]>`
      select version from session_turns where id = ${queued.turnId}::uuid`;
    const checkedOut = await db.withWorkspaceSubjectSessionActivityRls(
      client!.db,
      workspaceId,
      org!.subjectId,
      (scoped) =>
        scoped.transaction((tx) =>
          db.editQueuedTurnInTransaction(tx as unknown as typeof scoped, {
            accountId: org!.accountId,
            workspaceId,
            sessionId: own.id,
            turnId: queued.turnId,
            subjectId: org!.subjectId,
            expectedTurnVersion: queuedRow!.version,
            expectedDraftRevision: 0,
            replaceDraft: false,
            actor: { type: "human", subjectId: org!.subjectId },
            operationKey: crypto.randomUUID(),
          }),
        ),
    );
    const resubmitted = await submit(own.id, checkedOut.draft.text, checkedOut.draft.revision);
    expect(resubmitted.turnId).not.toBe(queued.turnId);
    expect(await turnAuthority(resubmitted.turnId)).toEqual({
      v2: expected,
      claude: { version: 1, scope: "workspace" },
    });

    // A scheduled task the owner creates in their Personal workspace.
    const task = await db.withSessionRlsActorContext({ subjectId: org!.subjectId }, () =>
      db.createScheduledTask(client!.db, {
        accountId: org!.accountId,
        workspaceId,
        name: "Claude acceptance task",
        status: "active",
        schedule: { type: "manual" },
        temporalScheduleId: `claude-acceptance-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "Check the deployment", resources: [], tools: [], metadata: {} },
        metadata: {},
        createdBy: { kind: "subject", subjectId: org!.subjectId },
      } as never),
    );
    const [taskRow] = await shared!.admin<{ v2: unknown; claude: unknown }[]>`
      select subscription_authority as v2, claude_provider_account_authority_snapshot as claude
      from scheduled_tasks where id = ${task.id}::uuid`;
    expect(taskRow).toEqual({ v2: expected, claude: { version: 1, scope: "workspace" } });

    // An agent's child: the running turn's authority, verbatim, never widened.
    const attemptId = crypto.randomUUID();
    const claimed = await db.claimSessionWorkForAttempt(client!.db, workspaceId, {
      sessionId: own.id,
      workflowId: `session-${own.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`not claimed: ${claimed.reason}`);
    const running = await turnAuthority(claimed.turn.id);
    expect(running.v2).toEqual(expected);
    const child = await db.createSession(client!.db, {
      accountId: org!.accountId,
      workspaceId,
      initialMessage: "Claude acceptance child",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      // A private session's child is private to the same owner (0313).
      visibility: "user_private",
      subjectId: org!.subjectId,
      parentSessionId: own.id,
      createdByActor: {
        type: "agent_attempt",
        sessionId: own.id,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
      },
    } as never);
    await db.initializeSessionStartAtomically(client!.db, {
      accountId: org!.accountId,
      workspaceId,
      sessionId: child.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
    const [childTurn] = await shared!.admin<{ id: string }[]>`
      select id::text as id from session_turns where session_id = ${child.id}::uuid`;
    expect(await turnAuthority(childTurn!.id)).toEqual(running);
  });
});
