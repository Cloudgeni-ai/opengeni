import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  submitHumanPromptInTransaction,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src/index";

// Migration 0759: a pending machine update on an idle session blocks a
// privatization only when its frozen authority belongs to someone other than
// the session owner. The owner's own pending updates carry over untouched.
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0759-pending-update-tenancy");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture() {
  const userId = `pending-update-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const context = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Pending update owner",
  });
  const legacyWorkspaceId = context.defaultWorkspaceId!;
  const personal = context.workspaceGrants.find((grant) => grant.workspaceId !== legacyWorkspaceId);
  if (!personal?.workspaceId) throw new Error("managed human has no personal workspace");
  const accountId = personal.accountId;
  const workspaceId = personal.workspaceId;
  const privateSessions = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: subjectId,
  });
  if (!privateSessions.enabled) {
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: privateSessions.version,
      operationId: crypto.randomUUID(),
    });
  }
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  // One owner turn that a background command result can name as its cause.
  const accepted = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    workspaceId,
    subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId,
          workspaceId,
          sessionId: session.id,
          subjectId,
          actor: { type: "human", subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "Start a background command",
          resources: [],
          reasoningEffortFallback: "medium",
          source: "user",
        }),
      ),
  );
  // Reproduce an idle session whose turn finished long ago.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role=replica`;
    await tx`update session_turns set status = 'cancelled', finished_at = now()
      where id = ${accepted.turnId}`;
    await tx`update sessions set status = 'idle', active_turn_id = null where id = ${session.id}`;
  });
  const [owner] = await shared.admin<Array<{ membershipId: string }>>`
    select owner_organization_membership_id::text as "membershipId"
    from sessions where id = ${session.id}`;
  return {
    accountId,
    workspaceId,
    subjectId,
    sessionId: session.id,
    ownerTurnId: accepted.turnId,
    ownerMembershipId: owner!.membershipId,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

type PendingAuthority = {
  delegations?: unknown[];
  bindings?: unknown[] | null;
  subscriptionAuthority?: unknown;
  xai?: unknown;
  lineage?: Record<string, unknown>;
};

function delegation(ownerSubjectId: string) {
  const connectionId = crypto.randomUUID();
  return {
    kind: "oauth2",
    serverId: `account-${connectionId}`,
    connectionId,
    connectionType: "mcp",
    ownerSubjectId,
    providerDomain: "mcp.example.test",
    canonicalServerId: "example-mcp",
  };
}

async function insertPendingUpdate(f: Fixture, authority: PendingAuthority): Promise<string> {
  const id = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const payload = {
    type: "background_command_result",
    commandId,
    state: "exited",
    exitCode: 0,
    reason: "Completed",
    outputLocator: { eventType: "sandbox.command.output.delta", commandId },
  };
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role=replica`;
    await tx`insert into session_system_updates
      (id, account_id, workspace_id, session_id, kind, classification, source_id, dedupe_key,
       summary, payload, lineage, personal_connection_delegations, mcp_account_bindings,
       subscription_authority, xai_provider_account_authority_snapshot)
      values (${id}, ${f.accountId}, ${f.workspaceId}, ${f.sessionId},
        'background_command_result', 'success', ${commandId}, ${id}, 'Command completed',
        ${tx.json(payload)},
        ${tx.json((authority.lineage ?? { causalTurnId: f.ownerTurnId }) as never)},
        ${tx.json((authority.delegations ?? []) as never)},
        ${authority.bindings === undefined || authority.bindings === null ? null : tx.json(authority.bindings as never)},
        ${authority.subscriptionAuthority === undefined ? null : tx.json(authority.subscriptionAuthority as never)},
        ${tx.json((authority.xai ?? { version: 1, scope: "workspace" }) as never)})`;
  });
  return id;
}

async function settle(id: string): Promise<void> {
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role=replica`;
    await tx`update session_system_updates set state = 'cancelled' where id = ${id}`;
  });
}

function privatize(f: Fixture) {
  return transitionSessionVisibility(client.db, {
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    actorSubjectId: f.subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: `visibility-${crypto.randomUUID()}`,
  });
}

describe("tenancy quiescence and pending machine updates", () => {
  test("another person's frozen authority on a pending update still blocks privatization", async () => {
    const f = await fixture();
    const someoneElse = `user:someone-else-${crypto.randomUUID()}`;
    const foreign: Array<[string, PendingAuthority]> = [
      ["a delegation owned by someone else", { delegations: [delegation(someoneElse)] }],
      [
        "a subject-scoped account binding owned by someone else",
        {
          bindings: [
            { ...delegation(someoneElse), subjectScope: "subject", accountLabel: "Only me" },
          ],
        },
      ],
      [
        "personal subscription authority of another membership",
        {
          subscriptionAuthority: {
            version: 2,
            personal: [
              {
                provider: "codex",
                ownerMembershipId: crypto.randomUUID(),
                authorityGeneration: 1,
              },
            ],
          },
        },
      ],
      [
        "a causal connection subject that is someone else",
        {
          lineage: { causalTurnId: crypto.randomUUID(), connectionAuthoritySubjectId: someoneElse },
        },
      ],
      [
        "a user-scoped provider snapshot without its causal subject",
        { xai: { version: 1, scope: "user", authorityGeneration: 1 } },
      ],
      ["a causal turn that cannot be read", { lineage: { causalTurnId: crypto.randomUUID() } }],
      ["a malformed causal turn id", { lineage: { causalTurnId: "not-a-turn" } }],
    ];
    for (const [label, authority] of foreign) {
      const id = await insertPendingUpdate(f, authority);
      await expect(privatize(f), label).rejects.toMatchObject({
        name: "SessionTenancyConflictError",
        reason: "not_quiescent",
        blocker: "pending_system_update",
      });
      await settle(id);
    }
  });

  test("the owner's own pending updates no longer block and stay pending across privatization", async () => {
    const f = await fixture();
    const ownerOnly = [
      await insertPendingUpdate(f, {}),
      await insertPendingUpdate(f, {
        delegations: [delegation(f.subjectId)],
        bindings: [
          { ...delegation(f.subjectId), subjectScope: "subject", accountLabel: "Only me" },
          { ...delegation(f.subjectId), ownerSubjectId: null, subjectScope: "workspace" },
        ],
        subscriptionAuthority: {
          version: 2,
          personal: [
            { provider: "codex", ownerMembershipId: f.ownerMembershipId, authorityGeneration: 1 },
          ],
        },
        xai: { version: 1, scope: "user", authorityGeneration: 1 },
        lineage: {
          causalTurnId: f.ownerTurnId,
          connectionAuthoritySubjectId: f.subjectId,
          xaiAuthoritySubjectId: f.subjectId,
        },
      }),
      // Machine input with no causal turn (for example a scheduled notice).
      await insertPendingUpdate(f, { lineage: {} }),
    ];
    const result = await privatize(f);
    expect(result).toMatchObject({ visibility: "user_private", changed: true });
    const rows = await shared.admin<Array<{ id: string; state: string }>>`
      select id, state from session_system_updates where session_id = ${f.sessionId}`;
    expect(new Map(rows.map((row) => [row.id, row.state]))).toEqual(
      new Map(ownerOnly.map((id) => [id, "pending"])),
    );
  });
});
