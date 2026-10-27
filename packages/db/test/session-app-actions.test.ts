import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

import {
  beginConnectorActionExecution,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  ensureExternalIdentity,
  getOrganizationAgentAdminAccess,
  grantSessionAdminAccess,
  listConfirmedAppActionChanges,
  prepareConnectorActionApproval,
  recordTurnAppActionGrant,
  resolveSessionAppActionAuthority,
  sessionStartedByPerson,
  setOrganizationAgentAdminAccess,
  submitHumanPromptInTransaction,
  turnCanChangeWorkspaceSettings,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
  type Database,
  type TurnAppActionGrant,
} from "../src";

// App actions in a chat: a person-started session acts as the person who sent
// the turn's message, and each change runs only once that same person confirmed
// it in the chat. Unattended turns, child and service sessions gain nothing.
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

setDefaultTimeout(120_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-app-actions");
  if (!shared && requireRealDatabase) throw new Error("PostgreSQL test database unavailable");
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function organization(label: string) {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${label}) returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Shared') returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const people = {
    owner: `user:${crypto.randomUUID()}`,
    member: `user:${crypto.randomUUID()}`,
  };
  for (const [role, subjectId] of Object.entries(people)) {
    const [personal] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
    await shared!.admin`
      insert into organization_memberships
        (account_id, subject_id, role, status, personal_workspace_id)
      values (${account!.id}, ${subjectId}, ${role}, 'active', ${personal!.id})`;
  }
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${account!.id}, ${workspace!.id}, ${people.member}),
      (${account!.id}, ${workspace!.id}, ${people.owner})`;
  return { accountId: account!.id, workspaceId: workspace!.id, ...people };
}

type Org = Awaited<ReturnType<typeof organization>>;

const SENT_PERMISSIONS = ["workspace:read", "sessions:read"] as const;

/**
 * A session with one claimed turn whose message `sender` sent. `frozen` is what
 * the API froze when it accepted the message (signed in to the app by default;
 * null for an API key or service that gets none).
 */
async function claimedTurn(
  org: Org,
  input: {
    createdBy: { kind: "subject" | "service"; subjectId: string };
    sender: string;
    parentSessionId?: string;
    frozen?: TurnAppActionGrant | null;
  },
) {
  const frozen =
    input.frozen === undefined
      ? { subjectId: input.sender, changes: "confirm" as const, permissions: SENT_PERMISSIONS }
      : input.frozen;
  const db = client!.db;
  const session = await createSession(db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    initialMessage: "app actions fixture",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: input.createdBy,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
  });
  await withWorkspaceSubjectSessionActivityRls(db, org.workspaceId, input.sender, (scoped) =>
    scoped.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof scoped, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId: session.id,
        subjectId: input.sender,
        actor: { type: "human", subjectId: input.sender },
        operationKey: `send-${crypto.randomUUID()}`,
        delivery: "send",
        text: "invite my daughter",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
        ...(frozen
          ? {
              captureTurnAuthority: async (captureTx: Database, turnId: string) =>
                await recordTurnAppActionGrant(captureTx, {
                  accountId: org.accountId,
                  workspaceId: org.workspaceId,
                  turnId,
                  grant: frozen,
                }),
            }
          : {}),
      }),
    ),
  );
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, org.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`claim failed: ${claim.reason}`);
  return {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
    initiator: claim.turn.initiator,
  };
}

const changeArgs = {
  actionId: "createOrganizationInvitation",
  input: { email: "anna@example.com", role: "member" },
};

/** One admin_action_call change through the ledger, as the worker sends it. */
function appActionCall(approvalId: string, args: unknown = changeArgs) {
  return {
    approvalId,
    connectionId: `session-mcp:opengeni:${"0".repeat(64)}`,
    serverId: "opengeni",
    toolName: "admin_action_call",
    arguments: args,
    approvalMode: "session_mcp" as const,
    defaultDecision: "ask" as const,
    reviewContext: { kind: "generic" as const, title: "Invite anna@example.com?" },
  };
}

async function decide(
  identity: { workspaceId: string; sessionId: string; turnId: string },
  approvalId: string,
  subjectId: string,
  /** How the Allow arrived: the app's own sign-in, or a key/integration/embed with that identity. */
  via: { kind: "human" | "api"; signedIn: boolean } = { kind: "human", signedIn: true },
) {
  const [event] = await shared!.admin<{ id: string }[]>`
    select id from session_events where session_id = ${identity.sessionId}
    order by sequence desc limit 1`;
  await shared!.admin`
    update connector_action_requests
    set status = 'approved', decision = 'approve', decision_by_subject_id = ${subjectId},
      decision_by_kind = ${via.kind}, decision_by_signed_in_person = ${via.signedIn},
      decision_event_id = ${event!.id}, decided_at = now(), updated_at = now()
    where workspace_id = ${identity.workspaceId} and turn_id = ${identity.turnId}
      and approval_id = ${approvalId}`;
}

describe("app actions in a chat", () => {
  test("are on by default, and the organization's switch is separate from full access", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("app-actions-default");
    expect(await getOrganizationAgentAdminAccess(db, org.accountId)).toMatchObject({
      sessionAdminAccessAllowed: false,
      chatActionsAllowed: true,
    });
    await setOrganizationAgentAdminAccess(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      chatActionsAllowed: false,
    });
    expect(await getOrganizationAgentAdminAccess(db, org.accountId)).toMatchObject({
      sessionAdminAccessAllowed: false,
      chatActionsAllowed: false,
    });
    await setOrganizationAgentAdminAccess(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      sessionAdminAccessAllowed: true,
    });
    expect(await getOrganizationAgentAdminAccess(db, org.accountId)).toMatchObject({
      sessionAdminAccessAllowed: true,
      chatActionsAllowed: false,
    });
  });

  test("act as the person who sent the message, and only while a person is there", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("app-actions-authority");
    const turn = await claimedTurn(org, {
      createdBy: { kind: "subject", subjectId: org.member },
      sender: org.member,
    });
    const key = {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
    };
    expect(await sessionStartedByPerson(db, key)).toBe(true);
    expect(await resolveSessionAppActionAuthority(db, key)).toEqual({
      kind: "confirm",
      subjectId: org.member,
      permissions: [...SENT_PERMISSIONS],
    });

    // A scheduled or other unattended turn in the same chat has nobody to ask.
    await shared!.admin`update session_turns set source = 'schedule' where id = ${turn.turnId}`;
    expect(await resolveSessionAppActionAuthority(db, key)).toEqual({
      kind: "unavailable",
      reason: "no_person_present",
    });
    await shared!.admin`update session_turns set source = 'user' where id = ${turn.turnId}`;

    // Someone who no longer belongs to the workspace acts as nobody.
    await shared!.admin`
      delete from workspace_memberships
      where workspace_id = ${org.workspaceId} and subject_id = ${org.member}`;
    expect(await resolveSessionAppActionAuthority(db, key)).toEqual({
      kind: "unavailable",
      reason: "not_member",
    });
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${org.accountId}, ${org.workspaceId}, ${org.member})`;

    // The organization's switch turns the route off; the chat's tools stay listed.
    await setOrganizationAgentAdminAccess(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      chatActionsAllowed: false,
    });
    expect(await resolveSessionAppActionAuthority(db, key)).toEqual({
      kind: "unavailable",
      reason: "organization_off",
    });
    expect(await sessionStartedByPerson(db, key)).toBe(true);

    // Full access, where the organization allows it, is unchanged: no confirmation.
    await setOrganizationAgentAdminAccess(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      sessionAdminAccessAllowed: true,
    });
    await grantSessionAdminAccess(db, {
      organizationId: org.accountId,
      workspaceId: org.workspaceId,
      sessionId: turn.sessionId,
      actorSubjectId: org.member,
      durationHours: null,
    });
    expect(await resolveSessionAppActionAuthority(db, key)).toEqual({
      kind: "full_access",
      subjectId: org.member,
    });
  });

  test("what the message could do is frozen with its turn: where it came from and its access", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("app-actions-frozen");
    const keyOf = (turn: Awaited<ReturnType<typeof claimedTurn>>) => ({
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
    });
    // An embed or other integration can only read, at most with its own token's access.
    const embedded = await claimedTurn(org, {
      createdBy: { kind: "subject", subjectId: org.owner },
      sender: org.owner,
      frozen: { subjectId: org.owner, changes: "none", permissions: ["workspace:read"] },
    });
    expect(await resolveSessionAppActionAuthority(db, keyOf(embedded))).toEqual({
      kind: "read_only",
      subjectId: org.owner,
      permissions: ["workspace:read"],
    });
    // A message with nothing frozen (an API key, a service, or one accepted
    // before this existed) acts as nobody.
    const unsigned = await claimedTurn(org, {
      createdBy: { kind: "subject", subjectId: org.owner },
      sender: org.owner,
      frozen: null,
    });
    expect(await resolveSessionAppActionAuthority(db, keyOf(unsigned))).toEqual({
      kind: "unavailable",
      reason: "not_signed_in_person",
    });
    // A frozen grant for someone other than the turn's sender is never used.
    const mismatched = await claimedTurn(org, {
      createdBy: { kind: "subject", subjectId: org.owner },
      sender: org.member,
      frozen: { subjectId: org.owner, changes: "confirm", permissions: ["workspace:read"] },
    });
    expect(await resolveSessionAppActionAuthority(db, keyOf(mismatched))).toEqual({
      kind: "unavailable",
      reason: "not_signed_in_person",
    });
    // Written once: a second record for the same turn changes nothing.
    await withWorkspaceSubjectSessionActivityRls(db, org.workspaceId, org.owner, (scoped) =>
      recordTurnAppActionGrant(scoped, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        turnId: embedded.turnId,
        grant: { subjectId: org.owner, changes: "confirm", permissions: ["workspace:admin"] },
      }),
    );
    expect(await resolveSessionAppActionAuthority(db, keyOf(embedded))).toMatchObject({
      kind: "read_only",
      permissions: ["workspace:read"],
    });
  });

  test("child and service sessions gain nothing", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("app-actions-unattended");
    const parent = await claimedTurn(org, {
      createdBy: { kind: "subject", subjectId: org.owner },
      sender: org.owner,
    });
    // Even with workspace settings recorded (a Personal workspace owner's chat).
    const settings = {
      subjectId: org.owner,
      changes: "confirm" as const,
      permissions: [...SENT_PERMISSIONS, "workspace:admin" as const],
    };
    const child = await claimedTurn(org, {
      createdBy: { kind: "subject", subjectId: org.owner },
      sender: org.owner,
      parentSessionId: parent.sessionId,
      frozen: settings,
    });
    const service = await claimedTurn(org, {
      createdBy: { kind: "service", subjectId: org.owner },
      sender: org.owner,
      frozen: settings,
    });
    for (const turn of [child, service]) {
      const key = {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
      };
      expect(await sessionStartedByPerson(db, key)).toBe(false);
      expect(await resolveSessionAppActionAuthority(db, key)).toEqual({
        kind: "unavailable",
        reason: "not_person_session",
      });
    }
  });

  test("a change runs only with that person's confirmation, for this attempt, while it runs", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("app-actions-confirmation");
    const turn = await claimedTurn(org, {
      createdBy: { kind: "subject", subjectId: org.member },
      sender: org.member,
    });
    const confirmed = () =>
      listConfirmedAppActionChanges(db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        attemptId: turn.attemptId,
        subjectId: org.member,
        toolName: "admin_action_call",
      });

    // Asking writes a pending card; nothing is confirmed yet.
    const asked = appActionCall("call-invite");
    expect(await prepareConnectorActionApproval(db, turn, asked)).toMatchObject({
      managed: true,
      decision: "ask",
      approvalStatus: "pending",
    });
    expect(await confirmed()).toEqual([]);
    expect(await beginConnectorActionExecution(db, turn, asked)).toMatchObject({
      allowed: false,
    });
    expect(await confirmed()).toEqual([]);

    // Someone else's approval does not count as this person's confirmation.
    const other = appActionCall("call-other", { ...changeArgs, input: { email: "x@example.com" } });
    await prepareConnectorActionApproval(db, turn, other);
    await decide(turn, "call-other", org.owner);
    expect(await beginConnectorActionExecution(db, turn, other)).toMatchObject({
      allowed: true,
      managed: true,
    });
    expect(await confirmed()).toEqual([]);

    // The person's own identity, but the Allow came through a personal API key
    // or through an embed token mapped onto them: neither counts.
    for (const [approvalId, via] of [
      ["call-by-key", { kind: "api", signedIn: false }],
      ["call-by-embed", { kind: "human", signedIn: false }],
    ] as const) {
      const viaCall = appActionCall(approvalId, {
        ...changeArgs,
        input: { email: `${approvalId}@example.com` },
      });
      await prepareConnectorActionApproval(db, turn, viaCall);
      await decide(turn, approvalId, org.member, via);
      expect(await beginConnectorActionExecution(db, turn, viaCall)).toMatchObject({
        allowed: true,
      });
      expect(await confirmed()).toEqual([]);
      // How the decision was made is fixed with it: it can't be upgraded later.
      await expect(
        shared!.admin`
          update connector_action_requests set decision_by_signed_in_person = true
          where turn_id = ${turn.turnId} and approval_id = ${approvalId}`,
      ).rejects.toThrow("connector action approval decision is immutable");
      if (via.kind !== "human")
        await expect(
          shared!.admin`
            update connector_action_requests set decision_by_kind = 'human'
            where turn_id = ${turn.turnId} and approval_id = ${approvalId}`,
        ).rejects.toThrow("connector action approval decision is immutable");
      await shared!.admin`
        update connector_action_requests set status = 'completed'
        where turn_id = ${turn.turnId} and approval_id = ${approvalId}`;
    }

    // The person's own confirmation counts once the call starts running.
    await decide(turn, "call-invite", org.member);
    expect(await confirmed()).toEqual([]);
    expect(await beginConnectorActionExecution(db, turn, asked)).toMatchObject({
      allowed: true,
      managed: true,
    });
    const saved = await confirmed();
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0]!)).toEqual(changeArgs);

    // Another attempt never borrows this attempt's confirmation.
    expect(
      await listConfirmedAppActionChanges(db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        attemptId: crypto.randomUUID(),
        subjectId: org.member,
        toolName: "admin_action_call",
      }),
    ).toEqual([]);

    // Once the change finished, it can't be replayed.
    await shared!.admin`
      update connector_action_requests set status = 'completed'
      where turn_id = ${turn.turnId} and approval_id = 'call-invite'`;
    expect(await confirmed()).toEqual([]);
  });

  test("can change the workspace's settings only as a live admin whose turn may make changes", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("app-actions-settings");
    // Someone using Opengeni through another product, in their own workspace.
    const person = await ensureExternalIdentity(db, {
      accountId: org.accountId,
      externalId: `end-user-${crypto.randomUUID()}`,
    });
    await shared!.admin`
      update workspace_memberships set permissions = '["workspace:admin"]'::jsonb
      where workspace_id = ${org.workspaceId} and subject_id = ${org.owner}`;
    await shared!.admin`
      update workspace_memberships set permissions = '["workspace:read","sessions:read"]'::jsonb
      where workspace_id = ${org.workspaceId} and subject_id = ${org.member}`;
    const canChange = async (
      sender: string,
      frozen: TurnAppActionGrant,
      workspaceId = org.workspaceId,
      fullAccess = false,
    ): Promise<boolean> => {
      const turn = await claimedTurn(
        { ...org, workspaceId },
        { createdBy: { kind: "subject", subjectId: sender }, sender, frozen },
      );
      if (fullAccess) {
        await grantSessionAdminAccess(db, {
          organizationId: org.accountId,
          workspaceId,
          sessionId: turn.sessionId,
          actorSubjectId: sender,
          durationHours: null,
        });
      }
      return await turnCanChangeWorkspaceSettings(db, {
        accountId: org.accountId,
        workspaceId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
      });
    };
    const admin = ["workspace:admin"] as const;

    // An admin signed in to the app, whose changes they confirm in the chat.
    expect(
      await canChange(org.owner, { subjectId: org.owner, changes: "confirm", permissions: admin }),
    ).toBe(true);
    // The same admin, but the message's recorded access leaves settings out.
    expect(
      await canChange(org.owner, {
        subjectId: org.owner,
        changes: "confirm",
        permissions: SENT_PERMISSIONS,
      }),
    ).toBe(false);
    // The same admin through an embed or other read-only sign-in.
    expect(
      await canChange(org.owner, { subjectId: org.owner, changes: "none", permissions: admin }),
    ).toBe(false);
    // A member who isn't an admin.
    expect(
      await canChange(org.member, {
        subjectId: org.member,
        changes: "confirm",
        permissions: SENT_PERMISSIONS,
      }),
    ).toBe(false);
    // Full access acts as the person who gave it, with their live access.
    await setOrganizationAgentAdminAccess(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      sessionAdminAccessAllowed: true,
    });
    const none = { changes: "none", permissions: [] } as const;
    expect(
      await canChange(org.member, { subjectId: org.member, ...none }, org.workspaceId, true),
    ).toBe(false);
    expect(
      await canChange(org.owner, { subjectId: org.owner, ...none }, org.workspaceId, true),
    ).toBe(true);
    // A Personal workspace's owner holds no admin grant there, but its settings
    // are theirs: with full access, or a confirmed turn that recorded them.
    const [own] = await shared!.admin<{ id: string }[]>`
      select personal_workspace_id as id from organization_memberships
      where account_id = ${org.accountId} and subject_id = ${org.member}`;
    await shared!.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${own!.id}, ${org.accountId}) on conflict do nothing`;
    expect(await canChange(org.member, { subjectId: org.member, ...none }, own!.id, true)).toBe(
      true,
    );
    expect(
      await canChange(
        org.member,
        { subjectId: org.member, changes: "confirm", permissions: admin },
        own!.id,
      ),
    ).toBe(true);
    // Someone using Opengeni through another product reads only, by default.
    expect(
      await canChange(
        person.subjectId,
        { subjectId: person.subjectId, changes: "none", permissions: admin },
        person.personalWorkspaceId,
      ),
    ).toBe(false);
    // Even where changes from such sign-ins are allowed, their access to
    // their workspace doesn't include its settings.
    expect(
      await canChange(
        person.subjectId,
        { subjectId: person.subjectId, changes: "confirm", permissions: admin },
        person.personalWorkspaceId,
      ),
    ).toBe(false);

    // The live grant decides: an admin who lost workspace:admin can't.
    await shared!.admin`
      update workspace_memberships set permissions = '["workspace:read"]'::jsonb
      where workspace_id = ${org.workspaceId} and subject_id = ${org.owner}`;
    expect(
      await canChange(org.owner, { subjectId: org.owner, changes: "confirm", permissions: admin }),
    ).toBe(false);
  });
});
