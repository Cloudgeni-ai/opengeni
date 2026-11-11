// The `gh` and Git gateway's decision against the real connector-action
// ledger: Settings and deletions asks by default, a connection-wide Allow
// doesn't cover it, Block wins, and an approved request runs when it's sent
// again even if the gateway now classifies it differently.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { GITHUB_SENSITIVE_REQUEST_POLICY_NAME } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  deleteWorkspace,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  databaseGatewayDecider,
  PERSONAL_GITHUB_POLICY_SERVER_ID,
  type GatewayDecisionIdentity,
  type GatewayDecisionInput,
} from "../src/routes/personal-github-gateway-policy";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const CONNECTION_ID = "personal-github-decider-connection";
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let workspace: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

setDefaultTimeout(120_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("personal-github-gateway-decider");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL test database unavailable");
    console.warn("[personal-github-gateway-decider] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "github-gateway-decider-test",
    accountExternalId: `account-${suffix}`,
    accountName: "GitHub gateway decider test",
    workspaceExternalSource: "github-gateway-decider-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "GitHub gateway decider test",
    subjectId: `user:${suffix}`,
  });
  workspace = access.workspaceGrants[0]!;
}, 180_000);

afterAll(async () => {
  if (client && workspace) await deleteWorkspace(client.db, workspace.workspaceId);
  await client?.close();
  await shared?.release();
}, 60_000);

/** A person's chat with one claimed turn, as the gateway sees it. */
async function claimedTurn(): Promise<GatewayDecisionIdentity> {
  const db = client.db;
  const subjectId = workspace.subjectId;
  const session = await createSession(db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    initialMessage: "gateway decider fixture",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
  });
  await withWorkspaceSubjectSessionActivityRls(db, workspace.workspaceId, subjectId, (scoped) =>
    scoped.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof scoped, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        sessionId: session.id,
        subjectId,
        actor: { type: "human", subjectId },
        operationKey: `send-${crypto.randomUUID()}`,
        delivery: "send",
        text: "clean up the merged branch",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, workspace.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`claim failed: ${claim.reason}`);
  return {
    claims: {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
      connectionId: CONNECTION_ID,
    } as unknown as GatewayDecisionIdentity["claims"],
    initiator: claim.turn.initiator,
    unattended: false,
  };
}

/** The attempt's frozen policy snapshot, as the person's settings produce it. */
async function setPolicies(
  identity: GatewayDecisionIdentity,
  policies: Record<string, "allow" | "ask" | "block">,
) {
  const snapshot = Object.entries(policies).map(([toolName, policy]) => ({
    id: crypto.randomUUID(),
    connectionId: CONNECTION_ID,
    serverId: PERSONAL_GITHUB_POLICY_SERVER_ID,
    toolName,
    actionName: toolName,
    policy,
    version: 1,
  }));
  await shared!.admin`
    update session_turn_attempts
    set connector_action_policies = ${shared!.admin.json(snapshot)}
    where workspace_id = ${workspace.workspaceId} and id = ${identity.claims.attemptId}`;
}

async function approve(identity: GatewayDecisionIdentity, digest: string) {
  const [event] = await shared!.admin<{ id: string }[]>`
    select id from session_events where session_id = ${identity.claims.sessionId}
    order by sequence desc limit 1`;
  const updated = await shared!.admin`
    update connector_action_requests
    set status = 'approved', decision = 'approve', decision_by_subject_id = ${workspace.subjectId},
      decision_by_kind = 'human', decision_by_signed_in_person = true,
      decision_event_id = ${event!.id}, decided_at = now(), updated_at = now()
    where workspace_id = ${workspace.workspaceId} and turn_id = ${identity.claims.turnId}
      and approval_id = ${`ghgw:${digest}`}`;
  expect(updated.count).toBe(1);
}

async function recordedTool(identity: GatewayDecisionIdentity, digest: string) {
  const [row] = await shared!.admin<{ tool_name: string }[]>`
    select tool_name from connector_action_requests
    where workspace_id = ${workspace.workspaceId} and turn_id = ${identity.claims.turnId}
      and approval_id = ${`ghgw:${digest}`}`;
  return row?.tool_name;
}

function request(
  action: GatewayDecisionInput["action"],
  digest = crypto.randomUUID(),
): GatewayDecisionInput {
  return { action, digest, title: action.title, reviewArguments: { request: action.title } };
}

const environmentSecret: GatewayDecisionInput["action"] = {
  kind: "write",
  tools: [],
  sensitive: true,
  title: "Change repository environments",
};

describe("personal GitHub gateway decisions in PostgreSQL", () => {
  test("Settings and deletions: Ask by default, * Allow doesn't cover it, Block wins", async () => {
    if (!shared) return;
    const identity = await claimedTurn();
    const decide = databaseGatewayDecider(client.db);

    await setPolicies(identity, {});
    const asked = request(environmentSecret);
    expect(await decide(identity, asked)).toMatchObject({ kind: "refuse", waiting: true });
    expect(await recordedTool(identity, asked.digest)).toBe(GITHUB_SENSITIVE_REQUEST_POLICY_NAME);

    await setPolicies(identity, { "*": "allow" });
    expect(await decide(identity, request(environmentSecret))).toMatchObject({
      kind: "refuse",
      waiting: true,
    });

    await setPolicies(identity, { "*": "block" });
    expect(await decide(identity, request(environmentSecret))).toMatchObject({
      kind: "refuse",
      waiting: false,
    });

    // An explicit choice for Settings and deletions beats the connection-wide one.
    await setPolicies(identity, {
      "*": "block",
      github_request: "allow",
      [GITHUB_SENSITIVE_REQUEST_POLICY_NAME]: "allow",
    });
    expect(await decide(identity, request(environmentSecret))).toEqual({ kind: "allow" });

    // A write whose repositories can't be confirmed still asks under Allow.
    expect(await decide(identity, request({ ...environmentSecret, unscoped: true }))).toMatchObject(
      { kind: "refuse", waiting: true },
    );
  });

  test("an approved request runs when sent again, even if it is no longer sensitive", async () => {
    if (!shared) return;
    const identity = await claimedTurn();
    const decide = databaseGatewayDecider(client.db);
    await setPolicies(identity, { ref_create: "ask" });
    const deletion: GatewayDecisionInput["action"] = {
      kind: "write",
      tools: ["ref_create"],
      sensitive: true,
      title: "Delete branch or tag",
    };
    // First try: the default branch couldn't be read, so it's sensitive.
    const first = request(deletion);
    expect(await decide(identity, first)).toMatchObject({ kind: "refuse", waiting: true });
    expect(await recordedTool(identity, first.digest)).toBe(GITHUB_SENSITIVE_REQUEST_POLICY_NAME);
    await approve(identity, first.digest);
    // Sent again: now confirmed as an ordinary branch, it follows ref_create.
    expect(
      await decide(identity, request({ ...deletion, sensitive: false }, first.digest)),
    ).toMatchObject({ kind: "run" });
  });

  test("an approval recorded under Create and update runs when sent again as sensitive", async () => {
    if (!shared) return;
    const identity = await claimedTurn();
    const decide = databaseGatewayDecider(client.db);
    await setPolicies(identity, { ref_create: "ask" });
    const deletion: GatewayDecisionInput["action"] = {
      kind: "write",
      tools: ["ref_create"],
      sensitive: false,
      title: "Delete branch or tag",
    };
    const first = request(deletion);
    expect(await decide(identity, first)).toMatchObject({ kind: "refuse", waiting: true });
    expect(await recordedTool(identity, first.digest)).toBe("ref_create");
    await approve(identity, first.digest);
    // Sent again: the default branch couldn't be read this time, so it's sensitive.
    expect(
      await decide(identity, request({ ...deletion, sensitive: true }, first.digest)),
    ).toMatchObject({ kind: "run" });
  });

  test("Block chosen after an approval refuses the request when it's sent again", async () => {
    if (!shared) return;
    const identity = await claimedTurn();
    const decide = databaseGatewayDecider(client.db);
    await setPolicies(identity, {});
    const first = request(environmentSecret);
    expect(await decide(identity, first)).toMatchObject({ kind: "refuse", waiting: true });
    await approve(identity, first.digest);
    await setPolicies(identity, { [GITHUB_SENSITIVE_REQUEST_POLICY_NAME]: "block" });
    expect(await decide(identity, request(environmentSecret, first.digest))).toMatchObject({
      kind: "refuse",
      waiting: false,
    });
  });
});
