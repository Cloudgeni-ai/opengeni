// An approved `gh secret set`, run again after the approval, goes through the
// real connector-action ledger: `gh` re-seals the value with fresh randomness,
// so the retry's body differs only in ciphertext. It runs once; a later run
// asks again, and a different secret never rides on the approval.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
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
  handlePersonalGitHubGatewayRequest,
  type PersonalGitHubGatewayAuthority,
  type PersonalGitHubGatewayServices,
} from "../src/routes/personal-github-gateway";
import {
  databaseGatewayCompleter,
  databaseGatewayDecider,
  type GatewayDecisionIdentity,
} from "../src/routes/personal-github-gateway-policy";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const CONNECTION_ID = "personal-github-secret-retry-connection";
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let workspace: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

setDefaultTimeout(120_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("personal-github-gateway-secret-retry");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL test database unavailable");
    console.warn("[personal-github-gateway-secret-retry] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "github-gateway-secret-retry-test",
    accountExternalId: `account-${suffix}`,
    accountName: "GitHub gateway secret retry test",
    workspaceExternalSource: "github-gateway-secret-retry-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "GitHub gateway secret retry test",
    subjectId: `user:${suffix}`,
  });
  workspace = access.workspaceGrants[0]!;
}, 180_000);

afterAll(async () => {
  if (client && workspace) await deleteWorkspace(client.db, workspace.workspaceId);
  await client?.close();
  await shared?.release();
}, 60_000);

/** A person's chat with one claimed turn and no GitHub action choices. */
async function claimedTurn(): Promise<GatewayDecisionIdentity> {
  const db = client.db;
  const subjectId = workspace.subjectId;
  const session = await createSession(db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    initialMessage: "gateway secret retry fixture",
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
        text: "set the staging webhook secret",
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
  await shared!.admin`
    update session_turn_attempts
    set connector_action_policies = ${shared!.admin.json([])}
    where workspace_id = ${workspace.workspaceId} and id = ${attemptId}`;
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

/** The person approves the turn's one pending gateway request. */
async function approvePending(identity: GatewayDecisionIdentity) {
  const [event] = await shared!.admin<{ id: string }[]>`
    select id from session_events where session_id = ${identity.claims.sessionId}
    order by sequence desc limit 1`;
  const updated = await shared!.admin`
    update connector_action_requests
    set status = 'approved', decision = 'approve', decision_by_subject_id = ${workspace.subjectId},
      decision_by_kind = 'human', decision_by_signed_in_person = true,
      decision_event_id = ${event!.id}, decided_at = now(), updated_at = now()
    where workspace_id = ${workspace.workspaceId} and turn_id = ${identity.claims.turnId}
      and approval_id like 'ghgw:%' and status = 'pending'`;
  expect(updated.count).toBe(1);
}

function gateway(identity: GatewayDecisionIdentity) {
  const sent: string[] = [];
  const authority = {
    claims: identity.claims,
    identity,
    providerPrincipalId: "7",
    metadata: { githubLogin: "person" },
    selection: {
      allRepositoriesAccess: "write",
      repositories: [
        {
          repositoryId: "11",
          fullName: "acme/ops",
          canonicalUrl: "https://github.com/acme/ops",
          selectedAccess: "write",
          selectionGeneration: 1,
          permissions: { pull: true, triage: false, push: true, maintain: false, admin: false },
          archived: false,
          disabled: false,
        },
      ],
    },
    removedRepositories: [],
  } as unknown as PersonalGitHubGatewayAuthority;
  const services: PersonalGitHubGatewayServices = {
    openClaims: (token) => (token === "session-pass" ? identity.claims : null),
    resolveAuthority: async () => authority,
    authorizeProviderRequest: async () => "Bearer person-token",
    decide: databaseGatewayDecider(client.db),
    complete: databaseGatewayCompleter(client.db),
    git: {} as PersonalGitHubGatewayServices["git"],
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(new TextDecoder().decode(init?.body as Uint8Array));
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch,
  };
  /** `gh secret set NAME --env staging`: a new sealed box every time. */
  const setSecret = (name: string) =>
    handlePersonalGitHubGatewayRequest(
      new Request(
        `https://opengeni.test/v1/github/personal/gateway/api/repos/acme/ops/environments/staging/secrets/${name}`,
        {
          method: "PUT",
          headers: { authorization: "Bearer session-pass", "content-type": "application/json" },
          body: JSON.stringify({
            encrypted_value: randomBytes(72).toString("base64"),
            key_id: "568250167242549743",
          }),
        },
      ),
      "api",
      services,
    );
  return { setSecret, sent };
}

describe("an approved gh secret set in PostgreSQL", () => {
  test("the re-sealed retry runs once, a later run and another secret ask again", async () => {
    if (!shared) return;
    const identity = await claimedTurn();
    const { setSecret, sent } = gateway(identity);

    const first = await setSecret("SLACK_WEBHOOK_URL");
    expect(first.status).toBe(403);
    expect(first.headers.get("x-opengeni-approval")).toBe("pending");
    // Retried before the person decides: still waiting, not a conflict.
    const early = await setSecret("SLACK_WEBHOOK_URL");
    expect(early.headers.get("x-opengeni-approval")).toBe("pending");
    expect(sent).toEqual([]);

    await approvePending(identity);
    // Another secret doesn't ride on that approval.
    const other = await setSecret("OTHER_SECRET");
    expect(other.headers.get("x-opengeni-approval")).toBe("pending");
    expect(sent).toEqual([]);

    const retry = await setSecret("SLACK_WEBHOOK_URL");
    expect(retry.status).toBe(201);
    expect(sent).toHaveLength(1);
    // GitHub gets the retry's own ciphertext, not a placeholder.
    expect(JSON.parse(sent[0]!).encrypted_value).toHaveLength(96);

    const again = await setSecret("SLACK_WEBHOOK_URL");
    expect(again.status).toBe(403);
    expect(again.headers.get("x-opengeni-approval")).toBe("pending");
    expect(sent).toHaveLength(1);
  });
});
