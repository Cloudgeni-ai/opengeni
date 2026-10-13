/**
 * M4 C2b: Claude on the shared core's writers, as the restricted application
 * role, once Claude is registered and its cutover receipt and switch row
 * exist (C3 ships both; this process and database stand in for them).
 * Connect writes Claude's credential formats and the adapter-owned provider
 * state through the neutral writers; a personal connection exists only in the
 * person's own Personal workspace; a reconnect is fenced on the connection's
 * row version and keeps its Claude identity; acceptance writes the claude v2
 * entry next to Codex's for the exact owner only; and after the receipt no
 * acceptance computes Claude's v1 value from live state.
 *
 * Run this file in its own process: the registration below replaces module
 * bindings for the whole process (the CI shard classifier isolates files that
 * call mock.module).
 */
import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import * as realRegistry from "../src/subscription-core-providers";
import type { SubscriptionCoreProvider } from "../src/subscription-core/provider";
import { SUBSCRIPTION_CORE_CLAUDE } from "../src/subscription-core-claude-adapter";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

// What production registers, read before the test registration.
const productionProviderIds = realRegistry.subscriptionCoreProviderIds();
const realProvider = realRegistry.subscriptionCoreProvider;
const lookup = (providerId: string): SubscriptionCoreProvider =>
  providerId === "claude"
    ? (SUBSCRIPTION_CORE_CLAUDE as SubscriptionCoreProvider)
    : realProvider(providerId);
mock.module(Bun.resolveSync("../src/subscription-core-providers", import.meta.dir), () => ({
  ...realRegistry,
  subscriptionCoreProviderIds: () => [...new Set([...productionProviderIds, "claude"])].sort(),
  subscriptionCoreProvider: lookup,
  subscriptionCoreAdapter: (providerId: string) => lookup(providerId).adapter,
}));
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

/** Legacy Claude state that makes the legacy shared pool `organization`. */
async function legacyOrganizationPool(org: Org) {
  await shared!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into claude_rotation_settings (account_id, workspace_id, authority_scope,
        active_credential_id)
      values (${org.accountId}::uuid, null, 'organization', gen_random_uuid())`;
  });
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
/** The owner's acceptance before the receipt, with the legacy organization pool. */
let beforeReceipt: { v2: unknown; claude: unknown } | null = null;

beforeAll(async () => {
  if (!realDb) return;
  // A world before Claude's drained cutover: this test registers Claude itself.
  shared = await acquireSharedTestDatabase("subscription-core-claude-acceptance", {
    withheldMigrations: [
      "0748_subscription_core_claude_cutover.sql",
      "0751_subscription_core_legacy_retirement.sql",
    ],
  });
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = db.createDb(shared.appUrl, { max: 4 });
  org = await organization();
  await legacyOrganizationPool(org);
  const own = await session(org, org.personalWorkspaceId, "user_private");
  beforeReceipt = await accept(org, org.personalWorkspaceId, own.id, "owner");
  // C3's registration: the registry row and the drained cutover's receipt.
  await shared.admin`
    insert into opengeni_private.subscription_core_providers (provider, extra_credits,
      primary_setting_column)
    values ('claude', false, 'claude_primary_connection_id')`;
  await shared.admin`
    insert into opengeni_private.subscription_provider_cutover_receipts (
      provider, migration, committed_at, seed_rotation
    ) values ('claude', '0899_subscription_core_claude_cutover.sql', clock_timestamp(),
      '{"mode":"spread"}')`;
  await shared.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${org.accountId}::uuid, 'claude', true)`;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe.skipIf(!realDb)("Claude on the shared core's writers (M4 C2b)", () => {
  test("runs as the restricted application role; production registers Claude", async () => {
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

  test("even before the receipt, acceptance writes claude's v1 default, never live state", () => {
    // The legacy runtime that derived it from the live organization pool is
    // retired (0751); the carrier keeps only its column default.
    expect(beforeReceipt!.claude).toEqual({ version: 1, scope: "workspace" });
  });

  test("a Claude access change wakes from Claude's binding", () => {
    const accountId = crypto.randomUUID();
    expect(db.subscriptionCoreAccessChangeWake("claude_subscription", accountId)).toEqual({
      provider: "claude",
      displayName: "Claude",
      wake: { accountId, reason: "core_claude_access_changed" },
    });
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
