import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { eq, sql } from "drizzle-orm";
import {
  abandonSandboxJournalOperation,
  abandonUnboundSandboxJournalControl,
  allocateSandboxJournalOperation,
  allocateSandboxV2BackgroundOperation,
  acquireSandboxMachineForAttempt,
  applySessionTurnSettlement,
  assertSandboxJournalCommand,
  bootstrapWorkspace,
  captureSandboxJournalOutput,
  claimSessionWorkForAttempt,
  compareAndSetSandboxMachine,
  commitSessionAttemptQuiescence,
  encryptEnvironmentValue,
  retainSandboxV2CredentialGeneration,
  configureSandboxV2AdmissionPolicy,
  createDb,
  createSession,
  createSessionWithIdempotencyKey,
  deleteSessionTreeIfQuiescent,
  findSandboxMachine,
  getSessionTurn,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  loadSandboxJournalCommand,
  nestedPostgresSqlState,
  recordSandboxJournalControlProof,
  reserveSandboxJournalCommand,
  reserveSandboxJournalInput,
  releaseRevokedSandboxMachineAttempt,
  loadSandboxJournalCapturedOutput,
  listPendingSandboxJournalCommands,
  listSandboxMachineAttemptOwners,
  readSandboxJournalControlOwner,
  readSandboxJournalAttemptWriters,
  assertSandboxJournalControl,
  assertSandboxV2BackgroundCommandControl,
  loadSandboxV2BackgroundCommandForControl,
  abandonUnboundSandboxV2BackgroundCommand,
  captureSandboxV2BackgroundCommandOutput,
  captureSandboxV2BackgroundCommandOutputWithEvents,
  settleSandboxV2BackgroundCommand,
  retainSandboxV2CredentialCleanupIntent,
  loadSandboxV2CredentialCleanupForControl,
  findSandboxV2CredentialCleanupAuthority,
  reserveSandboxV2CredentialCleanupCommand,
  assertSandboxV2CredentialCleanupCommand,
  settleSandboxV2CredentialCleanup,
  settleSandboxJournalControl,
  submitHumanPromptInTransaction,
  setSubjectRlsContext,
  updateOrganizationPrivateSessionSettings,
  updateWorkspaceSettings,
  withWorkspaceSubjectSessionActivityRls,
  type SessionActivityDatabase,
  type SandboxJournalTurnAuthority,
} from "../src";
import { withRlsContext } from "../src/database";
import {
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
} from "../src/session-control";
import { sessionAttemptPendingWritersSql } from "../src/session-attempt-writers";
import {
  getSessionBackgroundCommand,
  readSessionBackgroundCommandOutput,
  requestSessionBackgroundCommandCancellation,
} from "../src/session-background-commands";
import {
  sandboxV2Commands,
  sandboxV2CommandOutput,
  sandboxV2CredentialCleanup,
} from "../src/sandbox-v2-schema";
import {
  decodeSandboxJournalPage,
  type SandboxJournalCommand,
  type SandboxJournalObservation,
} from "@opengeni/contracts";

let fixture: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("sandbox-v2-commands");
  if (!acquired) throw Error("Journal authority requires disposable PostgreSQL");
  fixture = acquired;
  client = createDb(fixture.appUrl);
  configureSandboxV2AdmissionPolicy(client.db, {
    enabled: true,
    qualifiedBackends: new Set(["docker"]),
  });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 60_000);
async function owned(privateSession = false) {
  const suffix = crypto.randomUUID();
  let grant: { accountId: string; workspaceId: string | null; subjectId: string };
  if (privateSession) {
    const userId = `journal-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const human = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Synthetic private journal owner",
    });
    const personal = human.workspaceGrants.find(
      (item) => item.workspaceId !== human.defaultWorkspaceId,
    );
    if (!personal) throw Error("Synthetic owner lacks a personal workspace");
    grant = { accountId: personal.accountId, workspaceId: personal.workspaceId, subjectId };
    await fixture.admin`insert into session_tenancy_activations
      (account_id,activation_version,inventory_digest,parity_digest,activated_by)
      values (${grant.accountId},1,${"0".repeat(64)},${"1".repeat(64)},'database-test')
      on conflict (account_id) do nothing`;
    const settings = await getOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: subjectId,
    });
    if (!settings.enabled)
      await updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: grant.accountId,
        actorSubjectId: subjectId,
        enabled: true,
        expectedVersion: settings.version,
        operationId: crypto.randomUUID(),
      });
  } else {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Synthetic journal",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Synthetic journal",
      subjectId: `subject-${suffix}`,
    });
    grant = access.workspaceGrants[0]!;
  }
  const workspaceId = grant.workspaceId!;
  await updateWorkspaceSettings(client.db, workspaceId, {
    sandboxV2Enabled: true,
  });
  const sessionOptions = {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "docker" as const,
  };
  const session = privateSession
    ? (
        await createSessionWithIdempotencyKey(client.db, {
          ...sessionOptions,
          visibility: "user_private",
          createdBy: { kind: "subject", subjectId: grant.subjectId },
          subjectId: grant.subjectId,
          createIdempotencyKey: crypto.randomUUID(),
        })
      ).session
    : await createSession(client.db, sessionOptions);
  await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as SessionActivityDatabase, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "synthetic work",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw Error("Synthetic attempt not claimed");
  const machine = await findSandboxMachine(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sandboxGroupId: session.sandboxGroupId,
  });
  if (!machine) throw Error("Synthetic group not admitted");
  const instance = {
    id: "synthetic-instance",
    bootId: "a".repeat(64),
    diskLineage: crypto.randomUUID(),
  };
  expect(
    await compareAndSetSandboxMachine(client.db, grant.accountId, machine, {
      ...machine,
      version: machine.version + 1,
      state: "running",
      target: "running",
      instance,
    }),
  ).toBe(true);
  const context: SandboxJournalTurnAuthority = {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: claimed.turn.id,
    executionGeneration: claimed.turn.executionGeneration,
    attemptId,
    machineId: machine.id,
    instance,
    acceptedActionId: "accepted-exec",
  };
  return { context, grant, session };
}
async function command(context: SandboxJournalTurnAuthority) {
  const operationId = await allocateSandboxJournalOperation(client.db, context, "1".repeat(64));
  const binding: SandboxJournalCommand = {
    kind: "machine-journal-v1",
    operationId,
    machineId: context.machineId,
    bootId: context.instance.bootId,
    diskLineage: context.instance.diskLineage,
    specificationDigest: "2".repeat(64),
    stdin: true,
    pty: false,
  };
  await reserveSandboxJournalCommand(client.db, context, binding);
  const saved = await loadSandboxJournalCommand(client.db, context, {
    operationId,
  });
  if (!saved) throw Error("No retained alias");
  return saved;
}
async function pending(context: SandboxJournalTurnAuthority) {
  return withRlsContext(client.db, context, async (tx) => {
    const rows =
      await tx.execute(sql`select ${sessionAttemptPendingWritersSql(sql`attempt`)} as pending
      from session_turn_attempts attempt where attempt.id=${context.attemptId}::uuid`);
    return (rows as unknown as { pending: boolean }[])[0]!.pending;
  });
}
async function nativeReceiptInput(context: SandboxJournalTurnAuthority) {
  const [row] = await withRlsContext(client.db, context, (tx) =>
    tx.execute<{
      workflow: string;
      run: string;
      activity: string;
    }>(sql`select temporal_workflow_id as workflow,temporal_workflow_run_id as run,
    temporal_activity_id as activity from session_turn_attempts where id=${context.attemptId}::uuid`),
  );
  if (!row) throw Error("Missing synthetic dispatch");
  const { acceptedActionId: _action, ...nativeAuthority } = context;
  return {
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    attemptId: context.attemptId,
    temporalWorkflowId: row.workflow,
    temporalWorkflowRunId: row.run,
    temporalActivityId: row.activity,
    allowUninterrupted: true,
    nativeAuthority,
  };
}
function terminal(
  saved: Awaited<ReturnType<typeof command>>,
  text = "😀\0",
): SandboxJournalObservation {
  const bytes = Buffer.from(text);
  return {
    operationId: saved.command.operationId,
    state: "exited",
    specificationDigest: saved.command.specificationDigest,
    receipt: {
      protocol: "native-subreaper-v1",
      invocationId: saved.command.operationId,
      receiptId: crypto.randomUUID(),
      leaderExitCode: 7,
      ...(saved.command.stdin ? { acceptedInputSequence: 0 } : {}),
    },
    stdout: {
      offset: saved.stdout.offset,
      nextOffset: saved.stdout.offset + bytes.length,
      data: bytes.toString("base64"),
      eof: true,
    },
    stderr: {
      offset: saved.stderr.offset,
      nextOffset: saved.stderr.offset,
      data: "",
      eof: true,
    },
  };
}
describe("protected sandbox journal authority", () => {
  test("native completion waits for captured EOF and atomically reuses command output events", async () => {
    // Protocol/database fixture only: no child or guest journal is launched.
    const { context } = await owned();
    const action = { ...context, acceptedActionId: "synthetic-job-output-settlement" };
    const jobId = await allocateSandboxV2BackgroundOperation(client.db, action, {
      requestDigest: "5".repeat(64),
      commandText: "printf ordinary-output",
    });
    const authority = { ...context, jobId };
    const binding: SandboxJournalCommand = {
      kind: "machine-journal-v1",
      operationId: jobId,
      machineId: context.machineId,
      bootId: context.instance.bootId,
      diskLineage: context.instance.diskLineage,
      specificationDigest: "4".repeat(64),
      stdin: false,
      pty: false,
    };
    await reserveSandboxJournalCommand(client.db, action, binding);
    const expected = (await loadSandboxV2BackgroundCommandForControl(client.db, authority))
      .command!;
    const first = "\0".repeat(20_000);
    const observation = {
      ...terminal(expected, first),
      stdout: {
        ...terminal(expected, first).stdout,
        eof: false,
      },
    };
    const input = {
      expected,
      next: {
        ...expected,
        revision: expected.revision + 1,
        stdout: { offset: Buffer.byteLength(first), remainder: "" },
      },
      observation,
      stdout: first,
      stderr: "",
    };
    await expect(
      captureSandboxV2BackgroundCommandOutput(client.db, authority, input, async () => {
        throw Error("Synthetic output publication failed");
      }),
    ).rejects.toThrow("Synthetic output publication failed");
    expect((await loadSandboxV2BackgroundCommandForControl(client.db, authority)).command).toEqual(
      expected,
    );
    expect(await pending(context)).toBe(true);
    const capture = await captureSandboxV2BackgroundCommandOutputWithEvents(
      client.db,
      authority,
      input,
    );
    expect(capture.captured).toBe(true);
    expect(capture.events).toHaveLength(2);
    expect(await settleSandboxV2BackgroundCommand(client.db, authority)).toBeNull();
    let premature: unknown;
    try {
      await fixture.admin`update session_background_commands set state='exited',exit_code=7 where id=${jobId}`;
    } catch (error) {
      premature = error;
    }
    expect(nestedPostgresSqlState(premature)).toBe("23514");
    const current = (await loadSandboxV2BackgroundCommandForControl(client.db, authority)).command!;
    const tail = "€done";
    const last: SandboxJournalObservation = {
      ...observation,
      stdout: {
        offset: current.stdout.offset,
        nextOffset: current.stdout.offset + Buffer.byteLength(tail),
        data: Buffer.from(tail).toString("base64"),
        eof: true,
      },
    };
    expect(
      (
        await captureSandboxV2BackgroundCommandOutputWithEvents(client.db, authority, {
          expected: current,
          next: {
            ...current,
            revision: current.revision + 1,
            stdout: { offset: last.stdout.nextOffset, remainder: "" },
          },
          observation: last,
          stdout: tail,
          stderr: "",
        })
      ).captured,
    ).toBe(true);
    const settlements = await Promise.all(
      Array.from({ length: 3 }, () => settleSandboxV2BackgroundCommand(client.db, authority)),
    );
    expect(
      settlements.every(
        (result) => result?.command.state === "exited" && result.command.exitCode === 7,
      ),
    ).toBe(true);
    expect(
      settlements
        .flatMap((result) => result?.events ?? [])
        .filter((event) => event.type === "session.command.finished"),
    ).toHaveLength(1);
    let cursor: string | undefined;
    let output = "";
    for (let index = 0; index < 4; index++) {
      const page = await readSessionBackgroundCommandOutput(client.db, {
        ...context,
        commandId: jobId,
        cursor,
      });
      expect(page.state).toBe("exited");
      expect(page.retention.gaps).toEqual([]);
      output += page.chunks.map((chunk) => chunk.chunk).join("");
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(output).toBe(first + tail);
    expect((await settleSandboxV2BackgroundCommand(client.db, authority))?.events).toEqual([]);
  });

  test("job control scopes live-owner cancellation and revoked-owner captures to one native job", async () => {
    const { context, grant } = await owned();
    const foreground = await command(context);
    const jobContext = { ...context, acceptedActionId: "synthetic-job-control" };
    const jobId = await allocateSandboxV2BackgroundOperation(client.db, jobContext, {
      requestDigest: "6".repeat(64),
      commandText: "printf ordinary-job",
    });
    const jobAuthority = { ...context, jobId };
    const binding = { ...foreground.command, operationId: jobId, stdin: false };
    await reserveSandboxJournalCommand(client.db, jobContext, binding);
    await expect(
      assertSandboxV2BackgroundCommandControl(client.db, jobAuthority, binding, "cancel"),
    ).rejects.toThrow("control owner");
    await requestSessionBackgroundCommandCancellation(client.db, {
      ...context,
      commandId: jobId,
      subjectId: grant.subjectId,
    });
    await assertSandboxV2BackgroundCommandControl(client.db, jobAuthority, binding, "cancel");
    await expect(
      assertSandboxJournalControl(client.db, context, foreground.command, "cancel"),
    ).rejects.toThrow("revoked agent authority");
    await expect(
      assertSandboxV2BackgroundCommandControl(
        client.db,
        jobAuthority,
        foreground.command,
        "cancel",
      ),
    ).rejects.toThrow("binding changed");
    const secondId = await allocateSandboxV2BackgroundOperation(
      client.db,
      { ...context, acceptedActionId: "synthetic-second-job" },
      { requestDigest: "7".repeat(64), commandText: "printf second-job" },
    );
    await expect(
      abandonUnboundSandboxV2BackgroundCommand(client.db, { ...context, jobId: secondId }),
    ).rejects.toThrow("control owner");
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      context.workspaceId,
      grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: context.accountId,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "pause",
          }),
        ),
    );
    const info = await loadSandboxV2BackgroundCommandForControl(client.db, jobAuthority);
    const expected = info.command!;
    const observation: SandboxJournalObservation = {
      operationId: jobId,
      state: "running",
      specificationDigest: binding.specificationDigest,
      receipt: null,
      stdout: {
        offset: 0,
        nextOffset: 4,
        data: Buffer.from("part").toString("base64"),
        eof: false,
      },
      stderr: { offset: 0, nextOffset: 0, data: "", eof: false },
    };
    expect(
      await captureSandboxV2BackgroundCommandOutput(client.db, jobAuthority, {
        expected,
        next: {
          ...expected,
          revision: expected.revision + 1,
          stdout: { offset: 4, remainder: "" },
        },
        observation,
        stdout: "part",
        stderr: "",
      }),
    ).toBe(true);
    expect(
      (await loadSandboxV2BackgroundCommandForControl(client.db, jobAuthority)).command?.stdout
        .offset,
    ).toBe(4);
    expect(await pending(context)).toBe(true);
    const [page] = await fixture.admin<{ acceptedActionId: string; stdout: string }[]>`
      select accepted_action_id as "acceptedActionId",stdout from sandbox_v2_command_output where operation_id=${jobId}`;
    expect(page).toEqual({
      acceptedActionId: jobContext.acceptedActionId,
      stdout: Buffer.from("part").toString("base64"),
    });
  });

  test("native background intent commits once before binding and cancellation denies launch", async () => {
    const { context, session, grant } = await owned();
    const input = { requestDigest: "8".repeat(64), commandText: "printf ordinary-background" };
    const peers = await Promise.all(
      Array.from({ length: 3 }, () =>
        allocateSandboxV2BackgroundOperation(client.db, context, input),
      ),
    );
    expect(new Set(peers).size).toBe(1);
    const operationId = peers[0]!;
    const job = await getSessionBackgroundCommand(client.db, {
      ...context,
      commandId: operationId,
    });
    expect(job).toMatchObject({
      id: operationId,
      provider: "managed",
      state: "running",
      commandText: input.commandText,
    });
    expect(await loadSandboxJournalCommand(client.db, context, { operationId })).toBeNull();
    expect(await pending(context)).toBe(true);
    const machine = await findSandboxMachine(client.db, {
      ...context,
      sandboxGroupId: session.sandboxGroupId,
    });
    expect(machine?.demands).toContainEqual({
      id: operationId,
      kind: "command",
      owner: context.sessionId,
      authority: context.attemptId,
    });
    await expect(
      allocateSandboxV2BackgroundOperation(client.db, context, {
        ...input,
        commandText: "printf changed",
      }),
    ).rejects.toThrow("intent changed");
    await expect(
      allocateSandboxV2BackgroundOperation(client.db, context, {
        ...input,
        requestDigest: "9".repeat(64),
      }),
    ).rejects.toThrow("request");
    await expect(
      allocateSandboxJournalOperation(client.db, context, input.requestDigest),
    ).rejects.toThrow("request");
    const cancellation = await requestSessionBackgroundCommandCancellation(client.db, {
      ...context,
      commandId: operationId,
      subjectId: grant.subjectId,
    });
    expect(cancellation.accepted).toBe(true);
    expect(cancellation.command?.state).toBe("stopping");
    const binding: SandboxJournalCommand = {
      kind: "machine-journal-v1",
      operationId,
      machineId: context.machineId,
      bootId: context.instance.bootId,
      diskLineage: context.instance.diskLineage,
      specificationDigest: "a".repeat(64),
      stdin: false,
      pty: false,
    };
    await expect(reserveSandboxJournalCommand(client.db, context, binding)).rejects.toThrow(
      "stopping or settled",
    );
    expect(await loadSandboxJournalCommand(client.db, context, { operationId })).toBeNull();
    expect(await pending(context)).toBe(true);
  });

  test("failed native background registration rolls back command allocation and machine demand", async () => {
    const { context, session } = await owned();
    const tenant = { ...context, sandboxGroupId: session.sandboxGroupId };
    const before = await findSandboxMachine(client.db, tenant);
    await fixture.admin`revoke insert on session_background_commands from opengeni_app`;
    try {
      await expect(
        allocateSandboxV2BackgroundOperation(client.db, context, {
          requestDigest: "b".repeat(64),
          commandText: "printf ordinary",
        }),
      ).rejects.toThrow();
    } finally {
      await fixture.admin`grant insert on session_background_commands to opengeni_app`;
    }
    expect(await findSandboxMachine(client.db, tenant)).toEqual(before);
    const rows = await fixture.admin<{ count: number }[]>`select count(*)::integer as count
      from sandbox_v2_commands where attempt_id=${context.attemptId}`;
    expect(rows[0]!.count).toBe(0);
    expect(await pending(context)).toBe(false);
    expect(
      await allocateSandboxV2BackgroundOperation(client.db, context, {
        requestDigest: "b".repeat(64),
        commandText: "printf ordinary",
      }),
    ).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await pending(context)).toBe(true);
  });

  test("native background reservation preserves the original attempt writer gate after Pause", async () => {
    const { context, grant, session } = await owned();
    await acquireSandboxMachineForAttempt(client.db, context);
    const input = { requestDigest: "c".repeat(64), commandText: "printf retained-intent" };
    const operationId = await allocateSandboxV2BackgroundOperation(client.db, context, input);
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      context.workspaceId,
      grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: context.accountId,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "pause",
          }),
        ),
    );
    expect(
      (await getSessionBackgroundCommand(client.db, { ...context, commandId: operationId }))?.state,
    ).toBe("stopping");
    await expect(allocateSandboxV2BackgroundOperation(client.db, context, input)).rejects.toThrow(
      "authority rejected",
    );
    expect(await pending(context)).toBe(true);
    expect(await releaseRevokedSandboxMachineAttempt(client.db, context)).toBe(true);
    expect(await pending(context)).toBe(true);
    const machine = await findSandboxMachine(client.db, {
      ...context,
      sandboxGroupId: session.sandboxGroupId,
    });
    expect(machine?.demands.map((item) => item.id)).toEqual([operationId]);
  });

  test("guest cleanup has one retained original identity and remains held while its owner or ordinary writers are live", async () => {
    const { context, session } = await owned();
    const other = await owned();
    await acquireSandboxMachineForAttempt(client.db, context);
    const original = await retainSandboxV2CredentialCleanupIntent(client.db, context, () =>
      "b".repeat(64),
    );
    const peers = await Promise.all(
      Array.from({ length: 4 }, () =>
        retainSandboxV2CredentialCleanupIntent(client.db, context, () => "b".repeat(64)),
      ),
    );
    for (const peer of peers) expect(peer).toEqual(original);
    expect(await pending(context)).toBe(true);
    expect((await loadSandboxV2CredentialCleanupForControl(client.db, context))?.eligible).toBe(
      false,
    );
    expect(await findSandboxV2CredentialCleanupAuthority(client.db, other.context)).toBeNull();
    expect(await findSandboxV2CredentialCleanupAuthority(client.db, context)).toMatchObject({
      instance: context.instance,
    });
    await expect(
      retainSandboxV2CredentialCleanupIntent(client.db, context, () => "c".repeat(64)),
    ).rejects.toThrow("unavailable or unsettled");
    await expect(
      loadSandboxV2CredentialCleanupForControl(client.db, {
        ...context,
        instance: { ...context.instance, bootId: "d".repeat(64) },
      }),
    ).rejects.toThrow("incarnation changed");
    const cleanupCommand: SandboxJournalCommand = {
      kind: "machine-journal-v1",
      operationId: original.operationId,
      machineId: context.machineId,
      bootId: context.instance.bootId,
      diskLineage: context.instance.diskLineage,
      specificationDigest: original.specificationDigest,
      stdin: false,
      pty: false,
    };
    await expect(
      reserveSandboxV2CredentialCleanupCommand(client.db, context, cleanupCommand),
    ).rejects.toThrow("unavailable or unsettled");
    const unbound = await allocateSandboxJournalOperation(
      client.db,
      { ...context, acceptedActionId: "ordinary-unbound" },
      "e".repeat(64),
    );
    await retainSandboxV2CredentialGeneration(
      client.db,
      context,
      {
        generationId: "synthetic-maintenance-receipt",
        purpose: "provision",
        forceRefresh: false,
      },
      {
        ciphertext: encryptEnvironmentValue(
          crypto.getRandomValues(new Uint8Array(32)),
          crypto.randomUUID(),
        ),
        expiresAt: null,
      },
    );
    const receiptInput = await nativeReceiptInput(context);
    const turn = await getSessionTurn(client.db, context.workspaceId, context.turnId);
    expect(
      (
        await applySessionTurnSettlement(client.db, context.workspaceId, {
          sessionId: context.sessionId,
          turnId: context.turnId,
          triggerEventId: turn!.triggerEventId,
          attemptId: context.attemptId,
          turnStatus: "completed",
          sessionStatus: "idle",
          activeTurnId: null,
          events: [{ type: "turn.completed", payload: { reason: "synthetic" } }],
        })
      ).action,
    ).toBe("settled");
    await expect(commitSessionAttemptQuiescence(client.db, receiptInput)).rejects.toThrow(
      "physical settlement",
    );
    expect(await releaseRevokedSandboxMachineAttempt(client.db, context)).toBe(false);
    expect((await loadSandboxV2CredentialCleanupForControl(client.db, context))?.eligible).toBe(
      false,
    );
    await expect(
      reserveSandboxV2CredentialCleanupCommand(client.db, context, cleanupCommand),
    ).rejects.toThrow("unavailable or unsettled");
    expect(await abandonUnboundSandboxJournalControl(client.db, context, unbound)).toBe(true);
    expect((await loadSandboxV2CredentialCleanupForControl(client.db, context))?.eligible).toBe(
      true,
    );
    expect(
      await reserveSandboxV2CredentialCleanupCommand(client.db, context, cleanupCommand),
    ).toEqual(cleanupCommand);
    await expect(
      reserveSandboxV2CredentialCleanupCommand(client.db, context, cleanupCommand),
    ).rejects.toThrow("unavailable or unsettled");
    await assertSandboxV2CredentialCleanupCommand(client.db, context, cleanupCommand, "read");
    await expect(
      assertSandboxJournalCommand(client.db, context, cleanupCommand, "start"),
    ).rejects.toThrow("authority rejected");
    expect(await pending(context)).toBe(true);
    const proof: SandboxJournalObservation = {
      operationId: original.operationId,
      state: "exited",
      specificationDigest: original.specificationDigest,
      receipt: {
        protocol: "native-subreaper-v1",
        invocationId: original.operationId,
        receiptId: crypto.randomUUID(),
        leaderExitCode: 0,
      },
      stdout: {
        offset: 0,
        nextOffset: 7,
        data: Buffer.from("cleaned").toString("base64"),
        eof: true,
      },
      stderr: { offset: 0, nextOffset: 0, data: "", eof: true },
    };
    for (const changed of [
      { ...proof, receipt: { ...proof.receipt!, leaderExitCode: 1 } },
      {
        ...proof,
        stdout: {
          offset: 0,
          nextOffset: 3,
          data: Buffer.from("bad").toString("base64"),
          eof: true,
        },
      },
    ])
      await expect(
        settleSandboxV2CredentialCleanup(client.db, context, cleanupCommand, changed),
      ).rejects.toThrow("unavailable or unsettled");
    expect(await pending(context)).toBe(true);
    await settleSandboxV2CredentialCleanup(client.db, context, cleanupCommand, proof);
    await settleSandboxV2CredentialCleanup(client.db, context, cleanupCommand, proof);
    expect(await pending(context)).toBe(false);
    expect((await loadSandboxV2CredentialCleanupForControl(client.db, context))?.proof).toEqual(
      proof,
    );
    await expect(
      commitSessionAttemptQuiescence(client.db, {
        ...receiptInput,
        nativeAuthority: {
          ...receiptInput.nativeAuthority,
          instance: { ...context.instance, bootId: "d".repeat(64) },
        },
      }),
    ).rejects.toThrow("physical settlement");
    // An actual erasure write failure must roll back the receipt and event too.
    // Only this disposable fixture database's table grant is changed.
    await fixture.admin`revoke update on sandbox_v2_credential_generations from opengeni_app`;
    try {
      await expect(commitSessionAttemptQuiescence(client.db, receiptInput)).rejects.toThrow();
      const [rollback] = await fixture.admin<
        { quiesced: boolean; cleared: boolean; events: number }[]
      >`
        select attempt.quiesced_at is not null as quiesced,
          generation.cleared_at is not null as cleared,
          (select count(*)::integer from session_events where turn_attempt_id=attempt.id
            and type='session.queue.changed' and payload->>'operation'='attempt_quiesced') as events
        from session_turn_attempts attempt join sandbox_v2_credential_generations generation
          on generation.attempt_id=attempt.id where attempt.id=${context.attemptId}`;
      expect(rollback).toEqual({ quiesced: false, cleared: false, events: 0 });
    } finally {
      await fixture.admin`grant update on sandbox_v2_credential_generations to opengeni_app`;
    }
    const receipt = await commitSessionAttemptQuiescence(client.db, receiptInput);
    expect(receipt.events).toHaveLength(1);
    expect(receipt.events[0]!.payload).toMatchObject({
      operation: "attempt_quiesced",
      attemptId: context.attemptId,
    });
    const replay = await commitSessionAttemptQuiescence(client.db, receiptInput);
    expect(replay.events.map((event) => event.id)).toEqual(receipt.events.map((event) => event.id));
    const [erased] = await fixture.admin<
      { quiesced: boolean; ciphertext: string | null; cleared: boolean }[]
    >`
      select attempt.quiesced_at is not null as quiesced,generation.ciphertext,
        generation.cleared_at is not null as cleared from session_turn_attempts attempt
      join sandbox_v2_credential_generations generation on generation.attempt_id=attempt.id
      where attempt.id=${context.attemptId}`;
    expect(erased).toEqual({ quiesced: true, ciphertext: null, cleared: true });
    expect(await releaseRevokedSandboxMachineAttempt(client.db, context)).toBe(true);
    const retained = await findSandboxMachine(client.db, {
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      sandboxGroupId: session.sandboxGroupId,
    });
    expect(retained?.demands).toEqual([]);
  }, 60_000);

  test("credential maintenance rows retain immutable scope and expose no application deletion privilege", async () => {
    const { context } = await owned();
    await retainSandboxV2CredentialCleanupIntent(client.db, context, () => "b".repeat(64));
    let error: unknown;
    try {
      await withRlsContext(client.db, context, (tx) =>
        tx
          .update(sandboxV2CredentialCleanup)
          .set({ revision: 1, specificationDigest: "c".repeat(64) })
          .where(eq(sandboxV2CredentialCleanup.attemptId, context.attemptId)),
      );
    } catch (failure) {
      error = failure;
    }
    expect(nestedPostgresSqlState(error)).toBe("23514");
    error = undefined;
    try {
      await withRlsContext(client.db, context, (tx) =>
        tx
          .delete(sandboxV2CredentialCleanup)
          .where(eq(sandboxV2CredentialCleanup.attemptId, context.attemptId)),
      );
    } catch (failure) {
      error = failure;
    }
    expect(nestedPostgresSqlState(error)).toBe("42501");
    expect(await pending(context)).toBe(true);
  }, 60_000);

  test("large captured output has a bounded UTF-8 response while every byte stays retained", async () => {
    const { context } = await owned();
    let saved = await command(context);
    const text = "page 😀\0".repeat(12_000) + "complete";
    const bytes = Buffer.from(text);
    const final = terminal(saved, "");
    for (let offset = 0; offset < bytes.length; offset += 4093) {
      const end = Math.min(offset + 4093, bytes.length);
      const eof = end === bytes.length;
      const page: SandboxJournalObservation = {
        ...final,
        state: eof ? "exited" : "running",
        receipt: eof ? final.receipt : null,
        stdout: {
          offset,
          nextOffset: end,
          data: bytes.subarray(offset, end).toString("base64"),
          eof,
        },
        stderr: { offset: 0, nextOffset: 0, data: "", eof },
      };
      const out = decodeSandboxJournalPage(
        saved.stdout.remainder,
        [bytes.subarray(offset, end)],
        eof,
      );
      const next = {
        ...saved,
        revision: saved.revision + 1,
        stdout: { offset: end, remainder: out.remainder },
      };
      expect(
        await captureSandboxJournalOutput(client.db, context, {
          expected: saved,
          next,
          observation: page,
          stdout: out.text,
          stderr: "",
        }),
      ).toBe(true);
      saved = next;
    }
    const bounded = await loadSandboxJournalCapturedOutput(client.db, context, saved.command, {
      maxStreamBytes: 65,
    });
    expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(65);
    expect(bounded.stdout.endsWith("complete")).toBe(true);
    expect(bounded.stdout.includes("�")).toBe(false);
    expect(bounded.omittedOutputBytes).toBe(bytes.length - Buffer.byteLength(bounded.stdout));
    expect(bounded.observation?.state).toBe("exited");
    expect(await pending(context)).toBe(false);
    const full = await loadSandboxJournalCapturedOutput(client.db, context, saved.command);
    expect(full.stdout).toBe(text);
    expect(full.omittedOutputBytes).toBeUndefined();
  }, 60_000);
  test("sibling wake ownership survives session Pause; workspace Pause serializes acquisition", async () => {
    const root = await owned();
    const { context, grant, session } = root;
    const sibling = await createSession(client.db, {
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      initialMessage: "synthetic sibling",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "docker",
    });
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      context.workspaceId,
      grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: context.accountId,
            workspaceId: context.workspaceId,
            sessionId: sibling.id,
            subjectId: grant.subjectId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "synthetic sibling work",
            resources: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
    );
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, context.workspaceId, {
      sessionId: sibling.id,
      workflowId: `session-${sibling.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw Error("Synthetic sibling was not claimed");
    const peer = {
      ...context,
      sessionId: sibling.id,
      turnId: claimed.turn.id,
      executionGeneration: claimed.turn.executionGeneration,
      attemptId,
    };
    await Promise.all([
      acquireSandboxMachineForAttempt(client.db, context),
      acquireSandboxMachineForAttempt(client.db, peer),
    ]);
    const saved = await command(context);
    const tenant = { ...context, sandboxGroupId: session.sandboxGroupId };
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      context.workspaceId,
      grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: context.accountId,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "pause",
          }),
        ),
    );
    expect(await releaseRevokedSandboxMachineAttempt(client.db, context)).toBe(true);
    expect(await releaseRevokedSandboxMachineAttempt(client.db, peer)).toBe(false);
    const retained = (await findSandboxMachine(client.db, tenant))!;
    expect(retained.demands.map((item) => item.id).sort()).toEqual(
      [`attempt:${peer.attemptId}`, saved.command.operationId].sort(),
    );
    const held = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let blockerPid = 0;
    const pause = withRlsContext(client.db, context, async (tx) => {
      const [pid] = await tx.execute(sql`select pg_backend_pid() as pid`);
      blockerPid = (pid as { pid: number }).pid;
      await mutateWorkspaceControlInTransaction(tx as unknown as SessionActivityDatabase, {
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        action: "pause",
      });
      held.resolve();
      await finish.promise;
    });
    let acquire: Promise<unknown> | undefined;
    try {
      await Promise.race([
        held.promise,
        pause.then(() => {
          throw Error("Pause did not hold");
        }),
      ]);
      acquire = acquireSandboxMachineForAttempt(client.db, peer).then(
        () => ({ denied: false }),
        (error: unknown) => ({ denied: true, error }),
      );
      let blocked = false;
      for (let i = 0; i < 80 && !blocked; i++) {
        const [observed] = await fixture.admin`select exists(select 1 from pg_stat_activity activity
          where activity.datname=current_database() and ${blockerPid}::int=any(pg_blocking_pids(activity.pid))) as blocked`;
        blocked = observed?.blocked === true;
        if (!blocked) await Bun.sleep(25);
      }
      expect(blocked).toBe(true);
      finish.resolve();
      await pause;
      expect(await acquire).toMatchObject({ denied: true });
    } finally {
      finish.resolve();
      await Promise.allSettled([pause, ...(acquire ? [acquire] : [])]);
    }
    expect(await releaseRevokedSandboxMachineAttempt(client.db, peer)).toBe(true);
    expect((await findSandboxMachine(client.db, tenant))!.demands.map((item) => item.id)).toEqual([
      saved.command.operationId,
    ]);
    await settleSandboxJournalControl(client.db, context, saved.command, terminal(saved, ""));
    expect((await findSandboxMachine(client.db, tenant))!.demands).toEqual([]);
  }, 60_000);
  test("exact attempt wake ownership cannot survive revocation or discard unresolved command demand", async () => {
    const { context, grant, session } = await owned();
    const tenant = { ...context, sandboxGroupId: session.sandboxGroupId };
    const before = (await findSandboxMachine(client.db, tenant))!;
    const acquisitions = await Promise.all(
      Array.from({ length: 12 }, () => acquireSandboxMachineForAttempt(client.db, context)),
    );
    for (const machine of acquisitions) {
      expect(machine.version).toBe(before.version + 1);
      expect(machine.demands).toHaveLength(1);
      expect(machine.demands[0]!.id).toBe(`attempt:${context.attemptId}`);
    }
    await expect(
      acquireSandboxMachineForAttempt(client.db, { ...context, attemptId: crypto.randomUUID() }),
    ).rejects.toThrow("authority rejected");
    await expect(
      acquireSandboxMachineForAttempt(client.db, { ...context, machineId: crypto.randomUUID() }),
    ).rejects.toThrow("exact session group");
    expect(await releaseRevokedSandboxMachineAttempt(client.db, context)).toBe(false);
    expect(await readSandboxJournalControlOwner(client.db, context)).toBe("live");
    const owners = await listSandboxMachineAttemptOwners(client.db, context, { limit: 1 });
    expect(owners.items).toEqual([
      {
        demandId: `attempt:${context.attemptId}`,
        authority: {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          executionGeneration: context.executionGeneration,
          attemptId: context.attemptId,
          machineId: context.machineId,
        },
      },
    ]);
    expect(owners.nextDemandId).toBe(`attempt:${context.attemptId}`);
    expect(
      (
        await listSandboxMachineAttemptOwners(client.db, context, {
          afterDemandId: owners.nextDemandId!,
          limit: 1,
        })
      ).items,
    ).toHaveLength(0);
    expect(
      (
        await listSandboxMachineAttemptOwners(client.db, {
          ...context,
          workspaceId: crypto.randomUUID(),
        })
      ).items,
    ).toHaveLength(0);
    await expect(listSandboxMachineAttemptOwners(client.db, context, { limit: 0 })).rejects.toThrow(
      "bounded attempt-owner",
    );
    const saved = await command(context);
    expect((await findSandboxMachine(client.db, tenant))!.demands).toHaveLength(2);
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      context.workspaceId,
      grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: context.accountId,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "pause",
          }),
        ),
    );
    await expect(acquireSandboxMachineForAttempt(client.db, context)).rejects.toThrow(
      "authority rejected",
    );
    expect(await readSandboxJournalControlOwner(client.db, context)).toBe("revoked");
    // Pause is not sufficient proof for a forged tuple naming retained rows.
    await expect(
      readSandboxJournalControlOwner(client.db, {
        ...context,
        executionGeneration: context.executionGeneration + 1,
      }),
    ).rejects.toThrow("exact retained control owner");
    await expect(
      releaseRevokedSandboxMachineAttempt(client.db, {
        ...context,
        executionGeneration: context.executionGeneration + 1,
      }),
    ).rejects.toThrow("exact retained machine attempt owner");
    expect(await releaseRevokedSandboxMachineAttempt(client.db, context)).toBe(true);
    expect(await releaseRevokedSandboxMachineAttempt(client.db, context)).toBe(false);
    const retained = (await findSandboxMachine(client.db, tenant))!;
    expect(retained.demands).toEqual([
      {
        id: saved.command.operationId,
        kind: "command",
        owner: context.sessionId,
        authority: context.attemptId,
      },
    ]);
    expect(retained.idleSince).toBeNull();
    expect(await pending(context)).toBe(true);
    await settleSandboxJournalControl(client.db, context, saved.command, terminal(saved, ""));
    const quiescent = (await findSandboxMachine(client.db, tenant))!;
    expect(quiescent.demands).toEqual([]);
    expect(quiescent.idleSince).not.toBeNull();
  }, 60_000);
  test("exact-attempt writer inventory keeps the full pending gate across pages and revocation", async () => {
    const { context, grant, session } = await owned();
    const saved = await command(context);
    const unbound = await allocateSandboxJournalOperation(
      client.db,
      { ...context, acceptedActionId: "unbound-finalizer" },
      "f".repeat(64),
    );
    const other = await owned();
    const otherSaved = await command(other.context);
    const page = await readSandboxJournalAttemptWriters(client.db, context, { limit: 1 });
    expect(page.owner).toBe("live");
    expect(page.pending).toBe(true);
    expect(page.commands).toHaveLength(1);
    const next = await readSandboxJournalAttemptWriters(client.db, context, {
      limit: 1,
      afterOperationId: page.nextOperationId!,
    });
    expect(next.commands).toHaveLength(1);
    const end = await readSandboxJournalAttemptWriters(client.db, context, {
      limit: 1,
      afterOperationId: next.nextOperationId!,
    });
    expect(end.commands).toHaveLength(0);
    expect(end.pending).toBe(true);
    expect([page.commands[0]!.operationId, next.commands[0]!.operationId].sort()).toEqual(
      [saved.command.operationId, unbound].sort(),
    );
    await expect(
      readSandboxJournalAttemptWriters(client.db, {
        ...context,
        instance: { ...context.instance, bootId: "b".repeat(64) },
      }),
    ).rejects.toThrow("incarnation changed");
    await expect(
      readSandboxJournalAttemptWriters(client.db, context, { limit: 0 }),
    ).rejects.toThrow("bounded attempt-writer");
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      context.workspaceId,
      grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: context.accountId,
            workspaceId: context.workspaceId,
            sessionId: session.id,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "pause",
          }),
        ),
    );
    expect((await readSandboxJournalAttemptWriters(client.db, context)).owner).toBe("revoked");
    await settleSandboxJournalControl(client.db, context, saved.command, terminal(saved, ""));
    expect((await readSandboxJournalAttemptWriters(client.db, context)).pending).toBe(true);
    expect(await abandonUnboundSandboxJournalControl(client.db, context, unbound)).toBe(true);
    expect(await readSandboxJournalAttemptWriters(client.db, context)).toEqual({
      owner: "revoked",
      pending: false,
      commands: [],
      nextOperationId: null,
    });
    const retainedOther = await readSandboxJournalAttemptWriters(client.db, other.context);
    expect(retainedOther.owner).toBe("live");
    expect(retainedOther.commands).toEqual([
      { operationId: otherSaved.command.operationId, command: otherSaved.command },
    ]);
    expect(retainedOther.pending).toBe(true);
  }, 60_000);
  test("replacement control inventory is bounded, tenant-contained and retains original dispatch identity", async () => {
    const { context } = await owned();
    const saved = await command(context);
    const unboundContext = {
      ...context,
      acceptedActionId: "unbound-control-candidate",
    };
    const unbound = await allocateSandboxJournalOperation(
      client.db,
      unboundContext,
      "3".repeat(64),
    );
    const selector = {
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      machineId: context.machineId,
    };
    const first = await listPendingSandboxJournalCommands(client.db, selector, {
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.nextOperationId).toBe(first.items[0]!.operationId);
    const second = await listPendingSandboxJournalCommands(client.db, selector, {
      limit: 1,
      afterOperationId: first.nextOperationId!,
    });
    expect(second.items).toHaveLength(1);
    const discovered = [...first.items, ...second.items];
    expect(new Set(discovered.map((item) => item.operationId))).toEqual(
      new Set([unbound, saved.command.operationId]),
    );
    expect(discovered.find((item) => item.command)?.command).toEqual(saved.command);
    const { acceptedActionId: _, ...owner } = context;
    expect(discovered.map((item) => item.authority)).toEqual([owner, owner]);
    expect(
      (
        await listPendingSandboxJournalCommands(client.db, selector, {
          limit: 1,
          afterOperationId: second.nextOperationId!,
        })
      ).items,
    ).toEqual([]);
    const other = await owned();
    expect(
      (
        await listPendingSandboxJournalCommands(client.db, {
          ...selector,
          accountId: other.context.accountId,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await listPendingSandboxJournalCommands(client.db, {
          ...selector,
          workspaceId: other.context.workspaceId,
        })
      ).items,
    ).toEqual([]);
    for (const limit of [0, 1001, 1.5])
      await expect(
        listPendingSandboxJournalCommands(client.db, selector, { limit }),
      ).rejects.toThrow("bounded");
    await assertSandboxJournalControl(
      client.db,
      discovered.find((item) => item.command)!.authority!,
      saved.command,
      "read",
    );
    await expect(
      assertSandboxJournalControl(
        client.db,
        discovered.find((item) => item.command)!.authority!,
        saved.command,
        "cancel",
      ),
    ).rejects.toThrow("revoked");
    await abandonSandboxJournalOperation(client.db, unboundContext, unbound);
    await recordSandboxJournalControlProof(client.db, context, saved.command, terminal(saved));
    expect((await listPendingSandboxJournalCommands(client.db, selector)).items).toEqual([]);
  }, 60_000);
  test("concurrent causal allocation retains one alias/demand and never licenses a fresh retained Start", async () => {
    const { context } = await owned();
    const operations = await Promise.all(
      Array.from({ length: 8 }, () =>
        allocateSandboxJournalOperation(client.db, context, "1".repeat(64)),
      ),
    );
    expect(new Set(operations).size).toBe(1);
    await expect(
      allocateSandboxJournalOperation(client.db, context, "3".repeat(64)),
    ).rejects.toThrow("changed its request");
    const saved = await command(context);
    expect(saved.handle).toBeGreaterThan(0);
    expect(await pending(context)).toBe(true);
    await expect(reserveSandboxJournalCommand(client.db, context, saved.command)).rejects.toThrow(
      "fresh Start",
    );
    await assertSandboxJournalCommand(client.db, context, saved.command, "read");
    const machine = await findSandboxMachine(client.db, {
      ...context,
      sandboxGroupId: (await owned()).session.sandboxGroupId,
    });
    expect(machine).toBeNull();
  }, 60_000);
  test("ordered equal chunks replay their original sequences and bind the entire accepted input", async () => {
    const { context } = await owned();
    const saved = await command(context);
    const inputContext = { ...context, acceptedActionId: "accepted-input" };
    const part = {
      command: saved.command,
      requestDigest: "3".repeat(64),
      partCount: 2,
      actionDigest: "4".repeat(64),
    };
    expect(
      await reserveSandboxJournalInput(client.db, inputContext, {
        ...part,
        partIndex: 0,
      }),
    ).toBe(1);
    const secondContext = {
      ...inputContext,
      acceptedActionId: "second-accepted-input",
    };
    expect(
      await reserveSandboxJournalInput(client.db, secondContext, {
        ...part,
        partCount: 1,
        partIndex: 0,
      }),
    ).toBe(3);
    expect(
      await reserveSandboxJournalInput(client.db, inputContext, {
        ...part,
        partIndex: 1,
      }),
    ).toBe(2);
    expect(
      await reserveSandboxJournalInput(client.db, inputContext, {
        ...part,
        partIndex: 0,
      }),
    ).toBe(1);
    expect(
      await reserveSandboxJournalInput(client.db, inputContext, {
        ...part,
        partIndex: 1,
      }),
    ).toBe(2);
    await expect(
      reserveSandboxJournalInput(client.db, inputContext, {
        ...part,
        partIndex: 0,
        requestDigest: "5".repeat(64),
      }),
    ).rejects.toThrow("whole request");
  }, 60_000);
  test("terminal accepted input replay recovers its old sequence but cannot admit fresh bytes", async () => {
    const { context } = await owned();
    const saved = await command(context);
    const inputContext = { ...context, acceptedActionId: "accepted-input" };
    const part = {
      command: saved.command,
      requestDigest: "3".repeat(64),
      partCount: 1,
      partIndex: 0,
      actionDigest: "4".repeat(64),
    };
    expect(await reserveSandboxJournalInput(client.db, inputContext, part)).toBe(1);
    const page = terminal(saved, "");
    page.receipt!.acceptedInputSequence = 1;
    await recordSandboxJournalControlProof(client.db, context, saved.command, page);
    expect(await reserveSandboxJournalInput(client.db, inputContext, part)).toBe(1);
    await expect(
      reserveSandboxJournalInput(
        client.db,
        { ...inputContext, acceptedActionId: "new-input" },
        part,
      ),
    ).rejects.toThrow("terminal operation");
  }, 60_000);
  test("unbound allocation failure retires demand permanently without claiming a command exit", async () => {
    const { context } = await owned();
    const operationId = await allocateSandboxJournalOperation(client.db, context, "1".repeat(64));
    expect(await pending(context)).toBe(true);
    expect(await abandonSandboxJournalOperation(client.db, context, operationId)).toBe(true);
    expect(await abandonSandboxJournalOperation(client.db, context, operationId)).toBe(true);
    expect(await pending(context)).toBe(false);
    await expect(
      allocateSandboxJournalOperation(client.db, context, "1".repeat(64)),
    ).rejects.toThrow("abandoned before dispatch");
    const binding: SandboxJournalCommand = {
      kind: "machine-journal-v1",
      operationId,
      machineId: context.machineId,
      bootId: context.instance.bootId,
      diskLineage: context.instance.diskLineage,
      specificationDigest: "2".repeat(64),
      stdin: true,
      pty: false,
    };
    await expect(reserveSandboxJournalCommand(client.db, context, binding)).rejects.toThrow(
      "Abandoned command",
    );
    let error: unknown;
    try {
      await withRlsContext(client.db, context, (tx) =>
        tx
          .update(sandboxV2Commands)
          .set({ binding, revision: 2 })
          .where(eq(sandboxV2Commands.operationId, operationId)),
      );
    } catch (e) {
      error = e;
    }
    expect(nestedPostgresSqlState(error)).toBe("23514");
  }, 60_000);
  test("control can retire a never-bound revoked allocation but cannot abandon a retained dispatch", async () => {
    const { context, grant } = await owned();
    const saved = await command(context);
    const other = { ...context, acceptedActionId: "unbound-before-pause" };
    const operationId = await allocateSandboxJournalOperation(client.db, other, "1".repeat(64));
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      context.workspaceId,
      grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: context.accountId,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "pause",
          }),
        ),
    );
    expect(await abandonUnboundSandboxJournalControl(client.db, context, operationId)).toBe(true);
    expect(
      await abandonUnboundSandboxJournalControl(client.db, context, saved.command.operationId),
    ).toBe(false);
    expect(await pending(context)).toBe(true);
    await settleSandboxJournalControl(client.db, context, saved.command, terminal(saved, ""));
    expect(await pending(context)).toBe(false);
  }, 60_000);
  test("capture CAS retains raw binary/NUL output and releases demand only with immutable terminal evidence", async () => {
    const { context } = await owned();
    const saved = await command(context);
    const page = terminal(saved);
    const next = {
      ...saved,
      revision: saved.revision + 1,
      stdout: { offset: page.stdout.nextOffset, remainder: "" },
    };
    await expect(
      captureSandboxJournalOutput(client.db, context, {
        expected: saved,
        next,
        observation: page,
        stdout: "forged",
        stderr: "",
      }),
    ).rejects.toThrow("exact journal bytes");
    await expect(
      captureSandboxJournalOutput(client.db, context, {
        expected: saved,
        next: { ...next, stdout: { ...next.stdout, remainder: "8J+Y" } },
        observation: page,
        stdout: "😀\0",
        stderr: "",
      }),
    ).rejects.toThrow("exact journal bytes");
    expect(
      await captureSandboxJournalOutput(client.db, context, {
        expected: saved,
        next,
        observation: page,
        stdout: "😀\0",
        stderr: "",
      }),
    ).toBe(true);
    expect(
      await captureSandboxJournalOutput(client.db, context, {
        expected: saved,
        next,
        observation: page,
        stdout: "😀\0",
        stderr: "",
      }),
    ).toBe(false);
    expect(await pending(context)).toBe(false);
    const rows = await withRlsContext(client.db, context, (tx) =>
      tx
        .select()
        .from(sandboxV2CommandOutput)
        .where(eq(sandboxV2CommandOutput.operationId, saved.command.operationId)),
    );
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.stdout, "base64").toString()).toBe("😀\0");
    expect(await loadSandboxJournalCapturedOutput(client.db, context, saved.command)).toEqual({
      stdout: "😀\0",
      stderr: "",
      observation: page,
    });
    expect(
      await loadSandboxJournalCapturedOutput(
        client.db,
        { ...context, acceptedActionId: "other-tool" },
        saved.command,
      ),
    ).toEqual({ stdout: "", stderr: "", observation: null });
    await expect(
      recordSandboxJournalControlProof(client.db, context, saved.command, {
        ...page,
        receipt: { ...page.receipt!, receiptId: crypto.randomUUID() },
      }),
    ).rejects.toThrow("terminal evidence conflicts");
  }, 60_000);
  test("cached output cannot forge a terminal receipt, revision or retained bytes", async () => {
    const { context } = await owned();
    const saved = await command(context);
    const page = terminal(saved, "");
    const output = {
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      operationId: saved.command.operationId,
      acceptedActionId: context.acceptedActionId,
      revision: saved.revision + 1,
      observation: page,
      stdout: "",
      stderr: "",
    };
    for (const invalid of [
      output,
      { ...output, revision: output.revision + 1 },
      {
        ...output,
        observation: {
          ...page,
          receipt: { ...page.receipt!, acceptedInputSequence: 999 },
        },
      },
    ]) {
      let error: unknown;
      try {
        await withRlsContext(client.db, context, async (tx) => {
          await tx.insert(sandboxV2CommandOutput).values(invalid);
          if (invalid.revision === output.revision)
            await tx
              .update(sandboxV2Commands)
              .set({ revision: output.revision })
              .where(eq(sandboxV2Commands.operationId, saved.command.operationId));
        });
      } catch (e) {
        error = e;
      }
      expect(nestedPostgresSqlState(error)).toBe("23514");
    }
    expect(await pending(context)).toBe(true);
    expect(await loadSandboxJournalCapturedOutput(client.db, context, saved.command)).toEqual({
      stdout: "",
      stderr: "",
      observation: null,
    });
    // Even a structurally valid cached nonterminal page cannot invent decoded
    // text. Reconstruct from raw journal bytes rather than trusting the cache.
    const running: SandboxJournalObservation = {
      ...page,
      state: "running",
      receipt: null,
      stdout: { offset: 0, nextOffset: 0, data: "", eof: false },
      stderr: { offset: 0, nextOffset: 0, data: "", eof: false },
    };
    // Commit-time validation must still see the command after a nested scope
    // restores empty parent GUCs, or after the caller clears them explicitly.
    for (const nested of [false, true]) {
      let error: unknown;
      try {
        await client.db.transaction(async (tx) => {
          await withRlsContext(tx as unknown as typeof client.db, context, async (scoped) => {
            await scoped.insert(sandboxV2CommandOutput).values({ ...output, observation: running });
            if (!nested)
              await scoped.execute(sql`select set_config('opengeni.account_id','',true),
                set_config('opengeni.workspace_id','',true)`);
          });
        });
      } catch (e) {
        error = e;
      }
      expect(nestedPostgresSqlState(error)).toBe("23514");
    }
    await withRlsContext(client.db, context, async (tx) => {
      await tx.insert(sandboxV2CommandOutput).values({
        ...output,
        observation: running,
        stdout: Buffer.from("forged").toString("base64"),
      });
      await tx
        .update(sandboxV2Commands)
        .set({ revision: output.revision })
        .where(eq(sandboxV2Commands.operationId, saved.command.operationId));
    });
    await expect(
      loadSandboxJournalCapturedOutput(client.db, context, saved.command),
    ).rejects.toThrow("exact journal bytes");
    for (const mutate of [
      (tx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) =>
        tx
          .update(sandboxV2CommandOutput)
          .set({ stdout: "" })
          .where(eq(sandboxV2CommandOutput.operationId, saved.command.operationId)),
      (tx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) =>
        tx
          .delete(sandboxV2CommandOutput)
          .where(eq(sandboxV2CommandOutput.operationId, saved.command.operationId)),
    ]) {
      let error: unknown;
      try {
        await withRlsContext(client.db, context, mutate);
      } catch (e) {
        error = e;
      }
      expect(nestedPostgresSqlState(error)).toBe("42501");
      const admin = createDb(fixture.adminUrl);
      try {
        let ownerError: unknown;
        try {
          await withRlsContext(admin.db, context, mutate);
        } catch (e) {
          ownerError = e;
        }
        expect(nestedPostgresSqlState(ownerError)).toBe("23514");
      } finally {
        await admin.close();
      }
    }
    expect(await pending(context)).toBe(true);
  }, 60_000);
  test("deferred output validation cannot skip a private command hidden by a changed subject", async () => {
    const { context, grant } = await owned(true);
    const saved = await command(context);
    const observation: SandboxJournalObservation = {
      ...terminal(saved, ""),
      state: "running",
      receipt: null,
      stdout: { offset: 0, nextOffset: 0, data: "", eof: false },
      stderr: { offset: 0, nextOffset: 0, data: "", eof: false },
    };
    for (const advance of [false, true]) {
      let error: unknown;
      try {
        await withRlsContext(client.db, context, async (tx) => {
          await setSubjectRlsContext(tx, grant.subjectId);
          await tx.insert(sandboxV2CommandOutput).values({
            accountId: context.accountId,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            operationId: saved.command.operationId,
            acceptedActionId: context.acceptedActionId,
            revision: saved.revision + 1,
            observation,
            stdout: "",
            stderr: "",
          });
          if (advance)
            await tx
              .update(sandboxV2Commands)
              .set({ revision: saved.revision + 1 })
              .where(eq(sandboxV2Commands.operationId, saved.command.operationId));
          await setSubjectRlsContext(tx, `user:${crypto.randomUUID()}`);
          const scope = sql`select current_setting('opengeni.account_id',true) as account,
            current_setting('opengeni.workspace_id',true) as workspace,
            current_setting('opengeni.subject_id',true) as subject`;
          const before = await tx.execute(scope);
          expect(
            await tx
              .select()
              .from(sandboxV2Commands)
              .where(eq(sandboxV2Commands.operationId, saved.command.operationId)),
          ).toEqual([]);
          await tx.execute(sql`set constraints sandbox_v2_command_output_commit immediate`);
          expect(await tx.execute(scope)).toEqual(before);
          expect(
            await tx
              .select()
              .from(sandboxV2Commands)
              .where(eq(sandboxV2Commands.operationId, saved.command.operationId)),
          ).toEqual([]);
        });
      } catch (failure) {
        error = failure;
      }
      expect(nestedPostgresSqlState(error)).toBe(advance ? null : "23514");
    }
    expect(await loadSandboxJournalCapturedOutput(client.db, context, saved.command)).toEqual({
      stdout: "",
      stderr: "",
      observation,
    });
  }, 60_000);
  test("Pause wins before late output/proof commit and leaves unresolved writer demand intact", async () => {
    const { context, grant } = await owned();
    const saved = await command(context);
    const page = terminal(saved);
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      context.workspaceId,
      grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: context.accountId,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "pause",
          }),
        ),
    );
    const next = {
      ...saved,
      revision: saved.revision + 1,
      stdout: { offset: page.stdout.nextOffset, remainder: "" },
    };
    await expect(
      captureSandboxJournalOutput(client.db, context, {
        expected: saved,
        next,
        observation: page,
        stdout: "😀\0",
        stderr: "",
      }),
    ).rejects.toThrow("authority rejected");
    await expect(
      recordSandboxJournalControlProof(client.db, context, saved.command, page),
    ).rejects.toThrow("authority rejected");
    expect(await pending(context)).toBe(true);
    let error: unknown;
    try {
      await withRlsContext(client.db, context, (tx) =>
        tx
          .update(sandboxV2Commands)
          .set({
            revision: saved.revision + 1,
            proof: {
              operationId: saved.command.operationId,
              state: "cancelled",
            } as SandboxJournalObservation,
          })
          .where(eq(sandboxV2Commands.operationId, saved.command.operationId)),
      );
    } catch (e) {
      error = e;
    }
    expect(nestedPostgresSqlState(error)).toBe("23514");
    expect(await pending(context)).toBe(true);
  }, 60_000);
  test("logical turn completion cannot erase unresolved journal writers or their machine", async () => {
    const { context, grant } = await owned();
    const saved = await command(context);
    const turn = await getSessionTurn(client.db, context.workspaceId, context.turnId);
    const settled = await applySessionTurnSettlement(client.db, context.workspaceId, {
      sessionId: context.sessionId,
      turnId: context.turnId,
      triggerEventId: turn!.triggerEventId,
      attemptId: context.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "synthetic" } }],
    });
    expect(settled.action).toBe("settled");
    expect(await pending(context)).toBe(true);
    expect(
      (
        await deleteSessionTreeIfQuiescent(client.db, {
          workspaceId: context.workspaceId,
          subjectId: grant.subjectId,
          sessionId: context.sessionId,
        })
      ).status,
    ).toBe("live_sandboxes");
    let error: unknown;
    try {
      await withRlsContext(client.db, context, (tx) =>
        tx.execute(sql`delete from sessions
      where id=${context.sessionId}::uuid and workspace_id=${context.workspaceId}::uuid`),
      );
    } catch (e) {
      error = e;
    }
    expect(nestedPostgresSqlState(error)).toBe("55000");
    expect(
      await withRlsContext(client.db, context, (tx) =>
        tx
          .select()
          .from(sandboxV2Commands)
          .where(eq(sandboxV2Commands.operationId, saved.command.operationId)),
      ),
    ).toHaveLength(1);
  }, 60_000);
  test("control settlement after Pause requires physical receipt and grants no agent capture authority", async () => {
    const { context, grant, session } = await owned();
    const saved = await command(context);
    const page = terminal(saved, "");
    await assertSandboxJournalControl(client.db, context, saved.command, "read");
    await expect(
      assertSandboxJournalControl(client.db, context, saved.command, "cancel"),
    ).rejects.toThrow("requires revoked agent authority");
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      context.workspaceId,
      grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: context.accountId,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "pause",
          }),
        ),
    );
    await assertSandboxJournalControl(client.db, context, saved.command, "cancel");
    await expect(
      settleSandboxJournalControl(client.db, context, saved.command, {
        ...page,
        state: "unknown",
        receipt: null,
        stdout: { ...page.stdout, eof: false },
        stderr: { ...page.stderr, eof: false },
      }),
    ).rejects.toThrow("No physical terminal evidence");
    expect(await pending(context)).toBe(true);
    await settleSandboxJournalControl(client.db, context, saved.command, page);
    await settleSandboxJournalControl(client.db, context, saved.command, page);
    expect(await pending(context)).toBe(false);
    const machine = await findSandboxMachine(client.db, {
      ...context,
      sandboxGroupId: session.sandboxGroupId,
    });
    expect(machine!.demands).toHaveLength(0);
    const rows = await withRlsContext(client.db, context, (tx) =>
      tx
        .select()
        .from(sandboxV2CommandOutput)
        .where(eq(sandboxV2CommandOutput.operationId, saved.command.operationId)),
    );
    expect(rows).toHaveLength(0);
    await expect(
      recordSandboxJournalControlProof(client.db, context, saved.command, page),
    ).rejects.toThrow("authority rejected");
  }, 60_000);
  test("direct SQL rejects protocol-type confusion, invalid UUIDs and unadmitted input receipts", async () => {
    const { context } = await owned();
    const saved = await command(context);
    const page = terminal(saved, "");
    const canonical = {
      ...page,
      stdout: { offset: 0, nextOffset: 0, data: "", eof: true },
      stderr: { offset: 0, nextOffset: 0, data: "", eof: true },
    };
    const badProofs = [
      { ...canonical, receipt: null },
      {
        ...canonical,
        receipt: {
          ...canonical.receipt!,
          receiptId: "11111111-1111-1111-1111-111111111111",
        },
      },
      {
        ...canonical,
        receipt: { ...canonical.receipt!, acceptedInputSequence: 1 },
      },
      {
        ...canonical,
        receipt: { ...canonical.receipt!, extra: "not-protocol" },
      },
    ];
    for (const proof of badProofs) {
      let error: unknown;
      try {
        await withRlsContext(client.db, context, (tx) =>
          tx
            .update(sandboxV2Commands)
            .set({ revision: saved.revision + 1, proof })
            .where(eq(sandboxV2Commands.operationId, saved.command.operationId)),
        );
      } catch (e) {
        error = e;
      }
      expect(nestedPostgresSqlState(error)).toBe("23514");
    }
    let error: unknown;
    try {
      await withRlsContext(client.db, context, (tx) =>
        tx.execute(sql`update sandbox_v2_commands
      set revision=revision+1, proof=${JSON.stringify(canonical)}::jsonb ||
        jsonb_build_object('specificationDigest',${saved.command.specificationDigest}::numeric)
      where operation_id=${saved.command.operationId}::uuid`),
      );
    } catch (e) {
      error = e;
    }
    expect(nestedPostgresSqlState(error)).toBe("23514");
    expect(await pending(context)).toBe(true);
  }, 60_000);
  test("wrong attempt and direct deletion cannot replace retained dispatch authority", async () => {
    const { context } = await owned();
    const saved = await command(context);
    await expect(
      loadSandboxJournalCommand(
        client.db,
        { ...context, attemptId: crypto.randomUUID() },
        { handle: saved.handle },
      ),
    ).rejects.toThrow("authority rejected");
    let error: unknown;
    try {
      await withRlsContext(client.db, context, (tx) =>
        tx
          .delete(sandboxV2Commands)
          .where(eq(sandboxV2Commands.operationId, saved.command.operationId)),
      );
    } catch (e) {
      error = e;
    }
    expect(nestedPostgresSqlState(error)).toBe("42501");
    const owner = createDb(fixture.adminUrl);
    try {
      let ownerError: unknown;
      try {
        await withRlsContext(owner.db, context, (tx) =>
          tx
            .delete(sandboxV2Commands)
            .where(eq(sandboxV2Commands.operationId, saved.command.operationId)),
        );
      } catch (e) {
        ownerError = e;
      }
      expect(nestedPostgresSqlState(ownerError)).toBe("23514");
    } finally {
      await owner.close();
    }
  }, 60_000);
  test("direct SQL cannot invent bytes through an impossible UTF-8 cursor", async () => {
    const { context } = await owned();
    const saved = await command(context);
    for (const cursor of [
      { offset: 0, remainder: "8J+Y" },
      { offset: 1, remainder: "YQ==" },
      { offset: 3, remainder: "gA==" },
      { offset: 3, remainder: "7aA=" },
    ]) {
      let error: unknown;
      try {
        await withRlsContext(client.db, context, (tx) =>
          tx
            .update(sandboxV2Commands)
            .set({ revision: saved.revision + 1, stdout: cursor })
            .where(eq(sandboxV2Commands.operationId, saved.command.operationId)),
        );
      } catch (e) {
        error = e;
      }
      expect(nestedPostgresSqlState(error)).toBe("23514");
    }
    const page = {
      ...terminal(saved, ""),
      state: "running" as const,
      receipt: null,
      stdout: { offset: 0, nextOffset: 3, data: "8J+Y", eof: false },
      stderr: { offset: 0, nextOffset: 0, data: "", eof: false },
    };
    const next = {
      ...saved,
      revision: saved.revision + 1,
      stdout: { offset: 3, remainder: "8J+Y" },
    };
    expect(
      await captureSandboxJournalOutput(client.db, context, {
        expected: saved,
        next,
        observation: page,
        stdout: "",
        stderr: "",
      }),
    ).toBe(true);
  }, 60_000);
});
