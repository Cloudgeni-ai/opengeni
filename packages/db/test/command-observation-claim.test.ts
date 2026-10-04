import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { SessionBackgroundCommand } from "@opengeni/contracts";
import {
  submitHumanPromptInTransaction,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getActiveSessionHistoryItems,
  settleConnectedMachineSessionBackgroundCommand,
  withWorkspaceSessionActivityRls,
} from "../src/index";
import {
  getSessionBackgroundCommand,
  listSessionBackgroundCommands,
  backgroundCommandActivityForSessions,
  insertConnectedMachineSessionBackgroundCommandInTransaction,
  observeSessionBackgroundCommandCompletion,
  readSessionBackgroundCommandOutput,
} from "../src/session-background-commands";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("command-observation-claim");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(command = "printf output", terminal = true) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Command observation",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Command observation",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const sessionInput = {
    ...scope,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
  const session = await createSession(client.db, sessionInput);
  const identity = { ...scope, sessionId: session.id, commandId: crypto.randomUUID() };
  const provider = {
    controlWorkspaceId: scope.workspaceId,
    enrollmentId: crypto.randomUUID(),
    connectionInstanceId: crypto.randomUUID(),
    opId: crypto.randomUUID(),
  };
  await withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (db) =>
    insertConnectedMachineSessionBackgroundCommandInTransaction(db, {
      ...identity,
      ...provider,
      command,
    }),
  );
  if (terminal) {
    await settleConnectedMachineSessionBackgroundCommand(client.db, {
      ...identity,
      ...provider,
      outcome: "exited",
      exitCode: 0,
      reason: "process exited",
    });
  }
  return { identity, sessionInput, grant };
}

for (const outcome of ["provider_offline", "provider_error", "provider_running"] as const) {
  test(`connected diagnostics project ${outcome} without changing retained state`, async () => {
    const { identity } = await fixture("printf fixture", false);
    const dueAt = new Date("2030-01-01T01:00:00.000Z");
    const claimedAt = new Date("2030-01-01T00:00:00.000Z");
    await shared.admin`update session_background_commands set
      last_reconcile_outcome=${outcome},reconcile_attempts=3,reconcile_after=${dueAt},
      reconcile_claim_id=${crypto.randomUUID()},reconcile_claimed_at=${claimedAt}
      where id=${identity.commandId}`;
    const before =
      await shared.admin`select row_to_json(c) as value from session_background_commands c where id=${identity.commandId}`;
    const command = await getSessionBackgroundCommand(client.db, identity);
    expect(SessionBackgroundCommand.parse(command).reconciliation).toEqual({
      lastOutcome: outcome,
      attempts: 3,
      dueAt: dueAt.toISOString(),
      claimedAt: claimedAt.toISOString(),
      terminalProof: null,
    });
    expect(command?.state).toBe("running");
    expect(command?.observationStatus).toBe(
      outcome === "provider_running" ? undefined : "unavailable",
    );
    expect(
      await listSessionBackgroundCommands(client.db, { ...identity, activeOnly: true }),
    ).toEqual([command!]);
    const activity = await backgroundCommandActivityForSessions(client.db, {
      ...identity,
      sessionIds: [identity.sessionId],
    });
    expect(activity.get(identity.sessionId)).toEqual({
      state: "running",
      count: 1,
      ...(outcome === "provider_running" ? {} : { unavailableCount: 1 }),
    });
    const after =
      await shared.admin`select row_to_json(c) as value from session_background_commands c where id=${identity.commandId}`;
    expect(Array.from(after)).toEqual(Array.from(before));
    expect(command).not.toHaveProperty("opId");
    expect(command).not.toHaveProperty("connectionInstanceId");
    expect(command?.reconciliation).not.toHaveProperty("claimId");
  });
}

for (const outcome of ["exited", "lost"] as const) {
  test(`checkpointed ${outcome} proof does not claim command settlement or observation`, async () => {
    const { identity } = await fixture("printf fixture", false);
    const observedAt = new Date("2030-01-01T00:00:00.000Z");
    await shared.admin`update session_background_commands set state='stopping',
      cancel_requested_at=${observedAt},cancel_requested_by='fixture-owner',
      last_reconcile_outcome='settlement_failed',reconcile_proof_outcome=${outcome},
      reconcile_proof_exit_code=${outcome === "exited" ? 7 : null},
      reconcile_proof_reason='fixture proof detail',reconcile_proof_observed_at=${observedAt}
      where id=${identity.commandId}`;
    const command = SessionBackgroundCommand.parse(
      await getSessionBackgroundCommand(client.db, identity),
    );
    expect(command.reconciliation?.terminalProof).toEqual(
      outcome === "exited"
        ? { outcome, exitCode: 7, observedAt: observedAt.toISOString() }
        : { outcome, exitCode: null, observedAt: observedAt.toISOString() },
    );
    expect(command).toMatchObject({
      state: "stopping",
      exitCode: null,
      settledAt: null,
      completionObservedAt: null,
    });
    expect(command.observationStatus).toBeUndefined();
    expect(command.reconciliation).not.toHaveProperty("reason");
    expect(JSON.stringify(command.reconciliation)).not.toContain("fixture proof detail");
  });
}

test("legacy diagnostic text stays private and another session cannot read checkpoints", async () => {
  const { identity, sessionInput } = await fixture("printf fixture", false);
  await shared.admin`update session_background_commands set last_reconcile_outcome='fixture diagnostic: text' where id=${identity.commandId}`;
  const command = await getSessionBackgroundCommand(client.db, identity);
  expect(command?.reconciliation?.lastOutcome).toBe("unknown");
  const sibling = await createSession(client.db, sessionInput);
  const other = { ...identity, sessionId: sibling.id };
  expect(await getSessionBackgroundCommand(client.db, other)).toBeNull();
  expect(await listSessionBackgroundCommands(client.db, other)).toEqual([]);
});

test("terminal diagnostic GETs leave completion observation and pending notice unchanged", async () => {
  const { identity } = await fixture();
  await shared.admin`update session_background_commands set last_reconcile_outcome='provider_offline' where id=${identity.commandId}`;
  const command = await getSessionBackgroundCommand(client.db, identity);
  expect(command?.reconciliation?.lastOutcome).toBe("provider_offline");
  expect(command?.observationStatus).toBeUndefined();
  expect(command?.completionObservedAt).toBeNull();
  expect(await listSessionBackgroundCommands(client.db, { ...identity, activeOnly: true })).toEqual(
    [],
  );
  const [notice] =
    await shared.admin`select state from session_system_updates where source_id=${identity.commandId}`;
  expect(notice?.state).toBe("pending");
});

test("command reads preserve exact text and safely bound unicode previews", async () => {
  for (const command of ["printf 'two  spaces'\n\tprintf done", `printf '${"😀".repeat(300)}'`]) {
    const { identity } = await fixture(command);
    const stored = await getSessionBackgroundCommand(client.db, identity);
    expect(stored?.commandText).toBe(command);
    expect(stored!.commandPreview.length).toBeLessThanOrEqual(512);
    if (command.length > 512) {
      expect(stored!.commandPreview.endsWith("…")).toBe(true);
      expect(stored!.commandPreview).not.toMatch(/[\uD800-\uDBFF]…$/);
    } else {
      expect(stored!.commandPreview).toBe(command);
    }
  }
});

test("terminal reads preserve notification and history delivered by the ordinary claim API", async () => {
  const { identity, grant } = await fixture();
  // The terminal notice rides eligible new input; it does not itself wake idle.
  await withWorkspaceSessionActivityRls(client.db, identity.workspaceId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Inspect the command result",
        resources: [],
        source: "user",
        reasoningEffortFallback: "medium",
      }),
    ),
  );
  const claim = await claimSessionWorkForAttempt(client.db, identity.workspaceId, {
    sessionId: identity.sessionId,
    workflowId: `session-${identity.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(claim.action).toBe("claimed");
  const updates = () => shared.admin`
    select * from session_system_updates where workspace_id = ${identity.workspaceId}
      and session_id = ${identity.sessionId} and source_id = ${identity.commandId}`;
  const before = await updates();
  expect(before).toHaveLength(1);
  expect(before[0]!.state).toBe("delivered");
  expect(before[0]!.delivered_history_item_id).not.toBeNull();
  const history = await getActiveSessionHistoryItems(
    client.db,
    identity.workspaceId,
    identity.sessionId,
  );
  expect(history.length).toBeGreaterThan(0);
  expect(JSON.stringify(history)).toContain(identity.commandId);
  const first = await readSessionBackgroundCommandOutput(client.db, identity);
  expect(first).toMatchObject({ terminal: true, state: "exited", exitCode: 0 });
  expect(first.completionObservedAt).toEqual(expect.any(String));
  expect(await readSessionBackgroundCommandOutput(client.db, identity)).toEqual(first);
  await observeSessionBackgroundCommandCompletion(client.db, identity);
  expect(await updates()).toEqual(before);
  expect(
    await getActiveSessionHistoryItems(client.db, identity.workspaceId, identity.sessionId),
  ).toEqual(history);
});

test("an existing sibling session cannot read or acknowledge another session's command", async () => {
  const { identity, sessionInput } = await fixture();
  const sibling = await createSession(client.db, sessionInput);
  const wrong = { ...identity, sessionId: sibling.id };
  await expect(readSessionBackgroundCommandOutput(client.db, wrong)).rejects.toThrow("not found");
  expect(await observeSessionBackgroundCommandCompletion(client.db, wrong)).toBeNull();
  expect(await getSessionBackgroundCommand(client.db, wrong)).toBeNull();
  expect((await getSessionBackgroundCommand(client.db, identity))?.completionObservedAt).toBeNull();
  const rows = await shared.admin`
    select state from session_system_updates where workspace_id = ${identity.workspaceId}
      and session_id = ${identity.sessionId} and source_id = ${identity.commandId}`;
  expect(rows).toMatchObject([{ state: "pending" }]);
});
