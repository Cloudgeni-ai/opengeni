import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  readTurnExecutionPolicyV1,
  TURN_EXECUTION_POLICY_METADATA_KEY,
  TurnExecutionPolicyV1,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { eq } from "drizzle-orm";
import {
  applySessionTurnSettlement,
  appendSessionEvents,
  armCodexCapacityWait,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  ensureCodexRotationSettings,
  getSessionTurn,
  installOrReadTurnExecutionPolicyForAttempt,
  requestSessionTurnRecovery,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
} from "../src/index";
import * as schema from "../src/schema";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

const acceptedPolicy = TurnExecutionPolicyV1.parse({
  schemaVersion: 1,
  productModelId: "codex/gpt-5.6-sol",
  requestedModelId: "codex/gpt-5.6-sol",
  modelSource: "explicit",
  reasoningEffort: "xhigh",
  reasoningSource: "explicit",
  providerId: "codex-subscription",
  upstreamModelId: "gpt-5.6-sol",
  wireApi: "responses",
  credentialSource: {
    kind: "connected_subscription",
    provider: "codex",
  },
  billing: {
    upstreamPayer: "connected_subscription",
    metering: "external",
  },
  definitionVersion: `sha256:${"a".repeat(64)}`,
});

const replacementPolicy = TurnExecutionPolicyV1.parse({
  ...acceptedPolicy,
  definitionVersion: `sha256:${"b".repeat(64)}`,
});

type Fixture = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  sessionId: string;
  turnId: string;
  workflowId: string;
};

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("turn-execution-policy");
  if (!shared) {
    available = false;
    console.warn("[turn-execution-policy] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function fixture(metadata: Record<string, unknown> = {}): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `turn-policy-account-${suffix}`,
    accountName: "Turn execution policy test",
    workspaceExternalSource: "test",
    workspaceExternalId: `turn-policy-workspace-${suffix}`,
    workspaceName: "Turn execution policy test",
    subjectId: `turn-policy-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: acceptedPolicy.productModelId,
    sandboxBackend: "none",
  });
  const submitted = await withWorkspaceSubjectRls(
    client.db,
    grant.workspaceId!,
    grant.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "run with the accepted provider identity",
          resources: [],
          tools: [],
          model: acceptedPolicy.productModelId,
          reasoningEffort: acceptedPolicy.reasoningEffort,
          reasoningEffortFallback: "high",
          source: "user",
        }),
      ),
  );
  await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
    await db
      .update(schema.sessionTurns)
      .set({ metadata })
      .where(eq(schema.sessionTurns.id, submitted.turnId));
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    sessionId: session.id,
    turnId: submitted.turnId,
    workflowId: `session-${session.id}`,
  };
}

async function claim(
  value: Fixture,
  options: {
    attemptId?: string;
    trigger?: Parameters<typeof claimSessionWorkForAttempt>[2]["trigger"];
  } = {},
) {
  const attemptId = options.attemptId ?? crypto.randomUUID();
  const result = await claimSessionWorkForAttempt(client.db, value.workspaceId, {
    sessionId: value.sessionId,
    workflowId: value.workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: options.trigger ?? { kind: "next" },
  });
  if (result.action !== "claimed") {
    throw new Error(`Expected claimed turn, received ${result.reason}`);
  }
  return { attemptId, turn: result.turn };
}

async function install(
  value: Fixture,
  claimed: Awaited<ReturnType<typeof claim>>,
  policyForAbsent = acceptedPolicy,
) {
  return await installOrReadTurnExecutionPolicyForAttempt(client.db, {
    accountId: value.accountId,
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    executionGeneration: claimed.turn.executionGeneration,
    attemptId: claimed.attemptId,
    policyForAbsent,
  });
}

describe("OPE-12 accepted turn execution policy", () => {
  test("installs only when absent and preserves all prior metadata on replay", async () => {
    if (!available) return;
    const seededMetadata = {
      workerDeathRedispatches: 2,
      codexCredentialPolicyHash: `sha256:${"c".repeat(64)}`,
      recoveryPrivateState: { checkpoint: "preserve-me", sequence: 7 },
    };
    const value = await fixture(seededMetadata);
    const claimed = await claim(value);
    const metadataBeforeInstall = claimed.turn.metadata as Record<string, unknown>;

    const installed = await install(value, claimed);
    expect(installed).toMatchObject({ accepted: true, installed: true });
    if (!installed.accepted) throw new Error("expected accepted policy install");
    for (const [key, expected] of Object.entries(metadataBeforeInstall)) {
      expect((installed.turn.metadata as Record<string, unknown>)[key]).toEqual(expected);
    }
    expect(readTurnExecutionPolicyV1(installed.turn.metadata)).toEqual({
      kind: "valid",
      policy: acceptedPolicy,
    });

    const replayed = await install(value, claimed, replacementPolicy);
    expect(replayed).toMatchObject({
      accepted: true,
      installed: false,
      policy: acceptedPolicy,
    });
    if (!replayed.accepted) throw new Error("expected accepted policy replay");
    expect(readTurnExecutionPolicyV1(replayed.turn.metadata)).toEqual({
      kind: "valid",
      policy: acceptedPolicy,
    });
  });

  test("fails closed without replacing malformed present metadata", async () => {
    if (!available) return;
    const value = await fixture({ [TURN_EXECUTION_POLICY_METADATA_KEY]: null });
    const claimed = await claim(value);

    await expect(install(value, claimed)).rejects.toThrow(
      "Malformed turn execution policy metadata",
    );
    const stored = await getSessionTurn(client.db, value.workspaceId, value.turnId);
    expect((stored!.metadata as Record<string, unknown>)[TURN_EXECUTION_POLICY_METADATA_KEY]).toBe(
      null,
    );
  });

  test("rejects stale attempt and generation fences without installing", async () => {
    if (!available) return;
    const value = await fixture();
    const claimed = await claim(value);

    expect(
      await installOrReadTurnExecutionPolicyForAttempt(client.db, {
        accountId: value.accountId,
        workspaceId: value.workspaceId,
        sessionId: value.sessionId,
        turnId: value.turnId,
        executionGeneration: claimed.turn.executionGeneration,
        attemptId: crypto.randomUUID(),
        policyForAbsent: acceptedPolicy,
      }),
    ).toEqual({ accepted: false, reason: "attempt_changed" });
    expect(
      await installOrReadTurnExecutionPolicyForAttempt(client.db, {
        accountId: value.accountId,
        workspaceId: value.workspaceId,
        sessionId: value.sessionId,
        turnId: value.turnId,
        executionGeneration: claimed.turn.executionGeneration + 1,
        attemptId: claimed.attemptId,
        policyForAbsent: acceptedPolicy,
      }),
    ).toEqual({ accepted: false, reason: "generation_changed" });

    const stored = await getSessionTurn(client.db, value.workspaceId, value.turnId);
    expect(readTurnExecutionPolicyV1(stored!.metadata)).toEqual({ kind: "absent" });
  });

  test("preserves the accepted policy across approval and recovery attempts", async () => {
    if (!available) return;
    const value = await fixture();
    const first = await claim(value);
    expect(await install(value, first)).toMatchObject({ accepted: true, installed: true });

    expect(
      await applySessionTurnSettlement(client.db, value.workspaceId, {
        sessionId: value.sessionId,
        turnId: value.turnId,
        triggerEventId: first.turn.triggerEventId,
        attemptId: first.attemptId,
        turnStatus: "requires_action",
        sessionStatus: "requires_action",
        activeTurnId: value.turnId,
        events: [
          {
            type: "session.requiresAction",
            payload: { approvalId: "provider-policy-approval" },
          },
        ],
      }),
    ).toMatchObject({ action: "settled" });
    const [approval] = await appendSessionEvents(client.db, value.workspaceId, value.sessionId, [
      {
        type: "user.approvalDecision",
        turnId: value.turnId,
        payload: { approvalId: "provider-policy-approval", decision: "approve" },
      },
    ]);
    const approvalAttempt = await claim(value, {
      trigger: { kind: "approval", triggerEventId: approval!.id },
    });
    const approvalReplay = await install(value, approvalAttempt, replacementPolicy);
    expect(approvalReplay).toMatchObject({
      accepted: true,
      installed: false,
      policy: acceptedPolicy,
    });

    expect(
      await requestSessionTurnRecovery(client.db, value.workspaceId, {
        sessionId: value.sessionId,
        turnId: value.turnId,
        triggerEventId: approval!.id,
        attemptId: approvalAttempt.attemptId,
        reason: "worker_shutdown",
      }),
    ).toMatchObject({ action: "recovering" });
    const recoveredAttempt = await claim(value);
    const recoveryReplay = await install(value, recoveredAttempt, replacementPolicy);
    expect(recoveryReplay).toMatchObject({
      accepted: true,
      installed: false,
      policy: acceptedPolicy,
    });
  });

  test("preserves the accepted policy while the same turn waits for capacity", async () => {
    if (!available) return;
    const value = await fixture();
    const claimed = await claim(value);
    expect(await install(value, claimed)).toMatchObject({ accepted: true, installed: true });
    await ensureCodexRotationSettings(client.db, value.accountId, value.workspaceId);

    expect(
      await armCodexCapacityWait(client.db, {
        accountId: value.accountId,
        workspaceId: value.workspaceId,
        sessionId: value.sessionId,
        turnId: value.turnId,
        attemptId: claimed.attemptId,
        workflowId: value.workflowId,
        goalId: null,
        goalVersion: null,
        earliestResetAt: null,
        resetKind: "bounded_refresh",
        failurePayload: { code: "codex_usage_limit_reached" },
      }),
    ).toMatchObject({ action: "waiting" });

    const waiting = await getSessionTurn(client.db, value.workspaceId, value.turnId);
    expect(waiting).toMatchObject({ status: "waiting_capacity", activeAttemptId: null });
    expect(readTurnExecutionPolicyV1(waiting!.metadata)).toEqual({
      kind: "valid",
      policy: acceptedPolicy,
    });
  });
});
