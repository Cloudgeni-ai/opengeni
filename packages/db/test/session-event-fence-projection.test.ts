import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  appendSessionEventsAndUpdateSession,
  appendSessionEventsForTurnAttempt,
  appendSessionHistoryItems,
  attachOpenSuffixToPendingToolCalls,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createEnrollment,
  createSession,
  getSession,
  listTurnOpenSuffixToolCalls,
  markSessionTurnModelTransportHttpOnly,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  registerPendingSessionToolCall,
  setSessionLastInputTokensForTurnAttempt,
  lockTurnAttemptWriteFenceTx,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
} from "../src/index";
import {
  claimConnectedCommandOutputCollection,
  claimConnectedCommandOutputReleases,
  recordConnectedCommandOutputConsumption,
  recordConnectedCommandOutputRelease,
  returnConnectedCommandOutputCollection,
  settleConnectedCommandOutputReleaseClaim,
} from "../src/session-background-commands";
import { submitTestHumanPrompt } from "../../../test/integration/helpers/session-control";
import type { SessionEventMutation } from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("event-fence-projection");
  if (!acquired) throw new Error("Restricted PostgreSQL fixture required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 1 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function fixture(withParent = false) {
  const id = crypto.randomUUID();
  const {
    workspaceGrants: [grant],
  } = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Fence projection",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Fence projection",
    subjectId: id,
  });
  if (!grant) throw new Error("Missing fixture grant");
  const parent = withParent
    ? await createSession(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        initialMessage: "Parent",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      })
    : undefined;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ...(parent ? { parentSessionId: parent.id } : {}),
    initialMessage: "exact input",
    instructions: "full-row caller instructions",
    resources: [],
    metadata: { retained: "session metadata" },
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await submitTestHumanPrompt(client.db, {
    ...grant,
    sessionId: session.id,
    text: "exact prompt",
    resources: [],
    tools: [],
    reasoningEffortFallback: "medium",
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    attemptId,
    dispatchId: crypto.randomUUID(),
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Missing fixture claim");
  return {
    subjectId: grant.subjectId,
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    executionGeneration: claim.turn.executionGeneration,
    attemptId,
  };
}

test("compact and full projections use identical fence decisions; full callers retain their rows", async () => {
  const input = await fixture();
  for (const sessionLock of ["no_key_update", "key_share"] as const) {
    await withWorkspaceRls(client.db, input.workspaceId, async (tx) => {
      const full = await lockTurnAttemptWriteFenceTx(tx, { ...input, sessionLock });
      const narrow = await lockTurnAttemptWriteFenceTx(tx, {
        ...input,
        sessionLock,
        rowProjection: "event",
      });
      expect(full.allowed).toBe(true);
      expect(narrow.allowed).toBe(true);
      if (!full.allowed || !narrow.allowed) throw new Error("Fixture fence rejected");
      for (const name of ["workspace", "session", "turn", "attempt"] as const) {
        for (const key of Object.keys(narrow[name])) {
          expect((narrow[name] as unknown as Record<string, unknown>)[key]).toEqual(
            (full[name] as unknown as Record<string, unknown>)[key],
          );
        }
        expect(Object.keys(narrow[name]).length).toBeLessThan(Object.keys(full[name]).length);
      }
      expect(full.session.instructions).toBe("full-row caller instructions");
      expect(full.turn.prompt).toBe("exact prompt");
      expect(full.attempt.mcpApprovalPolicies).toBeDefined();
      expect(narrow.session).not.toHaveProperty("instructions");
      expect(narrow.turn).not.toHaveProperty("prompt");
      expect(narrow.attempt).not.toHaveProperty("mcpApprovalPolicies");
    });
  }
  for (const changed of [
    { executionGeneration: input.executionGeneration + 1 },
    { sessionId: crypto.randomUUID() },
    { turnId: crypto.randomUUID() },
    { attemptId: crypto.randomUUID() },
  ]) {
    await withWorkspaceRls(client.db, input.workspaceId, async (tx) => {
      const full = await lockTurnAttemptWriteFenceTx(tx, { ...input, ...changed });
      const narrow = await lockTurnAttemptWriteFenceTx(tx, {
        ...input,
        ...changed,
        rowProjection: "event",
      });
      expect(full.allowed).toBe(false);
      expect(narrow.allowed).toBe(false);
      if (full.allowed || narrow.allowed) throw new Error("Incorrect attempt admitted");
      expect(narrow.reason).toBe(full.reason);
    });
  }
});

test("only NO KEY UPDATE roots reuse their locked control row", async () => {
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  for (const withParent of [false, true]) {
    const input = await fixture(withParent);
    for (const rowProjection of ["full", "event"] as const) {
      for (const sessionLock of ["no_key_update", "key_share"] as const) {
        const queries: string[] = [];
        driver.options.debug = (_connection, query) => queries.push(query);
        try {
          await withWorkspaceRls(client.db, input.workspaceId, async (tx) => {
            const options = { ...input, sessionLock };
            const result =
              rowProjection === "event"
                ? await lockTurnAttemptWriteFenceTx(tx, { ...options, rowProjection })
                : await lockTurnAttemptWriteFenceTx(tx, options);
            expect(result.allowed).toBe(true);
          });
          expect(queries.filter((query) => query.includes("ancestry as"))).toHaveLength(
            withParent || sessionLock === "key_share" ? 1 : 0,
          );
        } finally {
          driver.options.debug = false;
        }
      }
    }
  }
});

test("root fences retain live pause precedence, resume overrides and interruption rejection", async () => {
  const input = await fixture();
  const compare = async () =>
    withWorkspaceRls(client.db, input.workspaceId, async (tx) => {
      const reference = await lockTurnAttemptWriteFenceTx(tx, {
        ...input,
        sessionLock: "key_share",
      });
      for (const rowProjection of ["full", "event"] as const) {
        const reused =
          rowProjection === "event"
            ? await lockTurnAttemptWriteFenceTx(tx, { ...input, rowProjection })
            : await lockTurnAttemptWriteFenceTx(tx, input);
        expect(reused.allowed).toBe(reference.allowed);
        if (!reused.allowed && !reference.allowed) expect(reused.reason).toBe(reference.reason);
      }
    });
  await compare();
  for (const [target, action] of [
    ["workspace", "pause"],
    ["session", "resume"],
    ["workspace", "pause"],
    ["workspace", "resume"],
    ["session", "pause"],
    ["session", "resume"],
  ] as const) {
    await withWorkspaceSessionActivityRls(client.db, input.workspaceId, async (tx) => {
      const command = {
        ...input,
        actor: { type: "human" as const, subjectId: input.subjectId },
        operationKey: crypto.randomUUID(),
        action,
      };
      if (target === "workspace") await mutateWorkspaceControlInTransaction(tx, command);
      else await mutateSessionControlInTransaction(tx, command);
    });
    await compare();
  }
});

test("the reused root row cannot change until its write fence releases the transaction", async () => {
  const input = await fixture();
  await withWorkspaceRls(client.db, input.workspaceId, async (tx) => {
    expect(
      (await lockTurnAttemptWriteFenceTx(tx, { ...input, rowProjection: "event" })).allowed,
    ).toBe(true);
    await expect(
      shared.admin.begin(async (sql) => {
        await sql`set local lock_timeout = '50ms'`;
        await sql`update sessions set control_version = control_version + 1 where id = ${input.sessionId}`;
      }),
    ).rejects.toMatchObject({ code: "55P03" });
  });
  // The failed contender has rolled back; neither connection retains a lock.
  await shared.admin.begin(async (sql) => {
    await sql`set local lock_timeout = '500ms'`;
    await sql`update sessions set control_version = control_version + 1 where id = ${input.sessionId}`;
  });
});

test("identity-only mutations use the narrow fence and still reject a replaced attempt", async () => {
  const input = await fixture();
  const callId = crypto.randomUUID();
  await registerPendingSessionToolCall(client.db, {
    ...input,
    callId,
    callType: "function_call",
    callItem: { type: "function_call", callId, name: "effect", arguments: "{}" },
  });
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const queries: string[] = [];
  driver.options.debug = (_connection, query) => queries.push(query);
  try {
    for (const valid of [true, false]) {
      const attemptId = valid ? input.attemptId : crypto.randomUUID();
      const fencedInput = {
        ...input,
        attemptId,
        expectedAttemptId: attemptId,
        expectedExecutionGeneration: input.executionGeneration,
      };
      queries.length = 0;
      expect(
        await appendSessionHistoryItems(client.db, {
          ...fencedInput,
          items: [
            {
              position: 100,
              item: { type: "message", role: "assistant", content: "retained bytes" },
            },
          ],
        }),
      ).toBe(valid);
      expect(
        await setSessionLastInputTokensForTurnAttempt(client.db, {
          ...fencedInput,
          lastInputTokens: valid ? 42 : 999,
        }),
      ).toBe(valid);
      expect(await markSessionTurnModelTransportHttpOnly(client.db, fencedInput)).toBe(valid);
      expect(
        await attachOpenSuffixToPendingToolCalls(client.db, {
          ...fencedInput,
          members: [
            {
              callId,
              interruptionKind: "human_input",
              reasoningItems: [{ type: "reasoning", id: "exact" }],
            },
          ],
        }),
      ).toEqual({ accepted: valid, attached: valid ? 1 : 0 });
      const locks = queries.filter(
        (query) =>
          /from "(?:sessions|session_turns|session_turn_attempts)"/.test(query) &&
          /for (?:no key update|update)/.test(query),
      );
      expect(locks.length).toBeGreaterThanOrEqual(12);
      for (const query of locks) {
        expect(query).not.toContain('"instructions"');
        expect(query).not.toContain('"prompt"');
        expect(query).not.toContain('"mcp_approval_policies"');
      }
    }
    expect((await getSession(client.db, input.workspaceId, input.sessionId))?.lastInputTokens).toBe(
      42,
    );
    const suffix = await listTurnOpenSuffixToolCalls(
      client.db,
      input.workspaceId,
      input.sessionId,
      input.turnId,
    );
    expect(suffix[0]?.tiedReasoningItems).toEqual([{ type: "reasoning", id: "exact" }]);
  } finally {
    driver.options.debug = false;
  }
});

test("connected-command output custody writers lock only their exact command row", async () => {
  const input = await fixture();
  const enrollment = await createEnrollment(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    pubkey: `ed25519:${crypto.randomUUID()}`,
  });
  await shared.admin`update enrollments set connection_instance_id = 'launch',
    connection_lease_expires_at = now() + interval '1 hour' where id = ${enrollment.id}`;
  const opId = crypto.randomUUID();
  const [inserted] = await shared.admin<{ id: string }[]>`
    insert into session_background_commands (account_id, workspace_id, session_id, provider, state,
      control_workspace_id, enrollment_id, connection_instance_id, op_id, exit_code,
      settlement_reason, settled_at, reconcile_after)
    values (${input.accountId}, ${input.workspaceId}, ${input.sessionId}, 'connected_machine',
      'exited', ${input.workspaceId}, ${enrollment.id}, 'launch', ${opId}, 0, 'op_exit', now(),
      '2000-01-01T00:00:00Z'::timestamptz)
    returning id`;
  const identity = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    commandId: inserted!.id,
    controlWorkspaceId: input.workspaceId,
    enrollmentId: enrollment.id,
    connectionInstanceId: "launch",
    opId,
  };
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const queries: string[] = [];
  driver.options.debug = (_connection, query) => queries.push(query);
  try {
    const collectionClaim = crypto.randomUUID();
    expect(
      await claimConnectedCommandOutputCollection(client.db, {
        ...identity,
        claimId: collectionClaim,
      }),
    ).toBe(true);
    expect(
      await claimConnectedCommandOutputCollection(client.db, {
        ...identity,
        claimId: crypto.randomUUID(),
      }),
    ).toBe(false);
    await returnConnectedCommandOutputCollection(client.db, {
      ...identity,
      claimId: collectionClaim,
    });
    await recordConnectedCommandOutputConsumption(client.db, {
      ...identity,
      receipt: { exitSeq: "7", attachGeneration: "3" },
      exitCode: 0,
    });
    const [claim] = await claimConnectedCommandOutputReleases(client.db, {
      claimId: crypto.randomUUID(),
      limit: 1,
      claimTtlMs: 60_000,
    });
    expect(claim?.commandId).toBe(identity.commandId);
    expect(claim?.receipt).toEqual({ exitSeq: "7", attachGeneration: "3" });
    expect(
      await settleConnectedCommandOutputReleaseClaim(client.db, {
        claim: claim!,
        outcome: "published",
        retryAfterMs: 30_000,
      }),
    ).toBe(true);
    // The claim is gone once settled: the same claim cannot settle twice.
    expect(
      await settleConnectedCommandOutputReleaseClaim(client.db, {
        claim: claim!,
        outcome: "published",
        retryAfterMs: 30_000,
      }),
    ).toBe(false);
    expect(
      await recordConnectedCommandOutputRelease(client.db, { ...identity, exitSeq: "8" }),
    ).toBe(false);
    expect(
      await recordConnectedCommandOutputRelease(client.db, { ...identity, exitSeq: "7" }),
    ).toBe(true);
    expect(
      await recordConnectedCommandOutputRelease(client.db, { ...identity, exitSeq: "7" }),
    ).toBe(false);

    // Custody bookkeeping touches only its exact exited command row: no
    // session, cursor or workspace row lock and no workspace-control fence.
    const prefixLocks = queries.filter(
      (query) =>
        /from "(?:sessions|session_event_cursors|workspaces|workspace_inference_controls)"/.test(
          query,
        ) && /for (?:key share|share|no key update|update)/.test(query),
    );
    expect(prefixLocks).toEqual([]);
    // The workspace-control and Site admission fences are standalone advisory
    // statements; the scope's own tenancy setup statement is unchanged.
    expect(queries.filter((query) => /^\s*select pg_advisory_xact_lock/i.test(query))).toEqual([]);
  } finally {
    driver.options.debug = false;
  }
  const [row] = await shared.admin<
    {
      output_exit_seq: string;
      output_release_observed_at: Date | null;
      reconcile_claim_id: string | null;
      last_reconcile_outcome: string;
    }[]
  >`select output_exit_seq, output_release_observed_at, reconcile_claim_id, last_reconcile_outcome
    from session_background_commands where id = ${identity.commandId}`;
  expect(row?.output_exit_seq).toBe("7");
  expect(row?.output_release_observed_at).not.toBeNull();
  expect(row?.reconcile_claim_id).toBeNull();
  expect(row?.last_reconcile_outcome).toBe("output_released");
});

test("custody bookkeeping does not queue behind a session's event writer or a control mutation, and stays exactly-once", async () => {
  const input = await fixture();
  const enrollment = await createEnrollment(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    pubkey: `ed25519:${crypto.randomUUID()}`,
  });
  await shared.admin`update enrollments set connection_instance_id = 'launch',
    connection_lease_expires_at = now() + interval '1 hour' where id = ${enrollment.id}`;
  const opId = crypto.randomUUID();
  const [inserted] = await shared.admin<{ id: string }[]>`
    insert into session_background_commands (account_id, workspace_id, session_id, provider, state,
      control_workspace_id, enrollment_id, connection_instance_id, op_id, exit_code,
      settlement_reason, settled_at, reconcile_after)
    values (${input.accountId}, ${input.workspaceId}, ${input.sessionId}, 'connected_machine',
      'exited', ${input.workspaceId}, ${enrollment.id}, 'launch', ${opId}, 0, 'op_exit', now(),
      '2000-01-01T00:00:00Z'::timestamptz)
    returning id`;
  const identity = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    commandId: inserted!.id,
    controlWorkspaceId: input.workspaceId,
    enrollmentId: enrollment.id,
    connectionInstanceId: "launch",
    opId,
  };
  const pool = createDb(shared.appUrl, { max: 8 });
  let release!: () => void;
  const released = new Promise<void>((done) => (release = done));
  let held!: () => void;
  const holding = new Promise<void>((done) => (held = done));
  // A Pause-shaped holder: exclusive workspace control plus the session's
  // semantic event-write rows, held open while custody bookkeeping runs.
  const holder = shared.admin.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-control:${input.workspaceId}`}, 0))`;
    await sql`select id from sessions where id = ${input.sessionId} for no key update`;
    await sql`select session_id from session_event_cursors where session_id = ${input.sessionId} for update`;
    held();
    await released;
  });
  try {
    await holding;
    const within = <T>(work: Promise<T>) =>
      Promise.race([
        work,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("custody write queued behind the session")), 15_000),
        ),
      ]);
    // Racing collection claims on the same output: exactly one owner.
    const claims = await within(
      Promise.all(
        Array.from({ length: 6 }, () =>
          claimConnectedCommandOutputCollection(pool.db, {
            ...identity,
            claimId: crypto.randomUUID(),
          }),
        ),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    await within(
      recordConnectedCommandOutputConsumption(pool.db, {
        ...identity,
        receipt: { exitSeq: "11", attachGeneration: "2" },
        exitCode: 0,
      }),
    );
    // Idempotent retry of the same receipt; a changed frontier is refused.
    await within(
      recordConnectedCommandOutputConsumption(pool.db, {
        ...identity,
        receipt: { exitSeq: "11", attachGeneration: "2" },
        exitCode: 0,
      }),
    );
    await expect(
      recordConnectedCommandOutputConsumption(pool.db, {
        ...identity,
        receipt: { exitSeq: "12", attachGeneration: "2" },
        exitCode: 0,
      }),
    ).rejects.toThrow("changed its durable exit frontier");
    const releases = await within(
      Promise.all(
        Array.from({ length: 6 }, () =>
          recordConnectedCommandOutputRelease(pool.db, { ...identity, exitSeq: "11" }),
        ),
      ),
    );
    expect(releases.filter(Boolean)).toHaveLength(1);
  } finally {
    release();
    await holder;
    await pool.close();
  }
  const [row] = await shared.admin<
    { output_exit_seq: string; output_release_observed_at: Date | null }[]
  >`select output_exit_seq, output_release_observed_at
    from session_background_commands where id = ${identity.commandId}`;
  expect(row?.output_exit_seq).toBe("11");
  expect(row?.output_release_observed_at).not.toBeNull();
});

test("generic event writers retain payloads, sequence and explicit updates without reading frozen inputs", async () => {
  const input = await fixture();
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const queries: string[] = [];
  driver.options.debug = (_connection, query) => queries.push(query);
  try {
    let previous = 0;
    for (const type of ["agent.message.delta", "agent.message.completed"] as const) {
      for (const update of [false, true]) {
        queries.length = 0;
        const events = [
          {
            type,
            payload: { text: "exact generic bytes\u0000😀" },
            turnId: input.turnId,
            turnGeneration: input.executionGeneration,
            turnAttemptId: input.attemptId,
          },
        ];
        const saved = update
          ? await appendSessionEventsAndUpdateSession(
              client.db,
              input.workspaceId,
              input.sessionId,
              events,
              { metadata: { generic: type } },
            )
          : await appendSessionEvents(client.db, input.workspaceId, input.sessionId, events);
        expect(saved).toHaveLength(1);
        expect(saved[0]!.payload).toEqual(events[0]!.payload);
        expect(saved[0]!.sequence).toBeGreaterThan(previous);
        if (previous) expect(saved[0]!.sequence).toBe(previous + 1);
        previous = saved[0]!.sequence;
        const locks = queries.filter(
          (query) =>
            /from "(?:sessions|session_turns|session_turn_attempts|workspaces)"/.test(query) &&
            /for (?:key share|no key update|update)/.test(query),
        );
        expect(locks.length).toBeGreaterThanOrEqual(4);
        for (const query of locks) {
          expect(query).not.toContain('"instructions"');
          expect(query).not.toContain('"initial_message"');
          expect(query).not.toContain('"prompt"');
          expect(query).not.toContain('"mcp_approval_policies"');
        }
        if (update)
          expect(
            (await getSession(client.db, input.workspaceId, input.sessionId))?.metadata,
          ).toEqual({ generic: type });
      }
    }
    await expect(
      appendSessionEvents(client.db, input.workspaceId, crypto.randomUUID(), [
        { type: "agent.message.completed", payload: {} },
      ]),
    ).rejects.toThrow("Session not found");
  } finally {
    driver.options.debug = false;
  }
});

test("plain appends omit wide frozen columns but mutation callbacks retain the public contract", async () => {
  const input = await fixture();
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const queries: string[] = [];
  driver.options.debug = (_connection, query) => queries.push(query);
  try {
    for (const type of ["agent.message.delta", "agent.message.completed"] as const) {
      queries.length = 0;
      const result = await appendSessionEventsForTurnAttempt(
        client.db,
        input.workspaceId,
        input.sessionId,
        input.turnId,
        input.executionGeneration,
        input.attemptId,
        [{ type, payload: { text: "unchanged bytes" } }],
      );
      expect(result.accepted).toBe(true);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]!.payload).toEqual({ text: "unchanged bytes" });
      const sessionReads = queries.filter(
        (query) => /from "sessions"/.test(query) && /for (?:key share|no key update)/.test(query),
      );
      expect(sessionReads).toHaveLength(type === "agent.message.delta" ? 2 : 1);
      for (const query of sessionReads) {
        expect(query).not.toContain('"instructions"');
        expect(query).not.toContain('"initial_message"');
        expect(query).toContain('"execution_authority_epoch"');
      }
    }
    let invoked = false;
    const result = await appendSessionEventsForTurnAttempt(
      client.db,
      input.workspaceId,
      input.sessionId,
      input.turnId,
      input.executionGeneration,
      input.attemptId,
      [{ type: "agent.message.completed", payload: { text: "callback bytes" } }],
      undefined,
      async (_tx, fence) => {
        expect(fence.allowed).toBe(true);
        if (!fence.allowed) return false;
        expect(fence.session.instructions).toBe("full-row caller instructions");
        expect(fence.turn.prompt).toBe("exact prompt");
        expect(fence.attempt.mcpApprovalPolicies).toBeDefined();
        invoked = true;
        return true;
      },
    );
    expect(invoked).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.events[0]!.payload).toEqual({ text: "callback bytes" });
  } finally {
    driver.options.debug = false;
  }
});

test("explicit checkpoint projections preserve accepted and rejected callback decisions without wide reads", async () => {
  const input = await fixture();
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const queries: string[] = [];
  driver.options.debug = (_connection, query) => queries.push(query);
  try {
    for (const type of ["agent.message.delta", "agent.message.completed"] as const) {
      for (const stale of [false, true]) {
        queries.length = 0;
        let invoked = false;
        const mutate: SessionEventMutation<"event"> = async (_tx, fence) => {
          invoked = true;
          expect(fence.allowed).toBe(!stale);
          expect(fence.session).not.toHaveProperty("instructions");
          expect(fence.turn).not.toHaveProperty("prompt");
          expect(fence.attempt).not.toHaveProperty("mcpApprovalPolicies");
          if (!fence.allowed) expect(fence.reason).toBe("generation_changed");
          return fence.allowed;
        };
        const result = await appendSessionEventsForTurnAttempt(
          client.db,
          input.workspaceId,
          input.sessionId,
          input.turnId,
          input.executionGeneration + (stale ? 1 : 0),
          input.attemptId,
          [{ type, payload: { text: "exact checkpoint bytes" } }],
          undefined,
          { rowProjection: "event", mutate },
        );
        expect(invoked).toBe(true);
        expect(result.accepted).toBe(!stale);
        expect(result.events).toHaveLength(stale ? 0 : 1);
        if (!stale) expect(result.events[0]!.payload).toEqual({ text: "exact checkpoint bytes" });
        const sessionReads = queries.filter(
          (query) => /from "sessions"/.test(query) && /for (?:key share|no key update)/.test(query),
        );
        expect(sessionReads.length).toBeGreaterThan(0);
        for (const query of sessionReads) {
          expect(query).not.toContain('"instructions"');
          expect(query).not.toContain('"initial_message"');
          expect(query).toContain('"execution_authority_epoch"');
        }
      }
    }
  } finally {
    driver.options.debug = false;
  }
});
