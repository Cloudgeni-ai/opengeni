import { afterAll, beforeAll, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdate,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createXaiSubscriptionCredential,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
  selectXaiCredentialForUse,
  sendAgentMessageInTransaction,
  setInitialActiveXaiCredential,
  steerAgentSessionInTransaction,
  submitHumanPromptInTransaction,
  upsertOrganizationXaiSubscription,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
  workspaceXaiSubscriptionActiveForAuthority,
  type DbClient,
} from "../src";
import {
  createClaudeSubscriptionAccount,
  resolveClaudeProviderAccountAuthoritySnapshotForAcceptance,
  selectClaudeCredentialForUse,
  setInitialActiveClaudeCredential,
  upsertOrganizationClaudeSubscription,
  workspaceClaudeSubscriptionActiveForAuthority,
} from "../src/claude-subscription-accounts";

// Contract: the subscription pool belongs to the receiving session's accepted
// work, never to the sender, and acceptance without an exact human resolves the
// organization or workspace pool. Personal pools are never inherited.

let shared: SharedTestDatabase;
let client: DbClient;
const encryptionKey = new Uint8Array(32).fill(23);
const organization = { version: 1, scope: "organization" } as const;
const workspace = { version: 1, scope: "workspace" } as const;
const upstreamModelId = "claude-opus-5-5";
const settings = getSettings({
  OPENGENI_ENVIRONMENT: "test",
  OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED: "true",
  OPENGENI_SUPERGROK_SUBSCRIPTION_ENABLED: "true",
});

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("subscription-pool-receiver-authority");
  if (!acquired) throw new Error("Receiver subscription authority tests require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Snapshot =
  | { version: 1; scope: "organization" | "workspace" }
  | { version: 1; scope: "user"; authorityGeneration: number };

async function fixture() {
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('Receiver pool organization') returning id`;
  const accountId = account!.id;
  const [shared_] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, 'Receiver pool shared') returning id`;
  const workspaceId = shared_!.id;
  await shared.admin`
    insert into workspace_inference_controls (account_id, workspace_id) values (${accountId}, ${workspaceId})`;
  const humans = [`user:${crypto.randomUUID()}`, `user:${crypto.randomUUID()}`] as const;
  for (const [index, subjectId] of humans.entries()) {
    const [personal] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${accountId}, 'Personal') returning id`;
    await shared.admin`
      insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
      values (${accountId}, ${subjectId}, ${index === 0 ? "owner" : "member"}, 'active', ${personal!.id})`;
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
      values (${accountId}, ${workspaceId}, ${subjectId}, 'owner', '[]'::jsonb)`;
  }
  return { accountId, workspaceId, owner: humans[0], member: humans[1] };
}

/** Connect an organization pool for both Claude and SuperGrok. */
async function connectOrganizationPools(input: Fixture) {
  const actor = { organizationId: input.accountId, actorSubjectId: input.owner };
  const claudeIdentity = crypto.randomUUID();
  const claude = await upsertOrganizationClaudeSubscription(client.db, {
    ...actor,
    encryptionKey,
    secret: {
      version: 1,
      token: "sk-ant-oat01-receiver-fixture",
      identity: { accountUuid: claudeIdentity, deviceId: "a".repeat(64) },
    },
    providerAccountId: claudeIdentity,
    label: null,
    accountEmail: null,
    expiresAt: null,
  });
  const xai = await upsertOrganizationXaiSubscription(client.db, {
    ...actor,
    providerAccountId: `receiver-${crypto.randomUUID()}`,
    encryptionKey,
    secret: { version: 1, accessToken: "receiver-access", refreshToken: "receiver-refresh" },
    label: null,
    accountEmail: null,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return { claude: claude.account.id, xai: xai.account.id };
}

/** Connect and activate a personal (user-scoped) pool for both providers. */
async function connectPersonalPools(input: Fixture, subjectId: string) {
  const scope = { accountId: input.accountId, workspaceId: input.workspaceId, subjectId };
  const claudeIdentity = crypto.randomUUID();
  const claude = await createClaudeSubscriptionAccount(client.db, {
    ...scope,
    scope: "user",
    encryptionKey,
    secret: {
      version: 1,
      token: "sk-ant-oat01-personal-fixture",
      identity: { accountUuid: claudeIdentity, deviceId: "b".repeat(64) },
    },
    providerAccountId: claudeIdentity,
    label: null,
    accountEmail: null,
    planType: "claude_max",
    expiresAt: null,
  });
  await setInitialActiveClaudeCredential(client.db, {
    ...scope,
    authoritySnapshot: claude.authoritySnapshot,
    credentialId: claude.account.id,
  });
  const xai = await createXaiSubscriptionCredential(client.db, {
    ...scope,
    scope: "user",
    encryptionKey,
    secret: { version: 1, accessToken: "personal-access" },
    providerAccountId: `personal-${crypto.randomUUID()}`,
  });
  await setInitialActiveXaiCredential(client.db, {
    ...scope,
    authoritySnapshot: xai.authoritySnapshot,
    credentialId: xai.account.id,
  });
  const accepted = { workspaceId: input.workspaceId, subjectId };
  expect(
    await resolveClaudeProviderAccountAuthoritySnapshotForAcceptance(client.db, accepted),
  ).toMatchObject({ scope: "user" });
  expect(
    await resolveXaiProviderAccountAuthoritySnapshotForAcceptance(client.db, accepted),
  ).toMatchObject({ scope: "user" });
  return { claude: claude.account.id, xai: xai.account.id };
}

async function humanSession(input: Fixture, subjectId: string) {
  return await createSession(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: "",
    subjectId,
    createdBy: { kind: "subject", subjectId },
    resources: [],
    tools: [],
    metadata: {},
    model: `organization-claude-subscription/${upstreamModelId}`,
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
}

async function prompt(
  input: Fixture,
  sessionId: string,
  actor: { type: "human"; subjectId: string } | { type: "service"; subjectId: string },
) {
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    input.workspaceId,
    actor.subjectId,
    (tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId,
        subjectId: actor.subjectId,
        actor,
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Start the work",
        resources: [],
        reasoningEffortFallback: "low",
        source: actor.type === "human" ? "user" : "api",
      }),
  );
}

async function claim(input: Fixture, sessionId: string) {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, input.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`Session was not claimed: ${claimed.action}`);
  return { attemptId, turn: claimed.turn };
}

async function turnAuthority(turnId: string) {
  const [row] = await shared.admin<
    { claude: Snapshot; xai: Snapshot; human: string | null }[]
  >`select claude_provider_account_authority_snapshot as claude,
      xai_provider_account_authority_snapshot as xai,
      initiating_human_subject_id as human
    from session_turns where id = ${turnId}`;
  if (!row) throw new Error(`Turn not found: ${turnId}`);
  return row;
}

async function updateAuthority(updateId: string) {
  const [row] = await shared.admin<{ claude: Snapshot; xai: Snapshot }[]>`
    select claude_provider_account_authority_snapshot as claude,
      xai_provider_account_authority_snapshot as xai
    from session_system_updates where id = ${updateId}`;
  if (!row) throw new Error(`Update not found: ${updateId}`);
  return row;
}

function agentActor(sessionId: string, claimed: Awaited<ReturnType<typeof claim>>) {
  return {
    type: "agent_attempt" as const,
    sessionId,
    turnId: claimed.turn.id,
    attemptId: claimed.attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

async function message(
  input: Fixture,
  sender: { sessionId: string; claimed: Awaited<ReturnType<typeof claim>> },
  targetSessionId: string,
  delivery: "message" | "steer" = "message",
) {
  const scope = { accountId: input.accountId, workspaceId: input.workspaceId, targetSessionId };
  const actor = agentActor(sender.sessionId, sender.claimed);
  // Production agent commands run without an ambient subject.
  return await withWorkspaceSessionActivityRls(client.db, input.workspaceId, (tx) =>
    delivery === "message"
      ? sendAgentMessageInTransaction(tx, {
          ...scope,
          operationKey: crypto.randomUUID(),
          text: "Please take this over",
          actor,
        })
      : steerAgentSessionInTransaction(tx, {
          ...scope,
          operationKey: crypto.randomUUID(),
          instruction: "Change direction",
          actor,
        }),
  );
}

async function complete(
  input: Fixture,
  sessionId: string,
  claimed: Awaited<ReturnType<typeof claim>>,
) {
  const settled = await applySessionTurnSettlement(client.db, input.workspaceId, {
    sessionId,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId: claimed.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [],
  } as never);
  expect(settled.action).toBe("settled");
}

/** The accepted snapshot must reach the pool account the receiver can actually use. */
async function expectSelects(
  input: Fixture,
  authority: { claude: Snapshot; xai: Snapshot },
  expected: { claude: string; xai: string },
) {
  const selection = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.owner,
    shardKey: crypto.randomUUID(),
  };
  expect(
    await workspaceClaudeSubscriptionActiveForAuthority(client.db, settings, {
      ...selection,
      authoritySnapshot: authority.claude,
      upstreamModelId,
    }),
  ).toBe(true);
  expect(
    (
      await selectClaudeCredentialForUse(client.db, {
        ...selection,
        authoritySnapshot: authority.claude,
        modelId: `organization-claude-subscription/${upstreamModelId}`,
        upstreamModelId,
      })
    ).credentialId,
  ).toBe(expected.claude);
  expect(
    await workspaceXaiSubscriptionActiveForAuthority(client.db, settings, {
      ...selection,
      authoritySnapshot: authority.xai,
    }),
  ).toBe(true);
  expect(
    (await selectXaiCredentialForUse(client.db, { ...selection, authoritySnapshot: authority.xai }))
      .credentialId,
  ).toBe(expected.xai);
}

test("SUB-ACCESS-01: an Agent message from a sender accepted before the organization pool freezes the receiver's organization pool (Claude and SuperGrok)", async () => {
  const input = await fixture();
  // The sender was accepted while no pool existed, so its own work stays workspace.
  const sender = await humanSession(input, input.owner);
  await prompt(input, sender.id, { type: "human", subjectId: input.owner });
  const senderClaim = await claim(input, sender.id);
  expect(await turnAuthority(senderClaim.turn.id)).toMatchObject({
    claude: workspace,
    xai: workspace,
  });

  const pools = await connectOrganizationPools(input);
  const receiver = await humanSession(input, input.owner);
  const [receiverRow] = await shared.admin<{ claude: Snapshot; xai: Snapshot }[]>`
    select initial_claude_provider_account_authority_snapshot as claude,
      initial_xai_provider_account_authority_snapshot as xai
    from sessions where id = ${receiver.id}`;
  expect(receiverRow).toEqual({ claude: organization, xai: organization });

  const sent = await message(input, { sessionId: sender.id, claimed: senderClaim }, receiver.id);
  expect(await updateAuthority(sent.updateId)).toEqual({
    claude: organization,
    xai: organization,
  });
  const received = await claim(input, receiver.id);
  const authority = await turnAuthority(received.turn.id);
  expect(authority).toEqual({ claude: organization, xai: organization, human: input.owner });
  await expectSelects(input, authority, pools);

  // The sender's own accepted work keeps its frozen snapshot.
  expect(await turnAuthority(senderClaim.turn.id)).toMatchObject({
    claude: workspace,
    xai: workspace,
  });
}, 180_000);

test("SUB-ACCESS-01: service-actor prompts and service-created sessions resolve the organization pool, and their Agent messages and Steers freeze the receiver's pool (Claude and SuperGrok)", async () => {
  const input = await fixture();
  const pools = await connectOrganizationPools(input);
  const service = { type: "service" as const, subjectId: `service:bridge-${crypto.randomUUID()}` };

  // An organization API key / Slack bridge prompt has no exact human.
  const sender = await humanSession(input, input.owner);
  await prompt(input, sender.id, service);
  const senderClaim = await claim(input, sender.id);
  const senderAuthority = await turnAuthority(senderClaim.turn.id);
  expect(senderAuthority).toMatchObject({ claude: organization, xai: organization });
  await expectSelects(input, senderAuthority, pools);

  // A session created by a non-subject creator resolves the shared pool too.
  const serviceCreated = await createSession(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: "",
    createdBy: { kind: "service", subjectId: service.subjectId },
    resources: [],
    tools: [],
    metadata: {},
    model: `organization-claude-subscription/${upstreamModelId}`,
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const [serviceRow] = await shared.admin<{ claude: Snapshot; xai: Snapshot }[]>`
    select initial_claude_provider_account_authority_snapshot as claude,
      initial_xai_provider_account_authority_snapshot as xai
    from sessions where id = ${serviceCreated.id}`;
  expect(serviceRow).toEqual({ claude: organization, xai: organization });

  for (const delivery of ["message", "steer"] as const) {
    const receiver = await humanSession(input, input.owner);
    await message(input, { sessionId: sender.id, claimed: senderClaim }, receiver.id, delivery);
    const received = await claim(input, receiver.id);
    const authority = await turnAuthority(received.turn.id);
    expect(authority).toMatchObject({ claude: organization, xai: organization });
    await expectSelects(input, authority, pools);
  }
}, 180_000);

test("SUB-ACCESS-01: Agent messages never carry a personal pool into another human's session, in either direction (Claude and SuperGrok)", async () => {
  const input = await fixture();
  const pools = await connectOrganizationPools(input);
  const ownerPersonal = await connectPersonalPools(input, input.owner);

  // The owner's own work runs on their explicitly activated personal pool.
  const ownerSession = await humanSession(input, input.owner);
  await prompt(input, ownerSession.id, { type: "human", subjectId: input.owner });
  const ownerClaim = await claim(input, ownerSession.id);
  const ownerAuthority = await turnAuthority(ownerClaim.turn.id);
  expect(ownerAuthority.claude.scope).toBe("user");
  expect(ownerAuthority.xai.scope).toBe("user");

  // Sender personal pool -> another human's session: the receiver keeps its
  // organization pool, so the owner's personal account never funds it.
  const memberSession = await humanSession(input, input.member);
  await message(input, { sessionId: ownerSession.id, claimed: ownerClaim }, memberSession.id);
  const memberReceived = await claim(input, memberSession.id);
  const memberAuthority = await turnAuthority(memberReceived.turn.id);
  expect(memberAuthority).toEqual({ claude: organization, xai: organization, human: input.owner });
  await expectSelects(input, memberAuthority, pools);

  // Receiver personal pool, different causal human: the member's message to
  // the owner's personal-pool session falls back to the organization pool.
  const memberSender = await humanSession(input, input.member);
  await prompt(input, memberSender.id, { type: "human", subjectId: input.member });
  const memberClaim = await claim(input, memberSender.id);
  expect(await turnAuthority(memberClaim.turn.id)).toMatchObject({
    claude: organization,
    xai: organization,
  });
  const ownerTarget = await humanSession(input, input.owner);
  await prompt(input, ownerTarget.id, { type: "human", subjectId: input.owner });
  const [ownerTargetTurn] = await shared.admin<{ id: string }[]>`
    select id from session_turns where session_id = ${ownerTarget.id}`;
  expect((await turnAuthority(ownerTargetTurn!.id)).claude.scope).toBe("user");
  const cross = await message(
    input,
    { sessionId: memberSender.id, claimed: memberClaim },
    ownerTarget.id,
  );
  expect(await updateAuthority(cross.updateId)).toEqual({
    claude: organization,
    xai: organization,
  });

  // The same human keeps their own receiver's personal pool: from the latest
  // accepted turn, and from the frozen initial snapshot before any turn exists.
  const ownerBusy = await humanSession(input, input.owner);
  await prompt(input, ownerBusy.id, { type: "human", subjectId: input.owner });
  const sameLatest = await message(
    input,
    { sessionId: ownerSession.id, claimed: ownerClaim },
    ownerBusy.id,
  );
  expect((await updateAuthority(sameLatest.updateId)).claude.scope).toBe("user");
  expect((await updateAuthority(sameLatest.updateId)).xai.scope).toBe("user");
  const ownerIdle = await humanSession(input, input.owner);
  await message(input, { sessionId: ownerSession.id, claimed: ownerClaim }, ownerIdle.id);
  const sameHuman = await claim(input, ownerIdle.id);
  const sameHumanAuthority = await turnAuthority(sameHuman.turn.id);
  expect(sameHumanAuthority.claude.scope).toBe("user");
  expect(sameHumanAuthority.xai.scope).toBe("user");
  expect(sameHumanAuthority.human).toBe(input.owner);
  const ownerSelection = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.owner,
    shardKey: crypto.randomUUID(),
  };
  expect(
    (
      await selectClaudeCredentialForUse(client.db, {
        ...ownerSelection,
        authoritySnapshot: sameHumanAuthority.claude,
        upstreamModelId,
      })
    ).credentialId,
  ).toBe(ownerPersonal.claude);
  expect(
    (
      await selectXaiCredentialForUse(client.db, {
        ...ownerSelection,
        authoritySnapshot: sameHumanAuthority.xai,
      })
    ).credentialId,
  ).toBe(ownerPersonal.xai);
}, 180_000);

test("SUB-ACCESS-01: the receiver's pool comes from its latest accepted work, not its queue position (Claude and SuperGrok)", async () => {
  const input = await fixture();
  const service = { type: "service" as const, subjectId: `service:bridge-${crypto.randomUUID()}` };
  const sender = await humanSession(input, input.owner);
  await prompt(input, sender.id, service);
  const senderClaim = await claim(input, sender.id);

  // Before the organization pool: a human turn (position 1) and an internal
  // Agent-message turn (position 2) on the receiver, both frozen to workspace.
  const receiver = await humanSession(input, input.owner);
  await prompt(input, receiver.id, { type: "human", subjectId: input.owner });
  await complete(input, receiver.id, await claim(input, receiver.id));
  await message(input, { sessionId: sender.id, claimed: senderClaim }, receiver.id);
  const internal = await claim(input, receiver.id);
  expect(await turnAuthority(internal.turn.id)).toMatchObject({
    claude: workspace,
    xai: workspace,
  });
  await complete(input, receiver.id, internal);

  // After the pool exists, a newer human Send (position 1 again) moves the
  // receiver's accepted work to the organization pool.
  const pools = await connectOrganizationPools(input);
  await prompt(input, receiver.id, { type: "human", subjectId: input.owner });
  const newest = await claim(input, receiver.id);
  expect(await turnAuthority(newest.turn.id)).toMatchObject({
    claude: organization,
    xai: organization,
  });
  const positions = await shared.admin<{ id: string; position: string }[]>`
    select id, position from session_turns where session_id = ${receiver.id} order by created_at`;
  expect(Number(positions.at(-1)!.position)).toBeLessThan(
    Math.max(...positions.map((row) => Number(row.position))),
  );
  await complete(input, receiver.id, newest);

  await message(input, { sessionId: sender.id, claimed: senderClaim }, receiver.id);
  const received = await claim(input, receiver.id);
  const authority = await turnAuthority(received.turn.id);
  expect(authority).toMatchObject({ claude: organization, xai: organization });
  await expectSelects(input, authority, pools);
}, 180_000);

test("SUB-ACCESS-01: internal updates without causal authority resolve the organization pool (Claude and SuperGrok)", async () => {
  const input = await fixture();
  const pools = await connectOrganizationPools(input);
  const receiver = await humanSession(input, input.owner);
  const dedupeKey = `receiver-pool:${crypto.randomUUID()}`;
  await addSessionSystemUpdate(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: receiver.id,
    kind: "child_terminal_result",
    classification: "success",
    sourceId: crypto.randomUUID(),
    dedupeKey,
    summary: "Detached result",
    payload: { type: "child_terminal_result", childSessionId: crypto.randomUUID(), status: "idle" },
  });
  const [update] = await shared.admin<{ claude: Snapshot; xai: Snapshot }[]>`
    select claude_provider_account_authority_snapshot as claude,
      xai_provider_account_authority_snapshot as xai
    from session_system_updates where session_id = ${receiver.id} and dedupe_key = ${dedupeKey}`;
  expect(update).toEqual({ claude: organization, xai: organization });
  const received = await claim(input, receiver.id);
  const authority = await turnAuthority(received.turn.id);
  expect(authority).toMatchObject({ claude: organization, xai: organization, human: null });
  await expectSelects(input, authority, pools);
}, 180_000);

test("SUB-ACCESS-01: a child receiver before its first turn keeps a personal pool only for its spawning human (Claude and SuperGrok)", async () => {
  const input = await fixture();
  const pools = await connectOrganizationPools(input);
  await connectPersonalPools(input, input.owner);
  const parent = await humanSession(input, input.owner);
  await prompt(input, parent.id, { type: "human", subjectId: input.owner });
  const parentClaim = await claim(input, parent.id);
  const parentAuthority = await turnAuthority(parentClaim.turn.id);
  expect(parentAuthority.claude.scope).toBe("user");
  const child = await createSession(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: "",
    parentSessionId: parent.id,
    createdByActor: agentActor(parent.id, parentClaim),
    initialClaudeProviderAccountAuthoritySnapshot: parentAuthority.claude,
    initialXaiProviderAccountAuthoritySnapshot: parentAuthority.xai,
    resources: [],
    tools: [],
    metadata: {},
    model: `organization-claude-subscription/${upstreamModelId}`,
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });

  // The spawning human's own message keeps the child's inherited personal pool.
  const same = await message(input, { sessionId: parent.id, claimed: parentClaim }, child.id);
  expect(await updateAuthority(same.updateId)).toEqual({
    claude: parentAuthority.claude,
    xai: parentAuthority.xai,
  });

  // Another human's message falls back to the organization pool.
  const member = await humanSession(input, input.member);
  await prompt(input, member.id, { type: "human", subjectId: input.member });
  const memberClaim = await claim(input, member.id);
  const cross = await message(input, { sessionId: member.id, claimed: memberClaim }, child.id);
  const crossAuthority = await updateAuthority(cross.updateId);
  expect(crossAuthority).toEqual({ claude: organization, xai: organization });
  await expectSelects(input, crossAuthority, pools);
}, 180_000);
