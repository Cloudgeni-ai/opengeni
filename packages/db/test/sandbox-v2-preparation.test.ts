import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type {
  ResourceRef,
  SandboxV2PreparationPlan,
  RunCredentialsResolution,
} from "@opengeni/contracts";
import {
  acquireSandboxMachineForAttempt,
  allocateSandboxJournalOperation,
  allocateSandboxV2BackgroundOperation,
  assertSandboxJournalControl,
  captureSandboxJournalOutput,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  compareAndSetSandboxMachine,
  configureSandboxV2AdmissionPolicy,
  clearSandboxV2CredentialGenerationsForQuiescedAttempt,
  createDb,
  createSession,
  encryptEnvironmentValue,
  findSandboxMachine,
  listPendingSandboxJournalCommands,
  listSandboxV2BackgroundOwnersForControl,
  loadSandboxJournalCommand,
  loadSandboxV2PreparationPlan,
  loadSandboxV2TurnFileResources,
  loadSandboxV2CredentialGeneration,
  loadSandboxV2CredentialGenerationMetadata,
  nestedPostgresSqlState,
  loadSandboxV2BackgroundCredentialGeneration,
  retainSandboxV2BackgroundCredentialGeneration,
  retainSandboxV2BackgroundOwner,
  readSandboxJournalAttemptWriters,
  reserveSandboxJournalCommand,
  reserveSandboxJournalInput,
  requestSandboxV2BackgroundExpiredCredentialCancellation,
  retainSandboxV2PreparationPlan,
  retainSandboxV2CredentialGeneration,
  retainSandboxV2CredentialOwner,
  loadSandboxV2CredentialOwner,
  activateSandboxV2CredentialTicket,
  reserveSandboxV2CredentialRenewal,
  sandboxV2CredentialWriterIdentity,
  submitHumanPromptInTransaction,
  updateWorkspaceSettings,
  withWorkspaceSubjectSessionActivityRls,
  type SandboxJournalControlAuthority,
  type RetainedSandboxV2CredentialGeneration,
  type SessionActivityDatabase,
} from "../src";
import { mutateSessionControlInTransaction } from "../src/session-control";
import { sql } from "drizzle-orm";
import { withRlsContext } from "../src/database";

let fixture: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("sandbox-v2-preparation");
  if (!acquired) throw new Error("Preparation retention requires disposable PostgreSQL");
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

async function owner(
  sessionResources: ResourceRef[] = [],
): Promise<SandboxJournalControlAuthority & { subjectId: string }> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Synthetic retained preparation",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Synthetic retained preparation",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  await updateWorkspaceSettings(client.db, workspaceId, { sandboxV2Enabled: true });
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "synthetic preparation",
    resources: sessionResources,
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "docker",
  });
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
        text: "synthetic preparation",
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
  if (claimed.action !== "claimed") throw new Error("Synthetic preparation was not claimed");
  const machine = await findSandboxMachine(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sandboxGroupId: session.sandboxGroupId,
  });
  if (!machine) throw new Error("Synthetic machine was not admitted");
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
  const authority = {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: claimed.turn.id,
    executionGeneration: claimed.turn.executionGeneration,
    attemptId,
    machineId: machine.id,
    instance,
  };
  await acquireSandboxMachineForAttempt(client.db, authority);
  return { ...authority, subjectId: grant.subjectId };
}
function definition(): SandboxV2PreparationPlan {
  return {
    setupId: "synthetic-turn-plan",
    credentialGenerationId: "synthetic-retained-generation",
    steps: [
      { stepId: "prepare-workspace", command: { cmd: "printf synthetic", yieldTimeMs: 120000 } },
    ],
    files: [
      {
        fileId: "synthetic-finalized-file",
        filename: "sample.txt",
        mountPath: "files/sample",
        sizeBytes: 12,
        sha256: "b".repeat(64),
      },
    ],
  };
}

test("credential owner freezes its initial pending generation before broker I/O", async () => {
  const authority = await owner();
  const plan = definition();
  const input = { setupId: plan.setupId, initialGenerationId: plan.credentialGenerationId! };
  await expect(retainSandboxV2CredentialOwner(client.db, authority, input)).rejects.toThrow(
    "unavailable or changed",
  );
  await retainSandboxV2PreparationPlan(client.db, authority, plan);
  const heads = await Promise.all(
    Array.from({ length: 8 }, () => retainSandboxV2CredentialOwner(client.db, authority, input)),
  );
  const head = heads[0]!;
  for (const value of heads) expect(value).toEqual(head);
  expect(head.version).toBe(0);
  expect(head.active).toBeNull();
  expect(head.pending).toEqual({
    ordinal: 0,
    definition: {
      generationId: input.initialGenerationId,
      purpose: "provision",
      forceRefresh: false,
    },
    writerActionId: sandboxV2CredentialWriterIdentity(input.setupId, input.initialGenerationId)
      .writerActionId,
  });
  await expect(
    activateSandboxV2CredentialTicket(client.db, authority, {
      setupId: plan.setupId,
      ticket: head.pending!,
    }),
  ).rejects.toThrow("unavailable or changed");
  await expect(
    reserveSandboxV2CredentialRenewal(client.db, authority, {
      setupId: plan.setupId,
      expectedGenerationId: input.initialGenerationId,
    }),
  ).rejects.toThrow("unavailable or changed");
  await expect(
    retainSandboxV2CredentialOwner(client.db, authority, {
      ...input,
      initialGenerationId: "changed-original",
    }),
  ).rejects.toThrow("unavailable or changed");
  await expect(
    loadSandboxV2CredentialOwner(
      client.db,
      { ...authority, machineId: crypto.randomUUID() },
      input.setupId,
    ),
  ).rejects.toThrow();
  expect(await loadSandboxV2CredentialOwner(client.db, authority, input.setupId)).toEqual(head);
});

test("credential owner SQL guard rejects pending replacement and activation without a writer receipt", async () => {
  const authority = await owner();
  const plan = definition();
  await retainSandboxV2PreparationPlan(client.db, authority, plan);
  const head = await retainSandboxV2CredentialOwner(client.db, authority, {
    setupId: plan.setupId,
    initialGenerationId: plan.credentialGenerationId!,
  });
  for (const update of [
    sql`update sandbox_v2_credential_owners set active=pending,pending=null,version=version+1 where attempt_id=${authority.attemptId}::uuid`,
    sql`update sandbox_v2_credential_owners set pending=null,version=version+1 where attempt_id=${authority.attemptId}::uuid`,
    sql`update sandbox_v2_credential_owners set version=version+2 where attempt_id=${authority.attemptId}::uuid`,
  ]) {
    let error: unknown;
    try {
      await withRlsContext(client.db, authority, (tx) => tx.execute(update));
    } catch (value) {
      error = value;
    }
    expect(nestedPostgresSqlState(error)).toBe("23514");
  }
  let deleteError: unknown;
  try {
    await withRlsContext(client.db, authority, (tx) =>
      tx.execute(
        sql`delete from sandbox_v2_credential_owners where attempt_id=${authority.attemptId}::uuid`,
      ),
    );
  } catch (error) {
    deleteError = error;
  }
  expect(nestedPostgresSqlState(deleteError)).toBe("42501");
  expect(await loadSandboxV2CredentialOwner(client.db, authority, plan.setupId)).toEqual(head);
  for (const [setupId, generationId] of [
    ["ordinary-setup", "ordinary-generation"],
    ['quoted"\\\nsetup', "generation-😀"],
  ]) {
    const rows = await withRlsContext(client.db, authority, (tx) =>
      tx.execute<{ id: string }>(
        sql`select sandbox_v2_credential_writer_action(${setupId!},${generationId!}) as id`,
      ),
    );
    expect(rows[0]!.id).toBe(
      sandboxV2CredentialWriterIdentity(setupId!, generationId!).writerActionId,
    );
  }
  const [metadata] = await fixture.admin<
    { rls: boolean; forced: boolean }[]
  >`select relrowsecurity as rls,relforcerowsecurity as forced from pg_class where oid='sandbox_v2_credential_owners'::regclass`;
  expect(metadata).toEqual({ rls: true, forced: true });
  // Parent cleanup may remove retained metadata; a direct runtime delete may
  // not. Exercise the owner alongside its plan, session and machine FKs.
  await fixture.admin`delete from workspaces where id=${authority.workspaceId}::uuid`;
  const [remaining] = await fixture.admin<
    { count: number }[]
  >`select count(*)::integer as count from sandbox_v2_credential_owners where workspace_id=${authority.workspaceId}::uuid`;
  expect(remaining!.count).toBe(0);
});

test("concurrent same-attempt preparation retains one immutable complete host plan", async () => {
  const authority = await owner();
  const plan = definition();
  expect(await loadSandboxV2PreparationPlan(client.db, authority, plan.setupId)).toBeNull();
  const retained = await Promise.all([
    retainSandboxV2PreparationPlan(client.db, authority, plan),
    retainSandboxV2PreparationPlan(client.db, authority, structuredClone(plan)),
  ]);
  expect(retained).toEqual([plan, plan]);
  const loaded = await loadSandboxV2PreparationPlan(client.db, authority, plan.setupId);
  expect(loaded).toEqual(plan);
  loaded!.steps[0]!.command.cmd = "observer-only change";
  expect(await loadSandboxV2PreparationPlan(client.db, authority, plan.setupId)).toEqual(plan);
  const [count] = await fixture.admin<{ count: number }[]>`
    select count(*)::integer as count from sandbox_v2_preparation_plans where turn_id=${authority.turnId}`;
  expect(count!.count).toBe(1);
  for (const changed of [
    { ...plan, steps: [{ ...plan.steps[0]!, command: { cmd: "printf changed" } }] },
    { ...plan, credentialGenerationId: "replacement-generation" },
    { ...plan, files: [{ ...plan.files[0]!, sha256: "c".repeat(64) }] },
  ]) {
    await expect(retainSandboxV2PreparationPlan(client.db, authority, changed)).rejects.toThrow(
      "Retained native preparation plan or authority changed",
    );
  }
});

test("host plan cannot retain input material or cross an attempt/incarnation/tenant fence", async () => {
  const authority = await owner();
  const plan = definition();
  await retainSandboxV2PreparationPlan(client.db, authority, plan);
  for (const changed of [
    { ...authority, attemptId: crypto.randomUUID() },
    { ...authority, machineId: crypto.randomUUID() },
    { ...authority, instance: { ...authority.instance, bootId: "d".repeat(64) } },
    { ...authority, accountId: crypto.randomUUID() },
  ]) {
    await expect(loadSandboxV2PreparationPlan(client.db, changed, plan.setupId)).rejects.toThrow();
    await expect(loadSandboxV2TurnFileResources(client.db, changed)).rejects.toThrow();
  }
  for (const invalid of [
    {
      ...plan,
      setupId: "invalid-environment",
      environment: { SYNTHETIC_TOKEN: "must-not-retain" },
    },
    { ...plan, setupId: "invalid-stdin", steps: [{ ...plan.steps[0]!, stdin: "must-not-retain" }] },
    {
      ...plan,
      setupId: "invalid-url",
      files: [{ ...plan.files[0]!, url: "https://example.test/signed" }],
    },
    { ...plan, setupId: "invalid-duplicates", steps: [plan.steps[0]!, plan.steps[0]!] },
  ]) {
    await expect(retainSandboxV2PreparationPlan(client.db, authority, invalid)).rejects.toThrow(
      "Retained native preparation plan",
    );
  }
  const rows = await fixture.admin<{ definition: unknown }[]>`
    select definition from sandbox_v2_preparation_plans where turn_id=${authority.turnId}`;
  expect(rows.map((row) => row.definition)).toEqual([plan]);
});

test("compound workspace definitions retain metadata only and reject changed requests or snapshots", async () => {
  const authority = await owner();
  const operationId = crypto.randomUUID();
  const plan: SandboxV2PreparationPlan = {
    setupId: `workspace-operation:v1:${operationId}`,
    workspaceRoot: "/workspace",
    workspaceOperation: {
      operationId,
      requestDigest: "a".repeat(64),
      sourceSnapshotDigest: "b".repeat(64),
    },
    steps: [],
    files: [],
  };
  expect(await retainSandboxV2PreparationPlan(client.db, authority, plan)).toEqual(plan);
  expect(await retainSandboxV2PreparationPlan(client.db, authority, structuredClone(plan))).toEqual(
    plan,
  );
  for (const changed of [
    { ...plan, workspaceOperation: { ...plan.workspaceOperation!, requestDigest: "c".repeat(64) } },
    {
      ...plan,
      workspaceOperation: { ...plan.workspaceOperation!, sourceSnapshotDigest: "d".repeat(64) },
    },
    { ...plan, workspaceOperation: undefined },
    { ...plan, steps: [{ stepId: "unexpected-setup", command: { cmd: "printf unexpected" } }] },
    { ...plan, credentialGenerationId: "unexpected-generation" },
    { ...plan, setupId: `workspace-operation:v1:${crypto.randomUUID()}` },
  ])
    await expect(retainSandboxV2PreparationPlan(client.db, authority, changed)).rejects.toThrow(
      "Retained native preparation plan",
    );
  expect(await loadSandboxV2PreparationPlan(client.db, authority, plan.setupId)).toEqual(plan);
});

test("background credentials preserve the sealed original under current job grants", async () => {
  const {
    createSandboxV2BackgroundCredentialGenerationOwner,
    buildSandboxV2BackgroundCredentialCleanupRequest,
  } = await import("@opengeni/core");
  const { journalSpecificationDigest } = await import("@opengeni/runtime/sandbox");
  const origin = await owner();
  const jobId = await allocateSandboxV2BackgroundOperation(
    client.db,
    { ...origin, acceptedActionId: "synthetic-job-copy" },
    {
      requestDigest: "a".repeat(64),
      commandText: "printf ordinary-job",
    },
  );
  const authority = { ...origin, jobId };
  const jobDefinition = {
    generationId: "job-original",
    purpose: "provision" as const,
    forceRefresh: false,
  };
  const key = new Uint8Array(32).fill(7);
  let allowed = true;
  const authorize = async () => {
    if (!allowed) throw new Error("Synthetic current job grant withdrawn");
  };
  const source: RunCredentialsResolution = {
    accountId: origin.accountId,
    workspaceId: origin.workspaceId,
    sessionId: origin.sessionId,
    status: "ok",
    environment: { SYNTHETIC_JOB_VALUE: "original-job-material" },
    files: [{ path: "tokens/value.txt", content: "original-job-file", mode: "0600" }],
    fileEnvironment: { SYNTHETIC_JOB_FILE: "tokens/value.txt" },
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  const originalOwner = createSandboxV2BackgroundCredentialGenerationOwner(
    client.db,
    authority,
    jobDefinition,
    { encryptionKey: key, authorize, source },
  );
  source.environment.SYNTHETIC_JOB_VALUE = "caller changed source";
  const resolution = await originalOwner.resolveGeneration();
  expect(resolution).toMatchObject({
    status: "ok",
    environment: { SYNTHETIC_JOB_VALUE: "original-job-material" },
  });
  // Sealing alone cannot acknowledge guest delivery or delegate a writer.
  await expect(retainSandboxV2BackgroundOwner(client.db, authority)).rejects.toThrow();
  let prematureOwner: unknown;
  try {
    await fixture.admin`insert into sandbox_v2_background_owners
      (account_id,workspace_id,session_id,job_id,turn_id,attempt_id,execution_generation,
       machine_id,instance,generation_id,writer_action_id,cleanup_operation_id)
      select account_id,workspace_id,session_id,job_id,turn_id,attempt_id,execution_generation,
       machine_id,instance,generation_id,writer_action_id,cleanup_operation_id
      from sandbox_v2_background_credentials where job_id=${jobId}`;
  } catch (error) {
    prematureOwner = error;
  }
  expect(nestedPostgresSqlState(prematureOwner)).toBe("23514");
  const [notOwned] = await fixture.admin<
    { count: number }[]
  >`select count(*)::integer as count from sandbox_v2_background_owners where job_id=${jobId}`;
  expect(notOwned?.count).toBe(0);
  const tenant = {
    accountId: origin.accountId,
    workspaceId: origin.workspaceId,
    machineId: origin.machineId,
  };
  expect(
    (await listSandboxV2BackgroundOwnersForControl(client.db, tenant, { jobId })).items,
  ).toEqual([]);
  const pendingCustody = await listSandboxV2BackgroundOwnersForControl(client.db, tenant, {
    jobId,
    includeUnregistered: true,
  });
  expect(pendingCustody.items).toHaveLength(1);
  expect(pendingCustody.items[0]?.authority).toMatchObject({
    jobId,
    sessionId: origin.sessionId,
    attemptId: origin.attemptId,
    instance: origin.instance,
  });
  expect(pendingCustody.nextJobId).toBeNull();
  expect(JSON.stringify(pendingCustody)).not.toContain("original-job-material");
  expect(JSON.stringify(pendingCustody)).not.toContain("ciphertext");
  const recovered = () =>
    createSandboxV2BackgroundCredentialGenerationOwner(client.db, authority, jobDefinition, {
      encryptionKey: key,
      authorize,
    });
  expect(await recovered().resolveGeneration()).toEqual(resolution);
  const sealed = await loadSandboxV2BackgroundCredentialGeneration(
    client.db,
    authority,
    jobDefinition,
  );
  expect(sealed?.ciphertext).not.toContain("original-job-material");
  expect(sealed?.ciphertext).not.toContain("original-job-file");
  expect(
    await createSandboxV2BackgroundCredentialGenerationOwner(client.db, authority, jobDefinition, {
      encryptionKey: key,
      authorize,
      source,
    }).resolveGeneration(),
  ).toEqual(resolution);
  await expect(
    createSandboxV2BackgroundCredentialGenerationOwner(client.db, authority, jobDefinition, {
      encryptionKey: new Uint8Array(32).fill(8),
      authorize,
    }).resolveGeneration(),
  ).rejects.toThrow("unavailable or changed");
  await expect(
    createSandboxV2BackgroundCredentialGenerationOwner(
      client.db,
      authority,
      { ...jobDefinition, generationId: "changed" },
      { encryptionKey: key, authorize },
    ).resolveGeneration(),
  ).rejects.toThrow("unavailable or changed");
  allowed = false;
  await expect(recovered().resolveGeneration()).rejects.toThrow("current job grant withdrawn");
  allowed = true;
  const otherJobId = await allocateSandboxV2BackgroundOperation(
    client.db,
    { ...origin, acceptedActionId: "synthetic-other-job-copy" },
    { requestDigest: "b".repeat(64), commandText: "printf ordinary-other-job" },
  );
  const other = { ...origin, jobId: otherJobId };
  await retainSandboxV2BackgroundCredentialGeneration(
    client.db,
    other,
    jobDefinition,
    sealed!,
    (operationId) =>
      journalSpecificationDigest(
        buildSandboxV2BackgroundCredentialCleanupRequest(other, operationId),
      ),
  );
  await expect(
    createSandboxV2BackgroundCredentialGenerationOwner(client.db, other, jobDefinition, {
      encryptionKey: key,
      authorize,
    }).resolveGeneration(),
  ).rejects.toThrow("unavailable or changed");
  const [posture] = await fixture.admin<
    {
      forced: boolean;
      selectable: boolean;
      insertable: boolean;
      mutable: boolean;
      deletable: boolean;
    }[]
  >`
    select relforcerowsecurity as forced,
      has_table_privilege('opengeni_app','sandbox_v2_background_credentials','SELECT') as selectable,
      has_table_privilege('opengeni_app','sandbox_v2_background_credentials','INSERT') as insertable,
      has_table_privilege('opengeni_app','sandbox_v2_background_credentials','UPDATE') as mutable,
      has_table_privilege('opengeni_app','sandbox_v2_background_credentials','DELETE') as deletable
    from pg_class where oid='sandbox_v2_background_credentials'::regclass`;
  expect(posture).toEqual({
    forced: true,
    selectable: true,
    insertable: true,
    mutable: true,
    deletable: false,
  });
});

test("only a preowned bound job leaves turn control; missing cleanup demand holds its writer gate", async () => {
  // Pure database/protocol fixture. No provider or guest process exists.
  const { createSandboxV2BackgroundCredentialGenerationOwner } = await import("@opengeni/core");
  const origin = await owner();
  const jobContext = { ...origin, acceptedActionId: "synthetic-independent-job" };
  const jobId = await allocateSandboxV2BackgroundOperation(client.db, jobContext, {
    requestDigest: "c".repeat(64),
    commandText: "synthetic ordinary job",
  });
  const authority = { ...origin, jobId };
  const jobDefinition = {
    generationId: "synthetic-independent-original",
    purpose: "provision" as const,
    forceRefresh: false,
  };
  await createSandboxV2BackgroundCredentialGenerationOwner(client.db, authority, jobDefinition, {
    encryptionKey: new Uint8Array(32).fill(9),
    authorize: async () => {},
    source: {
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      sessionId: origin.sessionId,
      status: "ok",
      environment: { SYNTHETIC_JOB: "original" },
      files: [],
      fileEnvironment: {},
      expiresAt: null,
    },
  }).resolveGeneration();
  const generation = await loadSandboxV2BackgroundCredentialGeneration(
    client.db,
    authority,
    jobDefinition,
  );
  expect(generation).not.toBeNull();
  const [custody] = await fixture.admin<{ writerActionId: string; cleanupOperationId: string }[]>`
    select writer_action_id as "writerActionId",cleanup_operation_id as "cleanupOperationId"
    from sandbox_v2_background_credentials where job_id=${jobId}`;
  if (!custody) throw Error("Synthetic original custody missing");
  const writerContext = { ...origin, acceptedActionId: custody.writerActionId };
  const writerId = await allocateSandboxJournalOperation(client.db, writerContext, "d".repeat(64));
  const binding = (operationId: string, stdin: boolean) => ({
    kind: "machine-journal-v1" as const,
    operationId,
    machineId: origin.machineId,
    bootId: origin.instance.bootId,
    diskLineage: origin.instance.diskLineage,
    specificationDigest: "e".repeat(64),
    stdin,
    pty: false,
  });
  const writer = binding(writerId, true);
  await reserveSandboxJournalCommand(client.db, writerContext, writer);
  for (const partIndex of [0, 1])
    await reserveSandboxJournalInput(client.db, writerContext, {
      command: writer,
      requestDigest: "f".repeat(64),
      partIndex,
      partCount: 2,
      actionDigest: "a".repeat(64),
    });
  const expected = await loadSandboxJournalCommand(client.db, writerContext, {
    operationId: writerId,
  });
  if (!expected) throw Error("Synthetic credential writer missing");
  expect(
    await captureSandboxJournalOutput(client.db, writerContext, {
      expected,
      next: { ...expected, revision: expected.revision + 1, stdout: { offset: 9, remainder: "" } },
      observation: {
        operationId: writerId,
        specificationDigest: writer.specificationDigest,
        state: "exited",
        receipt: {
          protocol: "native-subreaper-v1",
          invocationId: writerId,
          receiptId: crypto.randomUUID(),
          leaderExitCode: 0,
          acceptedInputSequence: 2,
        },
        stdout: {
          offset: 0,
          nextOffset: 9,
          data: Buffer.from("installed").toString("base64"),
          eof: true,
        },
        stderr: { offset: 0, nextOffset: 0, data: "", eof: true },
      },
      stdout: "installed",
      stderr: "",
    }),
  ).toBe(true);
  await retainSandboxV2BackgroundOwner(client.db, authority);
  const unbound = await readSandboxJournalAttemptWriters(client.db, origin);
  expect(unbound.pending).toBe(true);
  expect(unbound.commands.map((command) => command.operationId)).toContain(jobId);
  const job = binding(jobId, false);
  await reserveSandboxJournalCommand(client.db, jobContext, job);
  const owned = await readSandboxJournalAttemptWriters(client.db, origin);
  expect(owned.pending).toBe(false);
  expect(owned.commands).toEqual([]);
  const tenant = {
    accountId: origin.accountId,
    workspaceId: origin.workspaceId,
    machineId: origin.machineId,
  };
  expect((await listPendingSandboxJournalCommands(client.db, tenant)).items).toEqual([]);
  await expect(assertSandboxJournalControl(client.db, origin, job, "read")).rejects.toThrow(
    "requires its independent control owner",
  );
  const other = await owner();
  const hidden = await withRlsContext(client.db, other, (tx) =>
    tx.execute<{ owned: boolean }>(sql`
    select sandbox_v2_command_has_background_owner(${jobId}::uuid) as owned`),
  );
  expect(hidden[0]?.owned).toBe(false);
  const [session] = await fixture.admin<{ sandboxGroupId: string }[]>`
    select sandbox_group_id as "sandboxGroupId" from sessions where id=${origin.sessionId}`;
  const scope = { ...tenant, sandboxGroupId: session!.sandboxGroupId };
  const machine = await findSandboxMachine(client.db, scope);
  if (!machine) throw Error("Synthetic owned machine missing");
  expect(
    await compareAndSetSandboxMachine(client.db, origin.accountId, machine, {
      ...machine,
      version: machine.version + 1,
      demands: machine.demands.filter((demand) => demand.id !== custody.cleanupOperationId),
    }),
  ).toBe(true);
  const broken = await readSandboxJournalAttemptWriters(client.db, origin);
  expect(broken.pending).toBe(true);
  expect(broken.commands).toEqual([]);
  expect((await listPendingSandboxJournalCommands(client.db, tenant)).items).toEqual([]);
  await expect(assertSandboxJournalControl(client.db, origin, job, "read")).rejects.toThrow(
    "requires its independent control owner",
  );
  const current = await findSandboxMachine(client.db, scope);
  if (!current) throw Error("Synthetic retained machine missing");
  expect(
    await compareAndSetSandboxMachine(client.db, origin.accountId, current, {
      ...current,
      version: current.version + 1,
      demands: machine.demands,
    }),
  ).toBe(true);
  expect((await readSandboxJournalAttemptWriters(client.db, origin)).pending).toBe(false);
});

test("expired original prelaunch custody requests cancellation without independent registration or exit proof", async () => {
  const { createSandboxV2BackgroundCredentialGenerationOwner } = await import("@opengeni/core");
  const origin = await owner();
  const jobId = await allocateSandboxV2BackgroundOperation(
    client.db,
    { ...origin, acceptedActionId: "synthetic-prelaunch-expiry" },
    { requestDigest: "e".repeat(64), commandText: "synthetic prelaunch" },
  );
  const authority = { ...origin, jobId };
  const expiresAt = Date.now() + 1000;
  await createSandboxV2BackgroundCredentialGenerationOwner(
    client.db,
    authority,
    {
      generationId: "synthetic-prelaunch-original",
      purpose: "provision",
      forceRefresh: false,
    },
    {
      encryptionKey: new Uint8Array(32).fill(11),
      authorize: async () => {},
      source: {
        accountId: origin.accountId,
        workspaceId: origin.workspaceId,
        sessionId: origin.sessionId,
        status: "ok",
        environment: {},
        files: [],
        fileEnvironment: {},
        expiresAt: new Date(expiresAt).toISOString(),
      },
    },
  ).resolveGeneration();
  expect(await requestSandboxV2BackgroundExpiredCredentialCancellation(client.db, authority)).toBe(
    false,
  );
  await Bun.sleep(Math.max(0, expiresAt - Date.now() + 10));
  const expiredBinding = {
    kind: "machine-journal-v1" as const,
    operationId: jobId,
    machineId: origin.machineId,
    bootId: origin.instance.bootId,
    diskLineage: origin.instance.diskLineage,
    specificationDigest: "b".repeat(64),
    stdin: false,
    pty: false,
  };
  await expect(
    reserveSandboxJournalCommand(
      client.db,
      { ...origin, acceptedActionId: "synthetic-prelaunch-expiry" },
      expiredBinding,
    ),
  ).rejects.toThrow("original credentials expired");
  let rejectedBinding: unknown;
  try {
    await fixture.admin`update sandbox_v2_commands set binding=${fixture.admin.json(expiredBinding)},revision=revision+1 where operation_id=${jobId}`;
  } catch (error) {
    rejectedBinding = error;
  }
  expect(nestedPostgresSqlState(rejectedBinding)).toBe("23514");
  expect(await requestSandboxV2BackgroundExpiredCredentialCancellation(client.db, authority)).toBe(
    true,
  );
  const [state] = await fixture.admin<
    { state: string; bound: boolean; proved: boolean; owners: number }[]
  >`
    select job.state,command.binding is not null as bound,command.proof is not null as proved,
      (select count(*)::integer from sandbox_v2_background_owners where job_id=job.id) as owners
    from session_background_commands job join sandbox_v2_commands command on command.operation_id=job.native_operation_id
    where job.id=${jobId}`;
  expect(state).toEqual({ state: "stopping", bound: false, proved: false, owners: 0 });
});

test("job material and cleanup demand roll back together before delivery", async () => {
  const { createSandboxV2BackgroundCredentialGenerationOwner } = await import("@opengeni/core");
  const origin = await owner();
  const jobId = await allocateSandboxV2BackgroundOperation(
    client.db,
    { ...origin, acceptedActionId: "synthetic-job-custody-rollback" },
    { requestDigest: "c".repeat(64), commandText: "printf ordinary-reserved-job" },
  );
  const authority = { ...origin, jobId };
  const jobDefinition = {
    generationId: "job-custody-original",
    purpose: "provision" as const,
    forceRefresh: false,
  };
  const options = {
    encryptionKey: new Uint8Array(32).fill(13),
    authorize: async () => undefined,
    source: {
      status: "not_applicable" as const,
      accountId: origin.accountId,
      workspaceId: origin.workspaceId,
      sessionId: origin.sessionId,
    },
  };
  const [before] = await fixture.admin<
    { demands: unknown[] }[]
  >`select projection->'demands' as demands from sandbox_v2_machines where id=${origin.machineId}`;
  // Reject only the demand write after this job's material became visible in
  // the same transaction. This proves rollback after INSERT, rather than an
  // earlier SELECT FOR UPDATE permission failure.
  await fixture.admin.unsafe(`CREATE FUNCTION synthetic_reject_job_custody_demand()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS (SELECT 1 FROM sandbox_v2_background_credentials
        WHERE job_id='${jobId}'::uuid AND machine_id=NEW.id) THEN
        RAISE EXCEPTION 'Synthetic job custody demand write failure' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await fixture.admin.unsafe(`CREATE TRIGGER synthetic_job_custody_demand_failure
    BEFORE UPDATE ON sandbox_v2_machines FOR EACH ROW
    EXECUTE FUNCTION synthetic_reject_job_custody_demand()`);
  try {
    const failure = await createSandboxV2BackgroundCredentialGenerationOwner(
      client.db,
      authority,
      jobDefinition,
      options,
    )
      .resolveGeneration()
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(nestedPostgresSqlState(failure)).toBe("23514");
    expect((failure as Error).cause).toMatchObject({
      message: "Synthetic job custody demand write failure",
    });
  } finally {
    await fixture.admin.unsafe(
      "DROP TRIGGER synthetic_job_custody_demand_failure ON sandbox_v2_machines",
    );
    await fixture.admin.unsafe("DROP FUNCTION synthetic_reject_job_custody_demand()");
  }
  const [rolledBack] = await fixture.admin<
    { rows: number; demands: unknown[] }[]
  >`select (select count(*)::integer from sandbox_v2_background_credentials where job_id=${jobId}) as rows,
    projection->'demands' as demands from sandbox_v2_machines where id=${origin.machineId}`;
  expect(rolledBack).toEqual({ rows: 0, demands: before!.demands });
  await createSandboxV2BackgroundCredentialGenerationOwner(
    client.db,
    authority,
    jobDefinition,
    options,
  ).resolveGeneration();
  const [custody] = await fixture.admin<
    { ciphertext: string; cleanupId: string; held: boolean }[]
  >`select credentials.ciphertext,credentials.cleanup_operation_id as "cleanupId",
    machine.projection->'demands' @> jsonb_build_array(jsonb_build_object(
      'id',credentials.cleanup_operation_id::text,'kind','command',
      'owner',credentials.session_id::text,'authority',credentials.job_id::text)) as held
    from sandbox_v2_background_credentials credentials
    join sandbox_v2_machines machine on machine.id=credentials.machine_id
    where credentials.job_id=${jobId}`;
  expect(custody?.cleanupId).not.toBe(jobId);
  expect(custody?.ciphertext.startsWith("v2:")).toBe(true);
  expect(custody?.held).toBe(true);
  const premature = await withRlsContext(client.db, origin, (tx) =>
    tx.execute(sql`update sandbox_v2_background_credentials set ciphertext=null,
      cleared_at=now(),cleanup_revision=cleanup_revision+1 where job_id=${jobId}::uuid`),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(nestedPostgresSqlState(premature)).toBe("23514");
  expect((premature as Error).cause).toMatchObject({
    message: "Job cleanup requires physical settlement of its original writers",
  });
});

test("job credentials recover after origin revocation and cannot create missing material", async () => {
  const { createSandboxV2BackgroundCredentialGenerationOwner } = await import("@opengeni/core");
  const origin = await owner();
  const reserve = async (acceptedActionId: string) =>
    await allocateSandboxV2BackgroundOperation(
      client.db,
      { ...origin, acceptedActionId },
      { requestDigest: "c".repeat(64), commandText: "printf ordinary-recovery-job" },
    );
  const jobId = await reserve("synthetic-retained-job");
  const missingJobId = await reserve("synthetic-missing-job");
  const jobDefinition = {
    generationId: "original-job",
    purpose: "provision" as const,
    forceRefresh: false,
  };
  const key = new Uint8Array(32).fill(9);
  const source: RunCredentialsResolution = {
    accountId: origin.accountId,
    workspaceId: origin.workspaceId,
    sessionId: origin.sessionId,
    status: "ok",
    environment: { SYNTHETIC_JOB_VALUE: "retained-original" },
    files: [],
    fileEnvironment: {},
    expiresAt: null,
  };
  const generation = createSandboxV2BackgroundCredentialGenerationOwner(
    client.db,
    { ...origin, jobId },
    jobDefinition,
    { encryptionKey: key, authorize: async () => {}, source },
  );
  const original = await generation.resolveGeneration();
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    origin.workspaceId,
    origin.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as SessionActivityDatabase, {
          accountId: origin.accountId,
          workspaceId: origin.workspaceId,
          sessionId: origin.sessionId,
          subjectId: origin.subjectId,
          actor: { type: "human", subjectId: origin.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "steer",
          text: "ordinary next prompt",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
  );
  expect(
    await createSandboxV2BackgroundCredentialGenerationOwner(
      client.db,
      { ...origin, jobId },
      jobDefinition,
      { encryptionKey: key, authorize: async () => {} },
    ).resolveGeneration(),
  ).toEqual(original);
  await expect(
    createSandboxV2BackgroundCredentialGenerationOwner(
      client.db,
      { ...origin, jobId: missingJobId },
      jobDefinition,
      {
        encryptionKey: key,
        authorize: async () => {},
        source,
      },
    ).resolveGeneration(),
  ).rejects.toThrow("unavailable or changed");
  const rows = await fixture.admin<
    { count: number }[]
  >`select count(*)::integer as count from sandbox_v2_background_credentials where job_id=${missingJobId}`;
  expect(rows[0]!.count).toBe(0);
});

test("native turn inputs exclude historical session attachments", async () => {
  const authority = await owner([{ kind: "file", fileId: crypto.randomUUID() }]);
  expect(await loadSandboxV2TurnFileResources(client.db, authority)).toEqual({
    resources: [],
    initiatingHumanSubjectId: authority.subjectId,
  });
});

test("encrypted credential generations converge, remain immutable and require live exact authority", async () => {
  const authority = await owner();
  const input = {
    generationId: "synthetic-original",
    purpose: "provision" as const,
    forceRefresh: false,
  };
  const key = crypto.getRandomValues(new Uint8Array(32));
  const candidates: RetainedSandboxV2CredentialGeneration[] = [
    crypto.randomUUID(),
    crypto.randomUUID(),
  ].map((value) => ({
    ciphertext: encryptEnvironmentValue(key, value),
    expiresAt: null,
  }));
  const saved = await Promise.all(
    candidates.map((candidate) =>
      retainSandboxV2CredentialGeneration(client.db, authority, input, candidate),
    ),
  );
  expect(saved[0]).toEqual(saved[1]);
  expect(candidates).toContainEqual(saved[0]!);
  expect(await loadSandboxV2CredentialGeneration(client.db, authority, input)).toEqual(saved[0]!);
  expect(await loadSandboxV2CredentialGenerationMetadata(client.db, authority, input)).toEqual({
    expiresAt: null,
  });
  await expect(
    loadSandboxV2CredentialGeneration(client.db, authority, { ...input, forceRefresh: true }),
  ).rejects.toThrow("unavailable or changed");
  for (const changed of [
    { ...authority, attemptId: crypto.randomUUID() },
    { ...authority, instance: { ...authority.instance, bootId: "d".repeat(64) } },
    { ...authority, accountId: crypto.randomUUID() },
  ]) {
    await expect(loadSandboxV2CredentialGeneration(client.db, changed, input)).rejects.toThrow();
  }
  await expect(
    clearSandboxV2CredentialGenerationsForQuiescedAttempt(client.db, authority),
  ).rejects.toThrow();
  let updateError: unknown;
  try {
    await fixture.admin`update sandbox_v2_credential_generations set ciphertext=${candidates[1]!.ciphertext}
      where attempt_id=${authority.attemptId}`;
  } catch (error) {
    updateError = error;
  }
  expect(nestedPostgresSqlState(updateError)).toBe("23514");
  const [posture] = await fixture.admin`
    select relforcerowsecurity as forced,
      has_table_privilege('opengeni_app','sandbox_v2_credential_generations','SELECT') as readable,
      has_table_privilege('opengeni_app','sandbox_v2_credential_generations','INSERT') as insertable,
      has_table_privilege('opengeni_app','sandbox_v2_credential_generations','UPDATE') as clearable,
      has_table_privilege('opengeni_app','sandbox_v2_credential_generations','DELETE') as deletable
    from pg_class where oid='sandbox_v2_credential_generations'::regclass`;
  expect(posture).toEqual({
    forced: true,
    readable: true,
    insertable: true,
    clearable: true,
    deletable: false,
  });
});

test("ciphertext cleanup requires physical quiescence and preserves generation tombstones", async () => {
  const authority = await owner();
  const input = {
    generationId: "synthetic-clear",
    purpose: "provision" as const,
    forceRefresh: false,
  };
  const ciphertext = encryptEnvironmentValue(
    crypto.getRandomValues(new Uint8Array(32)),
    crypto.randomUUID(),
  );
  await retainSandboxV2CredentialGeneration(client.db, authority, input, {
    ciphertext,
    expiresAt: null,
  });
  await fixture.admin`update session_turn_attempts set state='closed',outcome='completed',closed_at=now()
    where id=${authority.attemptId}`;
  await expect(
    clearSandboxV2CredentialGenerationsForQuiescedAttempt(client.db, authority),
  ).rejects.toThrow();
  await fixture.admin`update session_turn_attempts set quiesced_at=now() where id=${authority.attemptId}`;
  expect(await clearSandboxV2CredentialGenerationsForQuiescedAttempt(client.db, authority)).toBe(1);
  expect(await clearSandboxV2CredentialGenerationsForQuiescedAttempt(client.db, authority)).toBe(0);
  const [saved] = await fixture.admin<
    { ciphertext: string | null; cleared: boolean; definition: unknown }[]
  >`
    select ciphertext,cleared_at is not null as cleared,definition from sandbox_v2_credential_generations
    where attempt_id=${authority.attemptId}`;
  expect(saved).toEqual({ ciphertext: null, cleared: true, definition: input });
  await expect(
    retainSandboxV2CredentialGeneration(client.db, authority, input, {
      ciphertext,
      expiresAt: null,
    }),
  ).rejects.toThrow();
});

test("Pause revokes plan reads without erasing the original recovery record", async () => {
  const authority = await owner();
  const plan = definition();
  await retainSandboxV2PreparationPlan(client.db, authority, plan);
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    authority.workspaceId,
    authority.subjectId,
    (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
          ...authority,
          operationKey: crypto.randomUUID(),
          actor: { type: "human", subjectId: authority.subjectId },
          action: "pause",
        }),
      ),
  );
  await expect(loadSandboxV2PreparationPlan(client.db, authority, plan.setupId)).rejects.toThrow(
    "Exact turn-attempt authority rejected",
  );
  await expect(loadSandboxV2TurnFileResources(client.db, authority)).rejects.toThrow(
    "Exact turn-attempt authority rejected",
  );
  const [saved] = await fixture.admin<{ definition: unknown }[]>`
    select definition from sandbox_v2_preparation_plans where turn_id=${authority.turnId}`;
  expect(saved!.definition).toEqual(plan);
});

test("plan table is FORCE-RLS, session-restricted and append-only at the database boundary", async () => {
  const authority = await owner();
  const plan = definition();
  await retainSandboxV2PreparationPlan(client.db, authority, plan);
  const [posture] = await fixture.admin`
    select relforcerowsecurity as forced,
      has_table_privilege('opengeni_app','sandbox_v2_preparation_plans','SELECT') as readable,
      has_table_privilege('opengeni_app','sandbox_v2_preparation_plans','INSERT') as insertable,
      has_table_privilege('opengeni_app','sandbox_v2_preparation_plans','UPDATE') as updatable,
      has_table_privilege('opengeni_app','sandbox_v2_preparation_plans','DELETE') as deletable
    from pg_class where oid='sandbox_v2_preparation_plans'::regclass`;
  expect(posture).toEqual({
    forced: true,
    readable: true,
    insertable: true,
    updatable: false,
    deletable: false,
  });
  const [policy] = await fixture.admin`
    select polpermissive from pg_policy where polrelid='sandbox_v2_preparation_plans'::regclass
      and polname='session_visibility_isolation'`;
  expect(policy!.polpermissive).toBe(false);
  let updateError: unknown;
  try {
    await fixture.admin`update sandbox_v2_preparation_plans set definition=definition where turn_id=${authority.turnId}`;
  } catch (error) {
    updateError = error;
  }
  expect(nestedPostgresSqlState(updateError)).toBe("23514");
  let deleteError: unknown;
  try {
    await fixture.admin`delete from sandbox_v2_preparation_plans where turn_id=${authority.turnId}`;
  } catch (error) {
    deleteError = error;
  }
  expect(nestedPostgresSqlState(deleteError)).toBe("23514");
});
