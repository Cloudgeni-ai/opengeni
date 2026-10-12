/**
 * M4 X2b: SuperGrok (`xai`) on the shared core's writers, as the restricted
 * application role, once SuperGrok is registered and its cutover receipt and
 * switch row exist (X3 ships both; this process and database stand in for
 * them). Connect writes SuperGrok's credential format through the neutral
 * writers; a personal connection exists only in the person's own Personal
 * workspace; acceptance writes the xai v2 entry next to Codex's for the
 * exact owner only; and after the receipt no acceptance computes xai's v1
 * value from live state.
 *
 * Uses the registered production binding, with the receipt withheld until
 * the before/after acceptance fixture has recorded its legacy source.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import * as realRegistry from "../src/subscription-core-providers";
import { SUBSCRIPTION_CORE_XAI } from "../src/subscription-core-xai-adapter";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const db = await import("../src");
const { encryptEnvironmentValue } = await import("../src/environment-crypto");
const { rawRows, setSubjectRlsContext, withRlsContext } = await import("../src/database");
const { connectSubscriptionCoreConnection } = await import("../src/subscription-core/connections");

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof db.createDb> | null = null;
const key = Buffer.alloc(32, 61);

type Org = {
  accountId: string;
  subjectId: string;
  membershipId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
};

async function organization(): Promise<Org> {
  const userId = `xai-acceptance-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await db.ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "SuperGrok acceptance fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships where account_id = ${accountId}::uuid
      and subject_id = ${subjectId} and status = 'active' and revoked_at is null limit 1`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'SuperGrok shared') returning id::text as id`;
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

/** The SuperGrok switch row, as X3 writes it after the receipt. */
async function enableXai(org: Org) {
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${org.accountId}::uuid, 'xai', true)
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

/** Legacy SuperGrok state that makes the legacy shared pool `organization`. */
async function legacyOrganizationPool(org: Org) {
  await shared!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into xai_rotation_settings (account_id, workspace_id, authority_scope,
        active_credential_id)
      values (${org.accountId}::uuid, null, 'organization', gen_random_uuid())`;
  });
}

function connectXai(
  org: Org,
  input: { workspaceId: string | null; personal?: boolean; subject?: string },
) {
  return db.connectSubscriptionCoreXaiConnection(client!.db, {
    accountId: org.accountId,
    workspaceId: input.workspaceId,
    subjectId: org.subjectId,
    ...(input.personal ? { personal: true } : {}),
    encryptionKey: key,
    tokens: { accessToken: "xai-access", refreshToken: "xai-refresh" },
    identitySubject: input.subject ?? `xai-person-${crypto.randomUUID()}`,
    accountEmail: null,
    label: "SuperGrok",
    expiresAt: new Date(Date.now() + 86_400_000),
    connectedBySubjectId: org.subjectId,
  });
}

async function connection(id: string) {
  const [row] = await shared!.admin<
    { provider: string; ownership: string; credential_format: string; scope_kind: string }[]
  >`select provider, ownership, credential_format, scope_kind
    from subscription_connections where id = ${id}::uuid`;
  return row;
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
      initialMessage: "SuperGrok acceptance fixture",
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
      : { subjectId: "service:xai-acceptance", initiatingHumanSubjectId: null },
    () =>
      db.enqueueSessionTurn(client!.db, {
        accountId: org.accountId,
        workspaceId,
        sessionId,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `session-${sessionId}`,
        source: "user",
        prompt: "SuperGrok acceptance fixture",
        resources: [],
        tools: [],
        model: "scripted-model",
        reasoningEffort: "medium",
        sandboxBackend: "none",
        metadata: {},
        initiator:
          initiator === "owner"
            ? { kind: "subject", subjectId: org.subjectId }
            : { kind: "service", subjectId: "service:xai-acceptance" },
      }),
  );
  const [row] = await shared!.admin<{ v2: unknown; xai: unknown }[]>`
    select subscription_authority as v2, xai_provider_account_authority_snapshot as xai
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
/** The owner's acceptance before the receipt, next to a live legacy organization pool. */
let beforeReceipt: { v2: unknown; xai: unknown } | null = null;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-xai-acceptance", {
    withheldMigrations: ["0739_subscription_core_xai_cutover.sql"],
  });
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = db.createDb(shared.appUrl, { max: 4 });
  org = await organization();
  await legacyOrganizationPool(org);
  const own = await session(org, org.personalWorkspaceId, "user_private");
  beforeReceipt = await accept(org, org.personalWorkspaceId, own.id, "owner");
  // X3's registration: the registry row and the drained cutover's receipt.
  await shared.admin`
    insert into opengeni_private.subscription_core_providers (provider, extra_credits,
      primary_setting_column)
    values ('xai', false, 'xai_primary_connection_id')`;
  await shared.admin`
    insert into opengeni_private.subscription_provider_cutover_receipts (
      provider, migration, committed_at, seed_rotation
    ) values ('xai', '0799_subscription_core_xai_cutover.sql', clock_timestamp(),
      '{"mode":"spread"}')`;
  await enableXai(org);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe.skipIf(!realDb)("SuperGrok on the shared core's writers (M4 X2b)", () => {
  test("runs as the non-superuser, non-bypass application role", async () => {
    const [role] = await rawRows<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      client!.db,
      sql`select current_user as "currentUser", rolsuper as superuser,
          rolbypassrls as "bypassRls"
        from pg_catalog.pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });
  });

  test("production registers Codex and SuperGrok", () => {
    expect(realRegistry.subscriptionCoreProviderIds()).toEqual(["codex", "xai"]);
  });

  test("even before the receipt, acceptance writes xai's v1 default, never live state", () => {
    // The legacy runtime that derived it from the live organization pool is
    // deleted (M4 X4); the carrier keeps only its column default.
    expect(beforeReceipt!.xai).toEqual({ version: 1, scope: "workspace" });
  });

  test("a personal connection exists only in the person's own Personal workspace", async () => {
    const personal = await connectXai(org!, {
      workspaceId: org!.personalWorkspaceId,
      personal: true,
    });
    if (personal.kind !== "connected") throw new Error(`refused: ${personal.reason}`);
    expect(personal.ownership).toBe("personal");
    expect(await connection(personal.id)).toEqual({
      provider: "xai",
      ownership: "personal",
      credential_format: "xai_oauth_v1",
      scope_kind: "people",
    });
    // Never turned into a shared connection elsewhere.
    expect(await connectXai(org!, { workspaceId: org!.sharedWorkspaceId, personal: true })).toEqual(
      {
        kind: "refused",
        reason: "forbidden",
      },
    );
    expect(await connectXai(org!, { workspaceId: null, personal: true })).toEqual({
      kind: "refused",
      reason: "forbidden",
    });
  });

  test("shared connections take SuperGrok's format; a malformed format is refused", async () => {
    const organizationWide = await connectXai(org!, { workspaceId: null });
    if (organizationWide.kind !== "connected") throw new Error("organization connect refused");
    expect(await connection(organizationWide.id)).toMatchObject({
      provider: "xai",
      ownership: "shared",
      credential_format: "xai_oauth_v1",
    });
    const workspaceWide = await connectXai(org!, { workspaceId: org!.sharedWorkspaceId });
    if (workspaceWide.kind !== "connected") throw new Error("workspace connect refused");
    expect((await connection(workspaceWide.id))!.credential_format).toBe("xai_oauth_v1");
    // A format that is not an adapter's format name is a caller defect on
    // every path: refused before any write, never reported as a maintenance
    // pause or an ordinary refusal.
    const malformedInput = {
      accountId: org!.accountId,
      subjectId: org!.subjectId,
      credentialEncrypted: "v1:fixture",
      credentialFormat: "Not A Format",
      providerAccountId: `xai-person-${crypto.randomUUID()}`,
      providerSubjectId: "xai-person",
      planType: null,
      providerState: {},
      expiresAt: null,
      lastRefreshAt: new Date(),
      accountEmail: null,
      label: null,
      connectedBySubjectId: org!.subjectId,
    };
    for (const workspaceId of [org!.personalWorkspaceId, org!.sharedWorkspaceId, null]) {
      await expect(
        connectSubscriptionCoreConnection(client!.db, SUBSCRIPTION_CORE_XAI, {
          ...malformedInput,
          workspaceId,
        }),
      ).rejects.toThrow("subscription core credential format is malformed");
    }
    // The 0728 writer keeps its own check for a direct call.
    const direct = await db.withSessionRlsActorContext({ subjectId: org!.subjectId }, () =>
      withRlsContext(
        client!.db,
        { accountId: org!.accountId, workspaceId: org!.personalWorkspaceId },
        async (tx) => {
          await setSubjectRlsContext(tx, org!.subjectId);
          return await rawRows<{ outcome: string; connection_id: string | null }>(
            tx,
            sql`select outcome, connection_id::text as connection_id
              from opengeni_private.connect_subscription_core_personal('xai',
                ${org!.accountId}::uuid, ${org!.personalWorkspaceId}::uuid, ${org!.subjectId},
                'v1:fixture', ${malformedInput.providerAccountId}, 'xai-person', null,
                '{}'::jsonb, null, now(), null, null, ${org!.subjectId}, 'Not A Format')`,
          );
        },
      ),
    );
    expect(direct).toHaveLength(1);
    expect(direct[0]!.outcome).not.toBe("connected");
    expect(direct[0]!.connection_id).toBeNull();
  });

  test("an access change wakes from the provider's binding, with the earlier texts", () => {
    const accountId = crypto.randomUUID();
    expect(db.subscriptionCoreAccessChangeWake("codex", accountId)).toEqual({
      provider: "codex",
      displayName: "Codex",
      wake: { accountId, reason: "core_codex_access_changed" },
    });
    expect(db.subscriptionCoreAccessChangeWake("supergrok", accountId)).toEqual({
      provider: "xai",
      displayName: "SuperGrok",
      wake: { accountId, reason: "core_xai_access_changed" },
    });
    expect(db.subscriptionCoreAccessChangeWake("openrouter", accountId)).toBeNull();
  });

  test("Codex personal connections still store `v1` through the 0707 writer", async () => {
    const codex = await db.withSessionRlsActorContext({ subjectId: org!.subjectId }, () =>
      db.connectSubscriptionCoreCodexConnection(client!.db, {
        accountId: org!.accountId,
        workspaceId: org!.personalWorkspaceId,
        subjectId: org!.subjectId,
        credentialEncrypted: encryptEnvironmentValue(
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
    expect(await connection(codex.id)).toMatchObject({
      provider: "codex",
      credential_format: "v1",
    });
  });

  test("acceptance writes the xai entry next to Codex's, only for the exact owner", async () => {
    const own = await session(org!, org!.personalWorkspaceId, "user_private");
    const owner = await accept(org!, org!.personalWorkspaceId, own.id, "owner");
    expect(owner.v2).toEqual({
      version: 2,
      personal: [
        {
          provider: "codex",
          ownerMembershipId: org!.membershipId,
          authorityGeneration: await generation(org!, "codex"),
        },
        {
          provider: "xai",
          ownerMembershipId: org!.membershipId,
          authorityGeneration: await generation(org!, "xai"),
        },
      ],
    });
    // After the receipt the v1 value is the column default, never live state.
    expect(owner.xai).toEqual({ version: 1, scope: "workspace" });
    // A shared session's turn, by its human or by a service, gains no
    // personal authority.
    const team = await session(org!, org!.sharedWorkspaceId, "workspace_shared");
    const sharedTurn = await accept(org!, org!.sharedWorkspaceId, team.id, "owner");
    expect(sharedTurn.v2).toEqual({ version: 2, personal: [] });
    expect(sharedTurn.xai).toEqual({ version: 1, scope: "workspace" });
    const service = await accept(org!, org!.sharedWorkspaceId, team.id, "service");
    expect(service.v2).toEqual({ version: 2, personal: [] });
  });
});
