import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  acceptOrganizationInvitation,
  acquireLease,
  countAllSessionsInGroup,
  createDb,
  createOrganizationInvitation,
  createSession,
  claimSessionWorkForAttempt,
  ensureManagedAccessForUser,
  forkSessionContent,
  getSessionForSubject,
  listSessionIdsInGroup,
  listSessionDiscoverySummaries,
  listSessionsForSubject,
  listWorkspaceBackgroundCommandsForSubject,
  mutateSessionControlInTransaction,
  releaseLeaseHolder,
  submitHumanPromptInTransaction,
  transitionSessionVisibility,
  updateSessionTitle,
  withSessionRlsActorContext,
  withWorkspaceSubjectSessionActivityRls,
  withWorkspaceRls,
  type DbClient,
} from "../src/index";
import { listSessionBackgroundCommands } from "../src/session-background-commands";

// Who can read a session and who can use its sandbox are separate properties.
// An Only-me session may share a sandbox group with other sessions: the box
// and its files stay as shared as the box, while the session's conversation
// and command records stay scoped to its own audience.
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("private-session-shared-sandbox");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function organization() {
  const ownerUserId = `shared-box-owner-${crypto.randomUUID()}`;
  const memberUserId = `shared-box-member-${crypto.randomUUID()}`;
  const owner = `user:${ownerUserId}`;
  const member = `user:${memberUserId}`;
  const ownerAccess = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Shared box owner",
  });
  await ensureManagedAccessForUser(client.db, {
    userId: memberUserId,
    email: `${memberUserId}@example.test`,
    name: "Shared box member",
  });
  const grant = ownerAccess.workspaceGrants.find(
    (candidate) => candidate.workspaceId === ownerAccess.defaultWorkspaceId,
  );
  if (!grant) throw new Error("owner has no shared workspace grant");
  const { accountId, workspaceId } = grant;
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: member,
    targetEmail: `${memberUserId}@example.test`,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: member,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${workspaceId}, ${member}, 'member',
      '["sessions:read","sessions:create","sessions:control"]'::jsonb)`;
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'shared-box-test')`;
  await shared.admin`
    insert into organization_private_session_settings (
      account_id, enabled, version, updated_by_membership_id
    ) values (${accountId}, true, 1, null)
    on conflict (account_id) do update set enabled = true`;
  return { accountId, workspaceId, owner, member };
}

type Org = Awaited<ReturnType<typeof organization>>;

test("workspace commands preserve private audiences, host scope and complete pagination", async () => {
  const org = await organization();
  const own = await createSession(client.db, sessionInput(org, org.owner, ""));
  const visible = await createSession(client.db, sessionInput(org, org.owner, ""));
  await makePrivate(org, own.id);
  const seed = async (sessionId: string, count: number) => {
    await shared.admin`insert into session_background_commands (
      account_id, workspace_id, session_id, provider, control_workspace_id,
      enrollment_id, connection_instance_id, op_id, command_preview
    ) select ${org.accountId}, ${org.workspaceId}, ${sessionId}, 'connected_machine',
      ${org.workspaceId}, gen_random_uuid(), 'workspace-command-test', gen_random_uuid()::text,
      'bun run watch' from generate_series(1, ${count}::int)`;
  };
  await seed(own.id, 1);
  await seed(visible.id, 101);
  const first = await listWorkspaceBackgroundCommandsForSubject(client.db, org.workspaceId, {
    subjectId: org.member,
  });
  expect(first.commands).toHaveLength(100);
  expect(first.commands.every((command) => command.sessionId === visible.id)).toBe(true);
  expect(first.nextCursor).not.toBeNull();
  const second = await listWorkspaceBackgroundCommandsForSubject(
    client.db,
    org.workspaceId,
    { subjectId: org.member },
    first.nextCursor!,
  );
  expect(second.commands).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.commands, ...second.commands].map((command) => command.id)).size).toBe(
    101,
  );
  const scope = { kind: "scoped" as const, sessionIds: [own.id], rootSessionIds: [] };
  expect(
    (
      await listWorkspaceBackgroundCommandsForSubject(client.db, org.workspaceId, {
        subjectId: org.member,
        authorizationScope: scope,
      })
    ).commands,
  ).toEqual([]);
  const ownerRead = await listWorkspaceBackgroundCommandsForSubject(client.db, org.workspaceId, {
    subjectId: org.owner,
    authorizationScope: scope,
  });
  expect(ownerRead.commands.map((command) => command.sessionId)).toEqual([own.id]);
  await shared.admin`delete from workspace_memberships where workspace_id=${org.workspaceId} and subject_id=${org.member}`;
  await expect(
    listWorkspaceBackgroundCommandsForSubject(client.db, org.workspaceId, {
      subjectId: org.member,
    }),
  ).rejects.toThrow();
});

test("workspace command metadata uses the launch machine and includes archived chats", async () => {
  const org = await organization();
  const session = await createSession(client.db, sessionInput(org, org.owner, ""));
  await updateSessionTitle(client.db, {
    workspaceId: org.workspaceId,
    sessionId: session.id,
    title: "Preview server",
    source: "user",
  });
  const enrollmentId = crypto.randomUUID();
  await shared.admin`insert into enrollments (id, account_id, workspace_id, pubkey)
    values (${enrollmentId}, ${org.accountId}, ${org.workspaceId}, ${crypto.randomUUID()})`;
  await shared.admin`insert into sandboxes (account_id, workspace_id, enrollment_id, name, kind)
    values (${org.accountId}, ${org.workspaceId}, ${enrollmentId}, 'Original build computer', 'selfhosted')`;
  await shared.admin`insert into session_background_commands (
    account_id, workspace_id, session_id, provider, control_workspace_id,
    enrollment_id, connection_instance_id, op_id, command_preview
  ) values (${org.accountId}, ${org.workspaceId}, ${session.id}, 'connected_machine',
    ${org.workspaceId}, ${enrollmentId}, 'launch-connection', 'launch-command', 'bun run dev')`;
  await shared.admin`insert into session_pins (account_id, workspace_id, session_id, subject_id, archived, archived_at)
    values (${org.accountId}, ${org.workspaceId}, ${session.id}, ${org.member}, true, now())`;
  const result = await listWorkspaceBackgroundCommandsForSubject(client.db, org.workspaceId, {
    subjectId: org.member,
  });
  expect(result.commands).toHaveLength(1);
  expect(result.commands[0]).toMatchObject({
    sessionTitle: "Preview server",
    machineName: "Original build computer",
  });
  // A retained command has its own launch identity even when the chat has no
  // active machine pointer. Removal of discovery metadata must not hide work.
  expect(session.activeSandboxId).toBeNull();
  await shared.admin`delete from sandboxes where enrollment_id=${enrollmentId}`;
  expect(
    (
      await listWorkspaceBackgroundCommandsForSubject(client.db, org.workspaceId, {
        subjectId: org.member,
      })
    ).commands[0]?.machineName,
  ).toBeNull();
});

test("a member's message is claimable after its owner shares a private chat", async () => {
  const org = await organization();
  const session = await createSession(client.db, sessionInput(org, org.owner, ""));
  await makePrivate(org, session.id);
  const send = () =>
    withWorkspaceSubjectSessionActivityRls(client.db, org.workspaceId, org.member, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: org.accountId,
          workspaceId: org.workspaceId,
          sessionId: session.id,
          subjectId: org.member,
          actor: { type: "human", subjectId: org.member },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "Member follow-up",
          resources: [],
          reasoningEffortFallback: "medium",
          source: "user",
        }),
      ),
    );
  await expect(send()).rejects.toThrow();
  await transitionSessionVisibility(client.db, {
    workspaceId: org.workspaceId,
    sessionId: session.id,
    actorSubjectId: org.owner,
    targetVisibility: "workspace_shared",
    expectedAuthorityEpoch: 2,
    operationKey: crypto.randomUUID(),
  });
  const accepted = await send();
  const claim = await claimSessionWorkForAttempt(client.db, org.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(claim.action).toBe("claimed");
  if (claim.action !== "claimed") throw new Error("member turn was not claimed");
  expect(claim.turn.id).toBe(accepted.turnId);
  expect(claim.turn.initiatingHumanSubjectId).toBe(org.member);
});

function sessionInput(org: Org, subjectId: string, initialMessage: string) {
  return {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    initialMessage,
    resources: [],
    metadata: {},
    createdBy: { kind: "subject" as const, subjectId },
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
}

/** A parent and its child on one sandbox group, both visible to the workspace. */
async function sharedBox(org: Org) {
  const parent = await createSession(client.db, sessionInput(org, org.owner, "parent on a box"));
  const child = await createSession(client.db, {
    ...sessionInput(org, org.owner, "child on the same box"),
    parentSessionId: parent.id,
    sandboxGroupId: parent.sandboxGroupId,
  });
  expect(child.sandboxGroupId).toBe(parent.sandboxGroupId);
  return { parent, child, groupId: parent.sandboxGroupId };
}

function makePrivate(org: Org, sessionId: string, expectedAuthorityEpoch = 1) {
  return transitionSessionVisibility(client.db, {
    workspaceId: org.workspaceId,
    sessionId,
    actorSubjectId: org.owner,
    targetVisibility: "user_private",
    expectedAuthorityEpoch,
    operationKey: `visibility-${crypto.randomUUID()}`,
  });
}

async function holdBox(org: Org, groupId: string, subjectId: string) {
  const holderId = `interaction-${crypto.randomUUID()}`;
  const acquired = await acquireLease(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sandboxGroupId: groupId,
    kind: "interaction",
    holderId,
    subjectId,
    backend: "none",
    leaseTtlMs: 45_000,
  });
  expect(acquired.role).not.toBe("fenced");
  return async () => {
    await releaseLeaseHolder(client.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      sandboxGroupId: groupId,
      kind: "interaction",
      holderId,
      idleGraceMs: 0,
    });
  };
}

async function seedCommand(org: Org, sessionId: string): Promise<void> {
  // A finished command on a Connected Machine, the common shared-box case.
  await shared.admin`
    insert into session_background_commands (
      account_id, workspace_id, session_id, provider, control_workspace_id, enrollment_id,
      connection_instance_id, op_id, state, command_preview, command_text, exit_code,
      settlement_reason, settled_at
    ) values (
      ${org.accountId}, ${org.workspaceId}, ${sessionId}, 'connected_machine',
      ${org.workspaceId}, ${crypto.randomUUID()}, 'connection-1', 'op-1', 'exited',
      'cat private-notes.txt', 'cat private-notes.txt', 0, 'exited', now()
    )`;
}

async function visibleEventCount(org: Org, subjectId: string, sessionId: string) {
  return await withSessionRlsActorContext({ subjectId }, () =>
    withWorkspaceRls(client.db, org.workspaceId, async (db) => {
      const rows = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from session_events where session_id = ${sessionId}::uuid`,
      );
      return Number(rows[0]?.count ?? 0);
    }),
  );
}

describe("Only-me sessions on a shared sandbox", () => {
  test("a session that shares its sandbox can be limited to its owner, and its records stay private", async () => {
    const org = await organization();
    const { parent, child, groupId } = await sharedBox(org);
    await seedCommand(org, parent.id);

    // Neither this session's own open terminal nor a sibling's blocks (0769):
    // a viewer's stream is re-authorized against the session authority epoch
    // when its short-lived token is refreshed, and box files are as shared as
    // the box.
    const releaseOwnAccess = await holdBox(org, groupId, parent.id);
    const releaseSiblingAccess = await holdBox(org, groupId, child.id);
    const transitioned = await makePrivate(org, parent.id);
    expect(transitioned.visibility).toBe("user_private");
    await releaseOwnAccess();
    await releaseSiblingAccess();

    // The member can no longer read the private session or anything it owns.
    expect(
      await getSessionForSubject(client.db, org.workspaceId, parent.id, org.member),
    ).toBeNull();
    expect(
      await withSessionRlsActorContext({ subjectId: org.member }, () =>
        listSessionBackgroundCommands(client.db, {
          accountId: org.accountId,
          workspaceId: org.workspaceId,
          sessionId: parent.id,
        }),
      ),
    ).toEqual([]);
    expect(await visibleEventCount(org, org.member, parent.id)).toBe(0);
    expect(
      await withSessionRlsActorContext({ subjectId: org.member }, () =>
        listSessionIdsInGroup(client.db, org.workspaceId, groupId),
      ),
    ).toEqual([child.id]);

    // The owner still reads everything.
    const ownerCommands = await withSessionRlsActorContext({ subjectId: org.owner }, () =>
      listSessionBackgroundCommands(client.db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId: parent.id,
      }),
    );
    expect(ownerCommands.map((command) => command.commandPreview)).toEqual([
      "cat private-notes.txt",
    ]);
    expect(await visibleEventCount(org, org.owner, parent.id)).toBeGreaterThan(0);

    // The box itself stays shared: the member still uses it through the
    // child, and the shared-exposure disclosure counts the hidden member.
    const visibleChild = await getSessionForSubject(
      client.db,
      org.workspaceId,
      child.id,
      org.member,
    );
    expect(visibleChild?.sandboxGroupId).toBe(groupId);
    expect(
      await withSessionRlsActorContext({ subjectId: org.member }, () =>
        countAllSessionsInGroup(client.db, org.workspaceId, groupId),
      ),
    ).toBe(2);

    // ...and can keep working in the child on that box.
    const accepted = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      org.workspaceId,
      org.member,
      (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof db, {
            accountId: org.accountId,
            workspaceId: org.workspaceId,
            sessionId: child.id,
            subjectId: org.member,
            actor: { type: "human", subjectId: org.member },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "Keep going on the shared box",
            resources: [],
            reasoningEffortFallback: "medium",
            source: "user",
          }),
        ),
    );
    expect(accepted.turnId).toBeTruthy();
  }, 180_000);

  test("a paused private parent still pauses its visible child without revealing itself", async () => {
    const org = await organization();
    const { parent, child } = await sharedBox(org);
    const titled = await withSessionRlsActorContext({ subjectId: org.owner }, () =>
      updateSessionTitle(client.db, {
        workspaceId: org.workspaceId,
        sessionId: parent.id,
        title: "Secret parent title",
        source: "user",
      }),
    );
    expect(titled.title).toBe("Secret parent title");
    await makePrivate(org, parent.id);
    await withWorkspaceSubjectSessionActivityRls(client.db, org.workspaceId, org.owner, (tx) =>
      mutateSessionControlInTransaction(tx, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId: parent.id,
        actor: { type: "human", subjectId: org.owner },
        operationKey: crypto.randomUUID(),
        action: "pause",
        reason: "reviewing my private plan",
      }),
    );

    const memberView = await getSessionForSubject(client.db, org.workspaceId, child.id, org.member);
    expect(memberView?.effectiveControl.state).toBe("paused");
    expect(memberView?.effectiveControl.primaryBlocker).toMatchObject({
      kind: "session",
      displayName: "An ancestor session",
      actor: null,
      reason: null,
    });
    expect(JSON.stringify(memberView?.effectiveControl)).not.toContain("Secret parent title");
    expect(JSON.stringify(memberView?.effectiveControl)).not.toContain("private plan");

    // The agent-facing discovery list and the member's session list both keep
    // the child, drop the parent, and never carry the parent's title.
    const discovery = await listSessionDiscoverySummaries(client.db, org.workspaceId, {
      subjectId: org.member,
      limit: 50,
    });
    expect(discovery.sessions.map((summary) => summary.id)).toEqual([child.id]);
    expect(JSON.stringify(discovery.sessions)).not.toContain("Secret parent title");
    expect(JSON.stringify(discovery.sessions)).toContain("An ancestor session");
    const listed = await listSessionsForSubject(client.db, org.workspaceId, {
      subjectId: org.member,
      limit: 50,
    });
    expect(listed.sessions.map((session) => session.id)).toEqual([child.id]);
    expect(JSON.stringify(listed.sessions)).not.toContain("Secret parent title");

    // The owner keeps the full detail.
    const ownerView = await getSessionForSubject(client.db, org.workspaceId, child.id, org.owner);
    expect(ownerView?.effectiveControl.primaryBlocker).toMatchObject({
      displayName: "Secret parent title",
      reason: "reviewing my private plan",
    });
  }, 180_000);

  test("a session on a shared sandbox can be forked, and a private create may join a visible box", async () => {
    const org = await organization();
    const { child, groupId } = await sharedBox(org);

    const fork = await forkSessionContent(client.db, {
      sourceWorkspaceId: org.workspaceId,
      sourceSessionId: child.id,
      actorSubjectId: org.owner,
      destinationWorkspaceId: org.workspaceId,
      destinationVisibility: "workspace_shared",
      workspaceSharedAcknowledged: false,
      operationKey: `fork-${crypto.randomUUID()}`,
    });
    expect(fork.replay).toBe(false);
    const [forked] = await shared.admin<Array<{ sandbox_group_id: string }>>`
      select sandbox_group_id from sessions where id = ${fork.sessionId}`;
    expect(forked?.sandbox_group_id).toBe(fork.sessionId);

    const joined = await withSessionRlsActorContext({ subjectId: org.member }, () =>
      createSession(client.db, {
        ...sessionInput(org, org.member, "private work on the shared box"),
        visibility: "user_private",
        subjectId: org.member,
        createdByContext: {},
        sandboxGroupId: groupId,
      }),
    );
    expect(joined.sandboxGroupId).toBe(groupId);
    const [joinedRow] = await shared.admin<Array<{ visibility: string }>>`
      select visibility from sessions where id = ${joined.id}`;
    expect(joinedRow?.visibility).toBe("user_private");
    expect(await getSessionForSubject(client.db, org.workspaceId, joined.id, org.owner)).toBeNull();
  }, 180_000);

  test("a private create cannot join a box whose sessions the creator cannot see", async () => {
    const org = await organization();
    const ownerOnly = await withSessionRlsActorContext({ subjectId: org.owner }, () =>
      createSession(client.db, {
        ...sessionInput(org, org.owner, "owner's private box"),
        visibility: "user_private",
        subjectId: org.owner,
        createdByContext: {},
      }),
    );
    await expect(
      withSessionRlsActorContext({ subjectId: org.member }, () =>
        createSession(client.db, {
          ...sessionInput(org, org.member, "trying to join a hidden box"),
          visibility: "user_private",
          subjectId: org.member,
          createdByContext: {},
          sandboxGroupId: ownerOnly.sandboxGroupId,
        }),
      ),
    ).rejects.toThrow("Private session sandbox group is not visible to its creator");
    const [members] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from sessions where sandbox_group_id = ${ownerOnly.sandboxGroupId}`;
    expect(members?.count).toBe(1);
  }, 180_000);
});
