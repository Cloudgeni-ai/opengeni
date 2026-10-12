import { beforeAll, afterAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { ModalBrokerProviderCommand } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getRetainedProcess,
  beginModalProviderCreate,
  recordWarmingSandboxCreated,
  commitWarmingToWarm,
  publishNativeCommandQualification,
  settleRetainedProcess,
  retainedProviderCommandPersistence,
  rejectRetainedBrokerLaunch,
  type DbClient,
} from "@opengeni/db";
import { withRlsContext, rawRows } from "../../db/src/database";
import {
  registerNativeBrokerTransport,
  nativeBrokerTransportStore,
  type NativeBrokerTransportBinding,
} from "@opengeni/db/native-command-broker-transport";
import {
  initialNativeBrokerTransportState,
  NativeBrokerDriver,
  NativeBrokerCoordinator,
  NativeBrokerCommandSession,
  NativeBrokerReconciliationRequiredError,
  NativeBrokerDispatchUnknownError,
  type NativeBrokerChannel,
  readNativeBrokerBootstrap,
  initialNativeBrokerCommandSnapshot,
  projectNativeBrokerCommand,
  NativeBrokerRetainedCommand,
  captureNativeBrokerBootstrap,
  type NativeBrokerArtifactPin,
  type NativeBrokerDiagnosticsChannel,
  type NativeBrokerDiagnosticsFault,
  NativeBrokerInitialDiagnosticsError,
} from "@opengeni/runtime/sandbox";
import { encodeNativeBrokerCommandDefinition } from "../../runtime/src/sandbox/providers/native-command-broker-definition";
import {
  createDurableNativeBrokerTransport,
  registerCapturedNativeBrokerBootstrap,
  registerQualifiedNativeBrokerBootstrap,
  observeDurableNativeBrokerDiagnostics,
} from "../src/native-command-broker-transport";
import {
  encodeNativeBrokerFrame,
  NativeBrokerFrameDecoder,
} from "../../runtime/src/sandbox/providers/native-command-broker-wire";
import type { NativeBrokerOutputPage } from "../../runtime/src/sandbox/providers/native-command-broker-output";
import {
  withCommandSupervisionReady,
  withProviderCommandHandle,
  withSupervisedLaunchReservation,
} from "../../runtime/src/sandbox/provider-command-session";

let database: SharedTestDatabase, client: DbClient;
const key = randomBytes(32);
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("native-broker-transport");
  if (!acquired) throw new Error("Native broker transport tests require isolated PostgreSQL");
  database = acquired;
  client = createDb(database.appUrl, { max: 4 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await database?.release();
}, 60_000);

async function fixture(register = true, qualifiedPin?: NativeBrokerArtifactPin) {
  const unique = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: unique,
    accountName: "Broker",
    workspaceExternalSource: "test",
    workspaceExternalId: unique,
    workspaceName: "Broker",
    subjectId: `test-${unique}`,
  });
  const { accountId, workspaceId, subjectId } = access.workspaceGrants[0]!;
  const createIdempotencyKey = crypto.randomUUID();
  const imageRef = `ghcr.io/cloudgeni-ai/opengeni-desktop@sha256:${"e".repeat(64)}`;
  const providerBindingKey = JSON.stringify({
    version: 1,
    serverUrl: "https://api.modal.test",
    workspaceName: "test",
    environment: "test",
  });
  if (qualifiedPin) {
    const operator = createDb(database.adminUrl, { max: 1 });
    try {
      await publishNativeCommandQualification(operator.db, {
        accountId,
        workspaceId: workspaceId!,
        creatorSubjectId: subjectId,
        createIdempotencyKey,
        id: crypto.randomUUID(),
        activationGeneration: 1,
        sourceSha: "a".repeat(40),
        imageRef,
        providerImageId: "im-bootstrap-fixture",
        providerBindingKey,
        acceptanceEvidenceHash: "f".repeat(64),
        enrollmentEnabled: true,
        protocols: ["native-subreaper-broker-channel-v1", "native-subreaper-broker-channel-pty-v1"],
        brokerArtifact: qualifiedPin,
      });
    } finally {
      await operator.close();
    }
  }
  const session = await createSession(client.db, {
    accountId,
    workspaceId: workspaceId!,
    initialMessage: "Broker transport fixture",
    resources: [],
    metadata: {},
    model: "test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: qualifiedPin ? "modal" : "none",
    ...(qualifiedPin
      ? { createdBy: { kind: "subject" as const, subjectId }, createIdempotencyKey }
      : {}),
  });
  const binding: NativeBrokerTransportBinding = {
    version: 1,
    brokerId: crypto.randomUUID(),
    accountId,
    workspaceId: workspaceId!,
    leaseId: crypto.randomUUID(),
    sandboxGroupId: session.sandboxGroupId,
    createOperationId: crypto.randomUUID(),
    createEpoch: 1,
    sandboxId: `sb-${unique}`,
    taskId: `ta-${unique}`,
    providerBindingKey,
    sourceSha: "a".repeat(40),
    artifactSha256: qualifiedPin?.artifactSha256 ?? "b".repeat(64),
    bootstrapEvidenceSha256: "c".repeat(64),
  };
  await database.admin`INSERT INTO sandbox_leases ${database.admin({
    id: binding.leaseId,
    account_id: accountId,
    workspace_id: workspaceId,
    sandbox_group_id: binding.sandboxGroupId,
    backend: "modal",
    liveness: "warming",
    lease_epoch: 1,
    instance_id: qualifiedPin ? null : binding.sandboxId,
    expires_at: new Date(Date.now() + 300000),
    provider_create_attempt: qualifiedPin
      ? null
      : database.admin.json({
          version: 1,
          operationId: binding.createOperationId,
          leaseEpoch: 1,
          providerBindingKey: binding.providerBindingKey,
          appId: "ap-test",
          providerName: `opengeni-create-${binding.createOperationId}`,
          requestSha256: "d".repeat(64),
          instanceId: binding.sandboxId,
        }),
  })}`;
  if (qualifiedPin) {
    await beginModalProviderCreate(client.db, {
      accountId,
      workspaceId: workspaceId!,
      sandboxGroupId: binding.sandboxGroupId,
      expectedEpoch: 1,
      operationId: binding.createOperationId,
      providerBindingKey,
      rematerializationId: null,
      selectedRevision: null,
      imageId: "im-bootstrap-fixture",
      imageRef,
      appId: "ap-bootstrap-fixture",
      providerName: `opengeni-create-${binding.createOperationId}`,
      requestSha256: "d".repeat(64),
      nativeSourceSha: binding.sourceSha,
      nativeImagePreparation: {
        kind: "registry-import",
        imageRef,
        imageId: "im-bootstrap-fixture",
      },
      nativeBroker: {
        version: 1,
        brokerId: binding.brokerId,
        sourceSha: binding.sourceSha,
        imageId: "im-bootstrap-fixture",
        artifact: qualifiedPin,
      },
    });
    expect(
      (
        await recordWarmingSandboxCreated(client.db, {
          accountId,
          workspaceId: workspaceId!,
          sandboxGroupId: binding.sandboxGroupId,
          expectedEpoch: 1,
          providerCreateOperationId: binding.createOperationId,
          instanceId: binding.sandboxId,
          leaseTtlMs: 60_000,
        })
      ).recorded,
    ).toBe(true);
  }
  const initial = initialNativeBrokerTransportState(binding);
  if (register) await registerNativeBrokerTransport(client.db, key, binding, initial);
  const store = nativeBrokerTransportStore(client.db, key, binding);
  const service = () => createDurableNativeBrokerTransport(client.db, key, binding);
  return { binding, initial, store, service, sessionId: session.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function bootstrapFixture(qualified = false) {
  const binary = Buffer.alloc(64, 17);
  const pin = {
    artifactSha256: createHash("sha256").update(binary).digest("hex"),
    byteSize: binary.length,
    target: "linux-amd64" as const,
  };
  const f = await fixture(false, qualified ? pin : undefined);
  const bodies = [
    {
      kind: "hello" as const,
      payload: Buffer.from(
        JSON.stringify({
          protocol: "native-command-broker-v1",
          sealedExec: "execveat",
          pipeCapability: "native-subreaper-broker-channel-v1",
          ptyCapability: "native-subreaper-broker-channel-pty-v1",
          artifact: {
            byteSize: binary.length,
            target: pin.target,
            seals: 15,
            device: "5",
            inode: "20",
          },
        }),
      ),
    },
    { kind: "artifact" as const, payload: binary },
  ];
  const text = Buffer.concat(
    bodies.map((body, index) =>
      encodeNativeBrokerFrame({
        direction: "response",
        brokerId: f.binding.brokerId,
        ownerEpoch: 1,
        sequence: index + 1,
        requestId: f.binding.brokerId,
        commandId: null,
        offset: 0,
        ...body,
      }),
    ),
  ).toString("ascii");
  const initialPage = page(f, text, "1-0");
  const channel = {
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    async *output() {
      yield initialPage;
    },
    async *diagnostics() {},
  };
  const captured = await captureNativeBrokerBootstrap(channel, f.binding.brokerId, pin);
  Object.assign(f.binding, {
    artifactSha256: pin.artifactSha256,
    bootstrapEvidenceSha256: captured.bootstrap.transcriptSha256,
  });
  return { f, pin, channel, captured };
}

function bootstrapAdmission(f: Fixture) {
  const {
    accountId,
    workspaceId,
    sandboxGroupId,
    leaseId,
    createOperationId,
    sandboxId,
    sourceSha,
    providerBindingKey,
  } = f.binding;
  return {
    accountId,
    workspaceId,
    sandboxGroupId,
    leaseId,
    createOperationId,
    sandboxId,
    sourceSha,
    providerBindingKey,
  };
}

test("qualified creation and bootstrap compose without guest-selected pins or warm reenrollment", async () => {
  const { f, channel, captured } = await bootstrapFixture(true);
  const input = bootstrapAdmission(f);
  const results = await Promise.all(
    [1, 2].map(() => registerQualifiedNativeBrokerBootstrap(client.db, key, input, channel)),
  );
  expect(results[0]!.binding).toEqual(f.binding);
  expect(results[1]!.bootstrap).toEqual(captured.bootstrap);
  expect(results[0]!.commandAdmission).toBe(false);
  const writer = crypto.randomUUID();
  await results[0]!.journal.claimWriter(writer);
  const progressed = await results[0]!.journal.read();
  expect(
    (
      await commitWarmingToWarm(client.db, {
        ...input,
        expectedEpoch: 1,
        instanceId: input.sandboxId,
        leaseTtlMs: 60_000,
      })
    ).committed,
  ).toBe(true);
  const recovered = await registerQualifiedNativeBrokerBootstrap(client.db, key, input, {
    ...channel,
    output() {
      throw new Error("Warm recovery must not query old provider pages");
    },
  });
  expect(await recovered.journal.read()).toEqual(progressed);
  await expect(
    registerQualifiedNativeBrokerBootstrap(client.db, key, input, {
      ...channel,
      taskId: "ta-substituted",
      output() {
        throw new Error("Must not read");
      },
    }),
  ).rejects.toThrow("fenced");
});

test("qualified bootstrap rejects old groups, mismatched host source and unattested warm histories", async () => {
  for (const qualified of [false, true]) {
    const { f, channel } = await bootstrapFixture(qualified);
    const input = bootstrapAdmission(f);
    let reads = 0;
    const observed = {
      ...channel,
      output() {
        reads++;
        return channel.output();
      },
    };
    if (!qualified) {
      await expect(
        registerQualifiedNativeBrokerBootstrap(client.db, key, input, observed),
      ).rejects.toThrow();
    } else {
      await expect(
        registerQualifiedNativeBrokerBootstrap(
          client.db,
          key,
          { ...input, sourceSha: "b".repeat(40) },
          observed,
        ),
      ).rejects.toThrow("unqualified");
      await expect(
        registerQualifiedNativeBrokerBootstrap(client.db, key, input, {
          ...observed,
          sandboxId: "sb-substituted",
        }),
      ).rejects.toThrow("sandbox identity");
      expect(
        (
          await commitWarmingToWarm(client.db, {
            ...input,
            expectedEpoch: 1,
            instanceId: input.sandboxId,
            leaseTtlMs: 60_000,
          })
        ).committed,
      ).toBe(true);
      await expect(
        registerQualifiedNativeBrokerBootstrap(client.db, key, input, observed),
      ).rejects.toThrow("existing durable bootstrap evidence");
    }
    expect(reads).toBe(0);
    expect(
      await database.admin`select id from native_command_broker_transports where id=${f.binding.brokerId}`,
    ).toHaveLength(0);
  }
});

test("lease transition during qualified prefix capture fences registration without replay", async () => {
  const { f, channel } = await bootstrapFixture(true);
  await expect(
    registerQualifiedNativeBrokerBootstrap(client.db, key, bootstrapAdmission(f), {
      ...channel,
      async *output() {
        try {
          yield* channel.output();
        } finally {
          await database.admin`update sandbox_leases set liveness='draining' where id=${f.binding.leaseId}`;
        }
      },
    }),
  ).rejects.toThrow("fenced");
  expect(
    await database.admin`select id from native_command_broker_transports where id=${f.binding.brokerId}`,
  ).toHaveLength(0);
});

test("initial bootstrap and all receipts commit together, survive concurrent replay and never rewind", async () => {
  const { f, pin, channel, captured } = await bootstrapFixture();
  const results = await Promise.all(
    [1, 2].map(() =>
      registerCapturedNativeBrokerBootstrap(client.db, key, f.binding, channel, pin),
    ),
  );
  expect(results[0]!.binding).toEqual(f.binding);
  expect(results[1]!.bootstrap).toEqual(captured.bootstrap);
  const journal = results[0]!.journal;
  expect(await journal.read()).toEqual(captured.initialState);
  expect(await readNativeBrokerBootstrap(f.service(), pin)).toEqual(captured.bootstrap);
  const entries = await database.admin`SELECT kind, count(*)::int AS count
    FROM native_command_broker_entries WHERE broker_id=${f.binding.brokerId} GROUP BY kind ORDER BY kind`;
  expect(entries).toEqual([
    { kind: "frame", count: 2 },
    { kind: "page", count: 1 },
  ]);
  const writerId = crypto.randomUUID();
  await journal.claimWriter(writerId);
  await journal.reserve(writerId, 1, {
    requestId: crypto.randomUUID(),
    commandId: null,
    kind: "fence",
    offset: 0,
    payload: new Uint8Array(),
  });
  const progressed = await journal.read();
  await registerCapturedNativeBrokerBootstrap(
    client.db,
    key,
    f.binding,
    {
      ...channel,
      output() {
        throw new Error("initial provider pages no longer available");
      },
    },
    pin,
  );
  expect(await journal.read()).toEqual(progressed);
});

function diagnosticFault(
  f: Fixture,
  data = "fixture initial diagnostic",
): NativeBrokerDiagnosticsFault {
  const value = JSON.stringify({
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    requestedFileDescriptor: 2,
    entryId: "diag-1",
    items: [{ fileDescriptor: 2, data }],
    eof: false,
  });
  return {
    version: 1,
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    reason: "diagnostics",
    page: { value, sha256: createHash("sha256").update(value).digest("hex") },
  };
}

test("qualified startup retains initial diagnostics before rejection and cannot clear them on restart", async () => {
  const { f, channel } = await bootstrapFixture(true);
  const fault = diagnosticFault(f);
  await expect(
    registerQualifiedNativeBrokerBootstrap(client.db, key, bootstrapAdmission(f), {
      ...channel,
      async *diagnostics() {
        yield JSON.parse(fault.page!.value);
      },
    }),
  ).rejects.toBeInstanceOf(NativeBrokerInitialDiagnosticsError);
  const journal = f.service();
  expect(await journal.diagnosticFault()).toEqual(fault);
  let reads = 0;
  await expect(
    registerQualifiedNativeBrokerBootstrap(client.db, key, bootstrapAdmission(f), {
      ...channel,
      async *diagnostics() {
        reads++;
        yield* [];
      },
      output() {
        throw new Error("Retained bootstrap must not be reread");
      },
    }),
  ).rejects.toThrow("diagnostics");
  expect(reads).toBe(0);
  const [stored] = await database.admin`select value_encrypted from native_command_broker_entries
    where broker_id=${f.binding.brokerId} and kind='diagnostic_fault'`;
  expect(String(stored!.value_encrypted)).not.toContain("fixture initial diagnostic");
  expect(await journal.recordDiagnosticFault(diagnosticFault(f, "later failure"))).toEqual(fault);
  expect(
    await createDurableNativeBrokerTransport(client.db, key, f.binding).diagnosticFault(),
  ).toEqual(fault);
});

test("diagnostic faults fence new work and pending dispatch while preserving unknown input and output custody", async () => {
  const f = await fixture();
  const active = await start(f);
  await f
    .service()
    .captureOutput("0-0", page(f, Buffer.from(accepted(f, active.write.input)).toString()));
  const release = {
    ...fence(),
    commandId: crypto.randomUUID(),
    kind: "control" as const,
    payload: Buffer.from("release"),
  };
  await f.service().reserve(active.writerId, 1, release);
  const before = await f.service().read();
  await f.service().recordDiagnosticFault(diagnosticFault(f));
  await expect(f.service().dispatchIntent(active.writerId, 1, release.requestId)).rejects.toThrow(
    "diagnostics",
  );
  expect(await f.service().read()).toEqual(before);
  expect((await f.service().request(release.requestId))!.phase).toBe("reserved");
  for (const kind of ["prepare", "definition", "launch", "resize", "eof"] as const)
    await expect(
      f.service().reserve(active.writerId, 1, { ...fence(), commandId: release.commandId, kind }),
    ).rejects.toThrow("diagnostics");
  // Failure is not quiescence and never clears the original pending release.
  await expect(
    f.service().reserve(active.writerId, 1, {
      ...release,
      requestId: crypto.randomUUID(),
      payload: Buffer.from("cancel"),
    }),
  ).rejects.toThrow();
  expect((await f.service().framesAfter(0)).frames).toHaveLength(1);
  expect(await f.service().read()).toEqual(before);
});

test("a diagnostic fault does not block exact cancel, status, replay, ACK or writer fencing", async () => {
  for (const selected of [
    { kind: "control" as const, payload: Buffer.from("cancel") },
    { kind: "control" as const, payload: Buffer.from("status") },
    { kind: "control" as const, payload: Buffer.from(`ack\t${crypto.randomUUID()}`) },
    { kind: "replay" as const, payload: new Uint8Array() },
    { kind: "ack" as const, payload: new Uint8Array() },
    { kind: "fence" as const, payload: new Uint8Array() },
  ]) {
    const f = await fixture();
    if (selected.kind === "fence") {
      const writerId = crypto.randomUUID();
      await f.service().claimWriter(writerId);
      await f.service().recordDiagnosticFault(diagnosticFault(f));
      const request = fence();
      await f.service().reserve(writerId, 1, request);
      expect((await f.service().dispatchIntent(writerId, 1, request.requestId))!.index).toBe(1);
      continue;
    }
    const active = await start(f);
    await f
      .service()
      .captureOutput("0-0", page(f, Buffer.from(accepted(f, active.write.input)).toString()));
    await f.service().recordDiagnosticFault(diagnosticFault(f));
    const request = {
      ...fence(),
      commandId: selected.kind === "control" ? crypto.randomUUID() : null,
      ...selected,
    };
    expect(await f.service().claimWriter(active.writerId)).toMatchObject({ epoch: 1 });
    await f.service().reserve(active.writerId, 1, request);
    expect((await f.service().dispatchIntent(active.writerId, 1, request.requestId))!.index).toBe(
      2,
    );
  }
});

test("a diagnostic fault does not allow malformed or composite control actions through the recovery exception", async () => {
  const f = await fixture();
  const active = await start(f);
  await f
    .service()
    .captureOutput("0-0", page(f, Buffer.from(accepted(f, active.write.input)).toString()));
  await f.service().recordDiagnosticFault(diagnosticFault(f));
  for (const payload of [
    "release",
    "cancel\nrelease",
    "status\0",
    "ack\tinvalid",
    `ack\t${crypto.randomUUID()}\nrelease`,
  ])
    await expect(
      f.service().reserve(active.writerId, 1, {
        ...fence(),
        commandId: crypto.randomUUID(),
        kind: "control",
        payload: Buffer.from(payload),
      }),
    ).rejects.toThrow("diagnostics");
  await expect(
    f.service().reserve(active.writerId, 1, {
      ...fence(),
      commandId: crypto.randomUUID(),
      kind: "control",
      offset: 1,
      payload: Buffer.from("cancel"),
    }),
  ).rejects.toThrow("diagnostics");
});

test("diagnostic faults reject stdin before committing byte offsets or provider input", async () => {
  const { f, active, input, counter } = await stdinFixture();
  await f.service().recordDiagnosticFault(diagnosticFault(f));
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, input, Buffer.from("blocked")),
  ).rejects.toThrow("diagnostics");
  expect(await counter()).toBe(0);
  expect(await f.service().request(input.admissionId)).toBeNull();
});

test("fault observations are immutable, scope-bound and dominate concurrent clean queries", async () => {
  const f = await fixture();
  const other = await fixture();
  const fault = diagnosticFault(f);
  await expect(other.service().recordDiagnosticFault(fault)).rejects.toThrow("physical identity");
  await expect(
    f
      .service()
      .recordDiagnosticFault({ ...fault, page: { ...fault.page!, sha256: "f".repeat(64) } }),
  ).rejects.toThrow("inconsistent");
  const channel = {
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    async *diagnostics() {
      await f.service().recordDiagnosticFault(fault);
      yield* [];
    },
  };
  await expect(observeDurableNativeBrokerDiagnostics(f.service(), channel)).rejects.toThrow(
    "diagnostics",
  );
  expect(await other.service().diagnosticFault()).toBeNull();
  await expect(
    withRlsContext(client.db, f.binding, (tx) =>
      tx.execute(sql`
    delete from native_command_broker_entries where broker_id=${f.binding.brokerId}::uuid
      and kind='diagnostic_fault'`),
    ),
  ).rejects.toThrow();
  expect(await f.service().diagnosticFault()).toEqual(fault);
});

test("uncertain diagnostic reads remain unavailable without inventing a permanent fault", async () => {
  const f = await fixture();
  const error = new Error("provider observation unavailable");
  const channel = {
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    diagnostics() {
      throw error;
    },
  };
  await expect(observeDurableNativeBrokerDiagnostics(f.service(), channel)).rejects.toBe(error);
  expect(await f.service().diagnosticFault()).toBeNull();
  expect(
    (
      await observeDurableNativeBrokerDiagnostics(f.service(), {
        ...channel,
        async *diagnostics() {},
      })
    ).status,
  ).toBe("clean_observation");
});

async function coordinatedFixture() {
  const f = await fixture();
  const writerId = crypto.randomUUID();
  const pages: NativeBrokerOutputPage[] = [];
  const wake = new Set<() => void>();
  const readStarted = new Set<() => void>();
  const writes: Array<{ index: number; requestId: string }> = [];
  let sequence = 0,
    activeReaders = 0,
    maxReaders = 0,
    failNext = false;
  let beforeWrite: (() => Promise<void>) | undefined;
  const channel: NativeBrokerChannel = {
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    async write(input) {
      const decoder = new NativeBrokerFrameDecoder(f.binding.brokerId);
      const [request] = decoder.push(input.input);
      decoder.finish();
      if (!request || request.direction !== "request") throw new Error("Fixture request missing");
      writes.push({ index: input.index, requestId: request.requestId });
      const block = beforeWrite;
      beforeWrite = undefined;
      await block?.();
      if (failNext) {
        failNext = false;
        throw new Error("fixture ambiguous provider write");
      }
      const response = (kind: "accepted" | "status", payload: Uint8Array, offset: number) =>
        encodeNativeBrokerFrame({
          ...request,
          direction: "response",
          kind,
          sequence: ++sequence,
          payload,
          offset,
        });
      const bytes = Buffer.concat([
        response("accepted", new Uint8Array(), input.index),
        ...(request.kind === "ack" ? [] : [response("status", Buffer.from('{"fixture":true}'), 0)]),
      ]);
      pages.push(page(f, bytes.toString(), `${pages.length + 1}-0`));
      for (const notify of wake) notify();
    },
    async *output(cursor, signal) {
      activeReaders++;
      maxReaders = Math.max(maxReaders, activeReaders);
      for (const resolve of readStarted) resolve();
      readStarted.clear();
      try {
        let offset = Number(cursor.split("-")[0]);
        for (;;) {
          signal?.throwIfAborted();
          if (offset < pages.length) {
            yield pages[offset++]!;
            continue;
          }
          await new Promise<void>((resolve, reject) => {
            const clean = () => {
              wake.delete(notify);
              signal?.removeEventListener("abort", abort);
            };
            const notify = () => {
              clean();
              resolve();
            };
            const abort = () => {
              clean();
              reject(signal!.reason);
            };
            wake.add(notify);
            signal?.addEventListener("abort", abort, { once: true });
          });
        }
      } finally {
        activeReaders--;
      }
    },
  };
  return {
    f,
    writerId,
    channel,
    writes,
    coordinator: new NativeBrokerCoordinator(f.service(), channel, writerId),
    counters: () => ({ activeReaders, maxReaders }),
    failNext: () => {
      failNext = true;
    },
    blockNext: (block: () => Promise<void>) => {
      beforeWrite = block;
    },
    nextReader: () => new Promise<void>((resolve) => readStarted.add(resolve)),
  };
}

test("shared coordination serializes native acceptance, preserves request bytes and uses one output collector", async () => {
  const f = await coordinatedFixture();
  const first = {
    ...fence(),
    kind: "prepare" as const,
    commandId: crypto.randomUUID(),
    payload: Buffer.from("original"),
  };
  const second = { ...first, requestId: crypto.randomUUID(), payload: Buffer.from("second") };
  try {
    const a = f.coordinator.send(first),
      b = f.coordinator.send(second);
    first.payload.fill(0);
    expect(await Promise.all([a, b])).toEqual([
      { state: "accepted", index: 2 },
      { state: "accepted", index: 3 },
    ]);
    expect(f.writes.map((write) => write.index)).toEqual([1, 2, 3]);
    expect(
      Buffer.from((await f.f.service().request(first.requestId))!.frame.payload).toString(),
    ).toBe("original");
    expect(
      JSON.parse(Buffer.from((await f.coordinator.reply(second.requestId)).payload).toString()),
    ).toEqual({ fixture: true });
    expect(f.counters().maxReaders).toBe(1);
    const before = f.writes.length;
    await expect(f.coordinator.send(second)).resolves.toMatchObject({ state: "accepted" });
    expect(f.writes).toHaveLength(before);
  } finally {
    await f.coordinator.close();
  }
  expect(f.counters().activeReaders).toBe(0);
  await expect(f.coordinator.claimWriter()).rejects.toThrow("closed");
});

test("one cancelled output waiter does not cancel a sibling or duplicate provider collectors", async () => {
  const f = await coordinatedFixture();
  try {
    await f.coordinator.claimWriter();
    const sequence = (await f.f.service().read()).output.lastSequence;
    const cancelled = new AbortController();
    const a = f.coordinator.observeAfter(sequence, cancelled.signal);
    const b = f.coordinator.observeAfter(sequence, AbortSignal.timeout(5_000));
    const rejected = a.then(
      () => {
        throw new Error("Cancelled observer unexpectedly succeeded");
      },
      (error: unknown) => error,
    );
    cancelled.abort(new Error("only first reader"));
    expect(await rejected).toMatchObject({ message: "only first reader" });
    await f.coordinator.send({ ...fence(), kind: "prepare", commandId: crypto.randomUUID() });
    expect((await b).lastSequence).toBeGreaterThan(sequence);
    expect(f.counters().maxReaders).toBe(1);
  } finally {
    await f.coordinator.close();
  }
  expect(f.counters().activeReaders).toBe(0);
});

test("coordinator never replays uncertain input and joins only explicit same-index recovery", async () => {
  const f = await coordinatedFixture();
  const request = { ...fence(), kind: "prepare" as const, commandId: crypto.randomUUID() };
  try {
    await f.coordinator.claimWriter();
    f.failNext();
    await expect(f.coordinator.send(request)).rejects.toBeInstanceOf(
      NativeBrokerDispatchUnknownError,
    );
    const before = await f.f.service().read();
    const cancelled = new AbortController();
    const reading = f.nextReader();
    const waiting = f.coordinator.send(request, cancelled.signal).then(
      () => {
        throw new Error("Unknown request unexpectedly settled");
      },
      (error: unknown) => error,
    );
    await reading;
    cancelled.abort(new Error("Bounded reconciliation observation ended"));
    expect(await waiting).toBeInstanceOf(NativeBrokerReconciliationRequiredError);
    expect(f.writes).toHaveLength(2);
    expect((await f.f.service().read()).input).toEqual(before.input);
    // This is a separately invoked, explicit recovery; the coordinator itself
    // has no automatic replay path and must not increment the provider index.
    await new NativeBrokerDriver(f.f.service(), f.channel, f.writerId).replayPending();
    await f.coordinator.observeAfter(before.output.lastSequence, AbortSignal.timeout(5_000));
    expect(await f.coordinator.send(request)).toEqual({ state: "accepted", index: 2 });
    expect(f.writes.map((write) => write.index)).toEqual([1, 2, 2]);
  } finally {
    await f.coordinator.close();
  }
});

test("coordinator dispatches the original reserved body once and refuses a mismatched launch epoch", async () => {
  const f = await coordinatedFixture();
  const request = { ...fence(), kind: "launch" as const, commandId: crypto.randomUUID() };
  try {
    await f.coordinator.claimWriter();
    await expect(f.coordinator.send(request, undefined, 2)).rejects.toThrow("epoch changed");
    expect(await f.f.service().request(request.requestId)).toBeNull();
    await f.f.service().reserve(f.writerId, 1, request);
    expect(await f.coordinator.send(request, undefined, 1)).toEqual({
      state: "accepted",
      index: 2,
    });
    expect(f.writes.map((write) => write.index)).toEqual([1, 2]);
  } finally {
    await f.coordinator.close();
  }
});

test("cancelled queued input cannot let its successor overtake the original dispatch", async () => {
  const f = await coordinatedFixture();
  let unblock!: () => void, reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  try {
    await f.coordinator.claimWriter();
    f.blockNext(async () => {
      reached();
      await blocked;
    });
    const request = () => ({
      ...fence(),
      commandId: crypto.randomUUID(),
      kind: "prepare" as const,
    });
    const first = f.coordinator.send(request());
    await entered;
    const cancel = new AbortController();
    const second = f.coordinator.send(request(), cancel.signal).catch((error: unknown) => error);
    const lastRequest = request();
    const third = f.coordinator.send(lastRequest);
    cancel.abort(new Error("cancelled queue slot"));
    expect(await second).toMatchObject({ message: "cancelled queue slot" });
    expect(
      await Promise.race([third.then(() => "overtook"), Bun.sleep(30).then(() => "blocked")]),
    ).toBe("blocked");
    expect(f.writes.map((write) => write.index)).toEqual([1, 2]);
    unblock();
    await first;
    await third;
    expect(f.writes.map((write) => write.index)).toEqual([1, 2, 3]);
    expect(f.writes.at(-1)!.requestId).toBe(lastRequest.requestId);
  } finally {
    unblock();
    await f.coordinator.close();
  }
});

test("output retirement acknowledges only a committed prefix and has no automatic ACK feedback loop", async () => {
  const f = await coordinatedFixture();
  try {
    await f.coordinator.claimWriter();
    const before = await f.f.service().read();
    for (const invalid of [
      { offset: before.output.lastSequence + 1 },
      { payload: Buffer.from("not an empty ACK") },
      { commandId: crypto.randomUUID() },
    ]) {
      const request = {
        ...fence(),
        kind: "ack" as const,
        offset: before.output.lastSequence,
        ...invalid,
      };
      await expect(f.f.service().reserve(f.writerId, 1, request)).rejects.toThrow();
      expect(await f.f.service().request(request.requestId)).toBeNull();
    }
    expect((await f.f.service().read()).input).toEqual(before.input);
    const receipt = await f.coordinator.acknowledgeOutput();
    const original = await f.f.service().request(receipt.requestId);
    expect(original).toMatchObject({
      accepted: true,
      frame: {
        kind: "ack",
        commandId: null,
        ownerEpoch: 1,
        offset: before.output.lastSequence,
      },
    });
    expect(original!.frame.payload).toHaveLength(0);
    expect(receipt.sequence).toBe(before.output.lastSequence);
    expect((await f.f.service().read()).output.lastSequence).toBe(before.output.lastSequence + 1);
    expect(f.writes).toHaveLength(2);
    // Retiring the provider's window does not delete the durable frames.
    expect((await f.f.service().framesAfter(0, 128)).frames).toHaveLength(
      before.output.lastSequence + 1,
    );
    f.failNext();
    await expect(f.coordinator.acknowledgeOutput()).rejects.toBeInstanceOf(
      NativeBrokerDispatchUnknownError,
    );
    expect((await f.f.service().read()).input.pending?.phase).toBe("dispatch_intent");
    expect(f.writes).toHaveLength(3);
  } finally {
    await f.coordinator.close();
  }
});

test("initial entry insertion failure rolls back the transport and every receipt", async () => {
  const { f, captured } = await bootstrapFixture();
  // This exact fixture owns the isolated database. The conditional trigger
  // injects a real SQL failure after transport insertion, not pre-validation.
  await database.admin.unsafe(`CREATE FUNCTION fixture_bootstrap_insert_failure() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.broker_id = '${f.binding.brokerId}'::uuid AND NEW.kind = 'frame' AND NEW.sequence = 2 THEN
        RAISE EXCEPTION 'fixture bootstrap insert failure';
      END IF; RETURN NEW; END $$;
    CREATE TRIGGER fixture_bootstrap_insert_failure BEFORE INSERT ON native_command_broker_entries
    FOR EACH ROW EXECUTE FUNCTION fixture_bootstrap_insert_failure()`);
  try {
    const failure = await registerNativeBrokerTransport(
      client.db,
      key,
      f.binding,
      captured.initialState,
      captured.entries,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toMatchObject({
      message: "fixture bootstrap insert failure",
      code: "P0001",
    });
    expect(
      await database.admin`SELECT id FROM native_command_broker_transports WHERE id=${f.binding.brokerId}`,
    ).toHaveLength(0);
    expect(
      await database.admin`SELECT entry_key FROM native_command_broker_entries WHERE broker_id=${f.binding.brokerId}`,
    ).toHaveLength(0);
  } finally {
    await database.admin
      .unsafe(`DROP TRIGGER fixture_bootstrap_insert_failure ON native_command_broker_entries;
      DROP FUNCTION fixture_bootstrap_insert_failure()`);
  }
  await registerNativeBrokerTransport(
    client.db,
    key,
    f.binding,
    captured.initialState,
    captured.entries,
  );
  expect((await f.service().framesAfter(0)).frames).toHaveLength(2);
});

test("registration cannot retrofit omitted bootstrap receipts into an existing row", async () => {
  const { f, captured, channel, pin } = await bootstrapFixture();
  await registerNativeBrokerTransport(client.db, key, f.binding, captured.initialState);
  await expect(
    registerNativeBrokerTransport(
      client.db,
      key,
      f.binding,
      captured.initialState,
      captured.entries,
    ),
  ).rejects.toThrow("fenced");
  let providerReads = 0;
  await expect(
    registerCapturedNativeBrokerBootstrap(
      client.db,
      key,
      f.binding,
      {
        ...channel,
        output() {
          providerReads++;
          throw new Error("must not retrofit provider evidence");
        },
      },
      pin,
    ),
  ).rejects.toThrow("durable transport is inconsistent or fenced");
  expect(providerReads).toBe(0);
  expect(
    await database.admin`SELECT entry_key FROM native_command_broker_entries WHERE broker_id=${f.binding.brokerId}`,
  ).toHaveLength(0);
});

test("bootstrap registration rejects incomplete, changed, duplicate and advanced evidence before mutation", async () => {
  const { f, pin, channel, captured } = await bootstrapFixture();
  for (const entries of [
    captured.entries.slice(1),
    [...captured.entries, captured.entries[0]!],
    captured.entries.map((entry, index) =>
      index ? entry : { ...entry, value: entry.value + "x" },
    ),
    captured.entries.map((entry) => (entry.kind === "page" ? { ...entry, key: "other" } : entry)),
  ]) {
    await expect(
      registerNativeBrokerTransport(client.db, key, f.binding, captured.initialState, entries),
    ).rejects.toThrow();
  }
  await expect(
    registerNativeBrokerTransport(
      client.db,
      key,
      f.binding,
      {
        ...captured.initialState,
        input: { ...captured.initialState.input, lastReservedInputIndex: 1 },
      },
      captured.entries,
    ),
  ).rejects.toThrow();
  await expect(
    registerCapturedNativeBrokerBootstrap(
      client.db,
      key,
      { ...f.binding, taskId: "ta-other" },
      channel,
      pin,
    ),
  ).rejects.toThrow("scope");
  await expect(
    registerCapturedNativeBrokerBootstrap(
      client.db,
      key,
      { ...f.binding, artifactSha256: "f".repeat(64) },
      channel,
      pin,
    ),
  ).rejects.toThrow("artifact");
  expect(
    await database.admin`SELECT id FROM native_command_broker_transports WHERE id=${f.binding.brokerId}`,
  ).toHaveLength(0);
});

/** Test-only admission/holder seed. Physical bootstrap/qualification is not
 * inferred from these rows; this exercises the canonical receipt/output/exit
 * custody using the actual native process rather than a synthetic terminal. */
async function retainNativeFixture(f: Fixture, command: ModalBrokerProviderCommand, handle = 1) {
  const b = f.binding,
    processId = crypto.randomUUID(),
    admissionId = crypto.randomUUID(),
    actorId = crypto.randomUUID();
  const scope = {
    accountId: b.accountId,
    workspaceId: b.workspaceId,
    sessionId: f.sessionId,
    processId,
  };
  const [birth] =
    await database.admin`update sandbox_leases set workspace_generation = workspace_generation + 1 where id=${b.leaseId} returning workspace_generation`;
  await database.admin`insert into sandbox_lease_holders ${database.admin({
    account_id: b.accountId,
    workspace_id: b.workspaceId,
    lease_id: b.leaseId,
    kind: "process",
    holder_id: `process:${processId}`,
    subject_id: f.sessionId,
  })}`;
  await database.admin`insert into sandbox_workspace_mutation_admissions ${database.admin({
    id: admissionId,
    account_id: b.accountId,
    workspace_id: b.workspaceId,
    lease_id: b.leaseId,
    sandbox_group_id: b.sandboxGroupId,
    session_id: f.sessionId,
    actor_kind: "direct",
    actor_id: actorId,
    holder_kind: "direct",
    holder_id: `direct:${actorId}`,
    lease_epoch: b.createEpoch,
    provider_backend: "modal",
    provider_instance_id: b.sandboxId,
    route_kind: "active",
    route_epoch: 0,
    workspace_generation: birth!.workspace_generation,
    operation: "terminalExec",
    provider_outcome: "retained",
  })}`;
  await database.admin`insert into sandbox_retained_processes ${database.admin({
    id: processId,
    account_id: b.accountId,
    workspace_id: b.workspaceId,
    session_id: f.sessionId,
    lease_id: b.leaseId,
    sandbox_group_id: b.sandboxGroupId,
    parent_admission_id: admissionId,
    holder_id: `process:${processId}`,
    owner_actor_kind: "direct",
    owner_actor_id: actorId,
    lease_epoch: b.createEpoch,
    provider_backend: "modal",
    provider_instance_id: b.sandboxId,
    route_kind: "active",
    route_epoch: 0,
    provider_session_id: handle,
    provider_binding_key: b.providerBindingKey,
    provider_binding: database.admin.json(JSON.parse(b.providerBindingKey)),
    provider_command: database.admin.json(command),
  })}`;
  return {
    scope,
    persistence: retainedProviderCommandPersistence(client.db, scope),
    inputAdmission: async () => {
      const childId = crypto.randomUUID();
      const [lease] = await database.admin`update sandbox_leases
        set workspace_generation = workspace_generation + 1 where id = ${b.leaseId}
        returning workspace_generation`;
      await database.admin`insert into sandbox_workspace_mutation_admissions ${database.admin({
        id: childId,
        account_id: b.accountId,
        workspace_id: b.workspaceId,
        lease_id: b.leaseId,
        sandbox_group_id: b.sandboxGroupId,
        session_id: f.sessionId,
        actor_kind: "process",
        actor_id: processId,
        holder_kind: "process",
        holder_id: `process:${processId}`,
        lease_epoch: b.createEpoch,
        provider_backend: "modal",
        provider_instance_id: b.sandboxId,
        route_kind: "active",
        route_epoch: 0,
        workspace_generation: lease!.workspace_generation,
        operation: "writeStdin",
      })}`;
      return { sessionId: f.sessionId, processId, admissionId: childId, commandId: command.execId };
    },
    settle: async (exitCode = 0) => {
      const expected = await getRetainedProcess(client.db, scope);
      if (!expected) throw new Error("Native retained fixture missing");
      return settleRetainedProcess(client.db, {
        ...scope,
        expected,
        outcome: "exited",
        exitCode,
        reason: "provider_exit_banner",
        idleGraceMs: 1000,
      });
    },
  };
}

async function stdinFixture() {
  const f = await fixture();
  const active = await start(f);
  await f
    .service()
    .captureOutput("0-0", page(f, Buffer.from(accepted(f, active.write.input)).toString()));
  const id = crypto.randomUUID();
  const command = ModalBrokerProviderCommand.parse({
    kind: "modal-broker-v1",
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    execId: id,
    pty: false,
    supervision: {
      protocol: "native-subreaper-broker-channel-v1",
      invocationId: id,
      brokerId: f.binding.brokerId,
      launchRequestId: crypto.randomUUID(),
      launchEpoch: 1,
    },
    capture: { sequence: 0, receiptAckObserved: false },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  });
  const custody = await retainNativeFixture(f, command);
  const input = await custody.inputAdmission();
  const counter = async () => {
    const [row] =
      await database.admin`select provider_command_input_index from sandbox_retained_processes where id=${input.processId}`;
    return Number(row!.provider_command_input_index);
  };
  return { f, active, custody, input, counter };
}

async function neverStartedFixture(
  pty = false,
  payload = "cancel",
  body = '{"state":"not_started","launchClosed":true}',
  capture = true,
  admitInput = false,
) {
  const f = await fixture();
  const active = await start(f);
  const journal = f.service();
  await journal.captureOutput(
    "0-0",
    page(f, Buffer.from(accepted(f, active.write.input)).toString()),
  );
  const commandId = crypto.randomUUID();
  const command = ModalBrokerProviderCommand.parse({
    kind: "modal-broker-v1",
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    execId: commandId,
    pty,
    supervision: {
      protocol: pty
        ? "native-subreaper-broker-channel-pty-v1"
        : "native-subreaper-broker-channel-v1",
      invocationId: commandId,
      brokerId: f.binding.brokerId,
      launchRequestId: crypto.randomUUID(),
      launchEpoch: 1,
    },
    capture: { sequence: 1, receiptAckObserved: false },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  });
  const custody = await retainNativeFixture(f, command);
  if (admitInput) await custody.inputAdmission();
  await custody.persistence.requestCancellation("explicit_stop");
  const requestId = crypto.randomUUID();
  await journal.reserve(active.writerId, 1, {
    requestId,
    commandId,
    kind: "control",
    offset: 0,
    payload: Buffer.from(payload),
  });
  const sent = (await journal.dispatchIntent(active.writerId, 1, requestId))!;
  const response = encodeNativeBrokerFrame({
    direction: "response",
    brokerId: f.binding.brokerId,
    commandId,
    requestId,
    ownerEpoch: 1,
    sequence: 3,
    kind: "status",
    offset: 0,
    payload: Buffer.from(body),
  });
  if (capture)
    await journal.captureOutput(
      "1-0",
      page(f, Buffer.concat([accepted(f, sent.input, 2), response]).toString(), "2-0"),
    );
  const proof = { requestId, ownerEpoch: 1, inputSequence: sent.index, responseSequence: 3 };
  return { f, command, custody, proof, journal };
}

test.each([false, true])(
  "broker %s never-started cancellation settles exact custody without exit or fabricated output",
  async (pty) => {
    const { f, command, custody, proof } = await neverStartedFixture(pty);
    await Promise.all([
      custody.persistence.rejectBrokerLaunch(command, proof),
      rejectRetainedBrokerLaunch(client.db, custody.scope, command, proof),
    ]);
    const process = (await getRetainedProcess(client.db, custody.scope))!;
    expect(process).toMatchObject({
      state: "lost",
      exitCode: null,
      settlementReason: "provider_start_rejected",
    });
    expect(await custody.persistence.load()).toEqual(command);
    expect(await custody.persistence.loadSupervisionReceipt()).toBeNull();
    const [row] =
      await database.admin`select supervision_output_captured from sandbox_retained_processes where id=${custody.scope.processId}`;
    expect(row!.supervision_output_captured).toBe(false);
    const [admission] =
      await database.admin`select provider_outcome, settled_at from sandbox_workspace_mutation_admissions where id=${process.parentAdmissionId}`;
    expect(admission!.provider_outcome).toBe("rejected");
    expect(admission!.settled_at).not.toBeNull();
    expect(
      await database.admin`select holder_id from sandbox_lease_holders where lease_id=${f.binding.leaseId} and holder_id=${process.holderId}`,
    ).toHaveLength(0);
    const [lease] =
      await database.admin`select lease_epoch, instance_id from sandbox_leases where id=${f.binding.leaseId}`;
    expect(lease).toMatchObject({
      lease_epoch: f.binding.createEpoch,
      instance_id: f.binding.sandboxId,
    });
    await expect(custody.settle()).rejects.toThrow();
  },
);

test("never-started settlement rejects missing, altered, foreign or non-cancel journal evidence", async () => {
  const good = await neverStartedFixture();
  for (const proof of [
    { ...good.proof, requestId: crypto.randomUUID() },
    { ...good.proof, inputSequence: 1 },
    { ...good.proof, responseSequence: 2 },
    { ...good.proof, ownerEpoch: 2 },
  ])
    await expect(good.custody.persistence.rejectBrokerLaunch(good.command, proof)).rejects.toThrow(
      "committed",
    );
  for (const [payload, body, capture] of [
    ["cancel", '{"state":"not_started","launchClosed":true}', false],
    ["release", '{"state":"not_started","launchClosed":true}', true],
    ["cancel", '{"state":"running"}', true],
    ["cancel", '{"state":"not_started","launchClosed":false}', true],
  ] as const) {
    const other = await neverStartedFixture(false, payload, body, capture);
    await expect(
      other.custody.persistence.rejectBrokerLaunch(other.command, other.proof),
    ).rejects.toThrow("committed");
    await expect(
      other.custody.persistence.rejectBrokerLaunch(other.command, good.proof),
    ).rejects.toThrow("committed");
    expect((await getRetainedProcess(client.db, other.custody.scope))!.state).toBe("active");
  }
});

test("ordinary lost callbacks and a forged old launch marker cannot bypass the independent broker proof guard", async () => {
  const { command, custody } = await neverStartedFixture(false, "cancel", undefined, false);
  const expected = (await getRetainedProcess(client.db, custody.scope))!;
  await expect(
    settleRetainedProcess(client.db, {
      ...custody.scope,
      expected,
      outcome: "lost",
      reason: "provider_start_rejected",
      idleGraceMs: 0,
    }),
  ).rejects.toThrow();
  await expect(
    database.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.supervised_launch_rejection_binding', ${JSON.stringify({ processId: custody.scope.processId, command })}, true)`;
      await tx`update sandbox_retained_processes set state='lost',exit_code=null,settled_at=now(),settlement_reason='provider_start_rejected' where id=${custody.scope.processId}`;
    }),
  ).rejects.toThrow("committed cancellation proof");
  expect((await getRetainedProcess(client.db, custody.scope))!.state).toBe("active");
});

test("even a real never-started reply cannot erase admitted stdin or captured command output", async () => {
  const child = await neverStartedFixture(false, "cancel", undefined, true, true);
  await expect(
    child.custody.persistence.rejectBrokerLaunch(child.command, child.proof),
  ).rejects.toThrow("admitted process input");
  const output = await neverStartedFixture();
  const next = structuredClone(output.command);
  next.capture.sequence = 3;
  next.streams.stdout.byteOffset = 1;
  await output.custody.persistence.captureBrokerPage({
    expected: output.command,
    command: next,
    stdout: "x",
    stderr: "",
  });
  await expect(output.custody.persistence.rejectBrokerLaunch(next, output.proof)).rejects.toThrow(
    "pristine",
  );
});

test("broker never-started settlement cannot expose a caller-owned savepoint as committed proof", async () => {
  const f = await neverStartedFixture();
  await withRlsContext(client.db, f.custody.scope, async (tx) => {
    await expect(
      rejectRetainedBrokerLaunch(tx, f.custody.scope, f.command, f.proof),
    ).rejects.toThrow("outer commit boundary");
  });
  expect((await getRetainedProcess(client.db, f.custody.scope))!.state).toBe("active");
  await f.custody.persistence.rejectBrokerLaunch(f.command, f.proof);
  expect((await getRetainedProcess(client.db, f.custody.scope))!.state).toBe("lost");
});

test("retained stdin commits one byte reservation and one immutable request under concurrent replay", async () => {
  const { f, active, input, counter, custody } = await stdinFixture();
  const bytes = Buffer.from("hello\u0000binary");
  const results = await Promise.all(
    [1, 2].map(() => f.service().reserveRetainedStdin(active.writerId, 1, input, bytes)),
  );
  expect(results.map((r) => [r.index, r.offset])).toEqual([
    [2, 0],
    [2, 0],
  ]);
  expect(results.filter((r) => r.alreadyReserved)).toHaveLength(1);
  expect(await counter()).toBe(bytes.length);
  await expect(custody.persistence.reserveInput!(1)).rejects.toThrow("atomically");
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, input, Buffer.from("changed")),
  ).rejects.toThrow();
  await expect(f.service().dispatchIntent(active.writerId, 1, input.admissionId)).rejects.toThrow();
  expect(await counter()).toBe(bytes.length);
  const write = (await f.service().dispatchRetainedStdinIntent(active.writerId, 1, input))!;
  await f
    .service()
    .captureOutput("1-0", page(f, Buffer.from(accepted(f, write.input, 2)).toString(), "2-0"));
  const second = await custody.inputAdmission();
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, second, Buffer.from("next")),
  ).rejects.toThrow();
  expect(await counter()).toBe(bytes.length);
  expect(await f.service().request(second.admissionId)).toBeNull();
  await f
    .service()
    .captureOutput(
      "2-0",
      page(
        f,
        Buffer.from(
          nativeReply(f, write.input, 3, "status", { stdinWritten: true }, bytes.length),
        ).toString(),
        "3-0",
      ),
    );
  expect((await f.service().requestReply(input.admissionId))?.offset).toBe(bytes.length);
  expect(
    await f.service().reserveRetainedStdin(active.writerId, 1, second, Buffer.from("next")),
  ).toMatchObject({ index: 3, offset: bytes.length });
  expect(await counter()).toBe(bytes.length + 4);
});

test("missing, partial and invalid native stdin outcomes never authorize a later byte range", async () => {
  for (const [kind, body, offset] of [
    ["status", { stdinWritten: true }, 2],
    ["error", { error: "stdin_closed" }, 2],
    ["status", { accepted: true }, 4],
    ["status", { stdinWritten: true, extra: "not native" }, 4],
  ] as const) {
    const { f, active, input, counter, custody } = await stdinFixture();
    await f.service().reserveRetainedStdin(active.writerId, 1, input, Buffer.from("once"));
    const write = (await f.service().dispatchRetainedStdinIntent(active.writerId, 1, input))!;
    await f
      .service()
      .captureOutput(
        "1-0",
        page(
          f,
          Buffer.concat([
            accepted(f, write.input, 2),
            nativeReply(f, write.input, 3, kind, body, offset),
          ]).toString(),
          "2-0",
        ),
      );
    expect((await f.service().requestReply(input.admissionId))?.kind).toBe(kind);
    const next = await custody.inputAdmission();
    await expect(
      f.service().reserveRetainedStdin(active.writerId, 1, next, Buffer.from("new")),
    ).rejects.toThrow();
    expect(await counter()).toBe(4);
    expect(await f.service().request(next.admissionId)).toBeNull();
    await expect(
      f
        .service()
        .captureOutput(
          "2-0",
          page(
            f,
            Buffer.from(
              nativeReply(f, write.input, 4, "status", { stdinWritten: true }, 4),
            ).toString(),
            "3-0",
          ),
        ),
    ).rejects.toThrow();
    expect((await f.service().read()).output.lastSequence).toBe(3);
  }
});

test("busy channel, invalid writer and oversized stdin roll back the canonical byte offset", async () => {
  const { f, active, input, counter, custody } = await stdinFixture();
  await expect(
    f.service().reserveRetainedStdin(crypto.randomUUID(), 1, input, Buffer.from("x")),
  ).rejects.toThrow();
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, input, new Uint8Array(16384)),
  ).rejects.toThrow();
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, input, new Uint8Array()),
  ).rejects.toThrow();
  expect(await counter()).toBe(0);
  expect(await f.service().request(input.admissionId)).toBeNull();
  await f.service().reserveRetainedStdin(active.writerId, 1, input, Buffer.from("first"));
  const second = await custody.inputAdmission();
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, second, Buffer.from("lost")),
  ).rejects.toThrow();
  expect(await counter()).toBe(5);
  expect(await f.service().request(second.admissionId)).toBeNull();
  await expect(
    f.store.retainedInputTransaction(second, async (tx) => {
      await tx.reserveInput(7);
      throw new Error("fixture rollback after byte reservation");
    }),
  ).rejects.toThrow();
  expect(await counter()).toBe(5);
});

test("stdin reservation requires exact session, process, command and existing child admission", async () => {
  const { f, active, input, counter } = await stdinFixture();
  const other = await stdinFixture();
  for (const changed of [
    { sessionId: other.input.sessionId },
    { processId: other.input.processId },
    { commandId: other.input.commandId },
    { admissionId: other.input.admissionId },
    { admissionId: crypto.randomUUID() },
  ])
    await expect(
      f
        .service()
        .reserveRetainedStdin(active.writerId, 1, { ...input, ...changed }, Buffer.from("x")),
    ).rejects.toThrow();
  await database.admin`update sandbox_workspace_mutation_admissions set settled_at=now(), provider_outcome='rejected' where id=${input.admissionId}`;
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, input, Buffer.from("x")),
  ).rejects.toThrow();
  expect(await counter()).toBe(0);
  expect(await f.service().request(input.admissionId)).toBeNull();
  expect(await other.counter()).toBe(0);
});

test("cancel closes new stdin but preserves the exact already committed request for reconciliation", async () => {
  const { f, active, input, counter, custody } = await stdinFixture();
  const bytes = Buffer.from("original");
  await f.service().reserveRetainedStdin(active.writerId, 1, input, bytes);
  const before = (await f.service().dispatchRetainedStdinIntent(active.writerId, 1, input))!;
  const fresh = await custody.inputAdmission();
  await custody.persistence.requestCancellation!("explicit_stop");
  await database.admin`update sandbox_workspace_mutation_admissions set settled_at=now(), provider_outcome='rejected' where id=${input.admissionId}`;
  await database.admin`update native_command_broker_transports set writer_until=now()-interval '1 second', revision=revision+1 where id=${f.binding.brokerId}`;
  const next = crypto.randomUUID();
  expect(await f.service().claimWriter(next)).toMatchObject({ epoch: 2 });
  expect(await f.service().reserveRetainedStdin(next, 2, input, bytes)).toMatchObject({
    alreadyReserved: true,
    offset: 0,
  });
  const replay = await f.service().dispatchRetainedStdinIntent(next, 2, input);
  expect(replay).toEqual(before);
  await expect(
    f.service().reserveRetainedStdin(next, 2, fresh, Buffer.from("new")),
  ).rejects.toThrow();
  expect(await counter()).toBe(bytes.length);
});

test("stdin driver never silently repeats an unknown write and requires exact recovery scope", async () => {
  const { f, active, input, counter } = await stdinFixture();
  const writes: Uint8Array[] = [];
  const channel: NativeBrokerChannel = {
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    async write(value) {
      writes.push(value.input);
      throw new Error("fixture unknown acknowledgement");
    },
    async *output() {},
  };
  const driver = new NativeBrokerDriver(f.service(), channel, active.writerId);
  await expect(driver.sendRetainedStdin(input, Buffer.from("once"))).rejects.toBeInstanceOf(
    NativeBrokerDispatchUnknownError,
  );
  expect(await driver.sendRetainedStdin(input, Buffer.from("once"))).toMatchObject({
    state: "reconciliation_required",
    offset: 0,
  });
  await expect(driver.replayPending()).rejects.toThrow("exact retained admission");
  await expect(
    driver.replayPending(undefined, { ...input, processId: crypto.randomUUID() }),
  ).rejects.toThrow();
  expect(writes).toHaveLength(1);
  await expect(driver.replayPending(undefined, input)).rejects.toBeInstanceOf(
    NativeBrokerDispatchUnknownError,
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(await counter()).toBe(4);
});

test("launch reply indexing preserves later stream EOF facts without rewriting the operation reply", async () => {
  const f = await fixture();
  const active = await start(f);
  await f
    .service()
    .captureOutput("0-0", page(f, Buffer.from(accepted(f, active.write.input)).toString()));
  const request = { ...fence(), kind: "launch" as const, commandId: crypto.randomUUID() };
  await f.service().reserve(active.writerId, 1, request);
  const write = (await f.service().dispatchIntent(active.writerId, 1, request.requestId))!;
  const startup = { state: "supervisor_started", released: false };
  await f
    .service()
    .captureOutput(
      "1-0",
      page(
        f,
        Buffer.concat([
          accepted(f, write.input, 2),
          nativeReply(f, write.input, 3, "status", startup),
          nativeReply(f, write.input, 4, "status", { stream: "stdout", eof: true }, 10),
          nativeReply(f, write.input, 5, "status", { stream: "stderr", eof: true }),
        ]).toString(),
        "2-0",
      ),
    );
  expect(
    JSON.parse(
      Buffer.from((await f.service().requestReply(request.requestId))!.payload).toString(),
    ),
  ).toEqual(startup);
  expect((await f.service().read()).output.lastSequence).toBe(5);
  await expect(
    f
      .service()
      .captureOutput(
        "2-0",
        page(
          f,
          Buffer.from(nativeReply(f, write.input, 6, "error", { error: "changed" })).toString(),
          "3-0",
        ),
      ),
  ).rejects.toThrow();
  expect((await f.service().read()).output.lastSequence).toBe(5);
});
function fence() {
  return {
    requestId: crypto.randomUUID(),
    commandId: null,
    kind: "fence" as const,
    offset: 0,
    payload: new Uint8Array(),
  };
}
function page(f: Fixture, wire: string, entryId = "1-0"): NativeBrokerOutputPage {
  return {
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    requestedFileDescriptor: 1,
    entryId,
    items: [{ fileDescriptor: 1, data: wire }],
    eof: false,
  };
}
function accepted(f: Fixture, bytes: Uint8Array, sequence = 1) {
  const decoder = new NativeBrokerFrameDecoder(f.binding.brokerId);
  const request = decoder.push(bytes)[0]!;
  decoder.finish();
  return encodeNativeBrokerFrame({
    ...request,
    direction: "response",
    kind: "accepted",
    sequence,
    offset: request.sequence,
    payload: new Uint8Array(),
  });
}
function nativeReply(
  f: Fixture,
  bytes: Uint8Array,
  sequence: number,
  kind: "status" | "error",
  body: unknown,
  offset = 0,
) {
  const decoder = new NativeBrokerFrameDecoder(f.binding.brokerId);
  const request = decoder.push(bytes)[0]!;
  decoder.finish();
  return encodeNativeBrokerFrame({
    ...request,
    direction: "response",
    kind,
    sequence,
    offset,
    payload: Buffer.from(JSON.stringify(body)),
  });
}
async function start(f: Fixture) {
  const writerId = crypto.randomUUID();
  const writer = await f.service().claimWriter(writerId);
  const request = fence();
  await f.service().reserve(writerId, writer.epoch, request);
  const write = (await f.service().dispatchIntent(writerId, writer.epoch, request.requestId))!;
  return { writerId, writer, request, write };
}

test("registration requires exact attributed creation and never rewinds an existing journal", async () => {
  const f = await fixture(false);
  for (const changed of [
    { createOperationId: crypto.randomUUID() },
    { createEpoch: 2 },
    { sandboxId: "sb-wrong" },
    {
      providerBindingKey: JSON.stringify({
        version: 1,
        serverUrl: "https://api.modal.test",
        workspaceName: "other",
        environment: "test",
      }),
    },
  ]) {
    await expect(
      registerNativeBrokerTransport(client.db, key, { ...f.binding, ...changed }, f.initial),
    ).rejects.toThrow();
  }
  await registerNativeBrokerTransport(client.db, key, f.binding, f.initial);
  await start(f);
  const before = await f.service().read();
  await registerNativeBrokerTransport(client.db, key, f.binding, f.initial);
  expect(await f.service().read()).toEqual(before);
  await expect(
    registerNativeBrokerTransport(client.db, key, f.binding, { ...f.initial, version: 2 }),
  ).rejects.toThrow();
  await expect(
    registerNativeBrokerTransport(client.db, key, { ...f.binding, taskId: "other" }, f.initial),
  ).rejects.toThrow();
});

test("control reply index commits with its accepted request/frame and rejects conflicting replay", async () => {
  const f = await fixture();
  const active = await start(f);
  await f
    .service()
    .captureOutput("0-0", page(f, Buffer.from(accepted(f, active.write.input)).toString()));
  const request = {
    ...fence(),
    kind: "control" as const,
    commandId: crypto.randomUUID(),
    payload: Buffer.from("cancel"),
  };
  await f.service().reserve(active.writerId, active.writer.epoch, request);
  const input = (await f
    .service()
    .dispatchIntent(active.writerId, active.writer.epoch, request.requestId))!;
  const reply = {
    direction: "response" as const,
    brokerId: f.binding.brokerId,
    ownerEpoch: 1,
    sequence: 3,
    requestId: request.requestId,
    commandId: request.commandId,
    kind: "error" as const,
    offset: 0,
    payload: Buffer.from('{"error":"control_unavailable"}'),
  };
  expect(await f.service().controlReply(request.requestId)).toBeNull();
  // A response before native acceptance cannot create an authority-bearing index.
  await expect(
    f
      .service()
      .captureOutput(
        "1-0",
        page(f, Buffer.from(encodeNativeBrokerFrame({ ...reply, sequence: 2 })).toString(), "2-0"),
      ),
  ).rejects.toThrow();
  expect((await f.service().read()).output.lastSequence).toBe(1);
  await f
    .service()
    .captureOutput(
      "1-0",
      page(
        f,
        Buffer.concat([accepted(f, input.input, 2), encodeNativeBrokerFrame(reply)]).toString(),
        "2-0",
      ),
    );
  expect(await f.service().controlReply(request.requestId)).toEqual(reply);
  const conflict = encodeNativeBrokerFrame({
    ...reply,
    sequence: 4,
    payload: Buffer.from('{"error":"control_pressure"}'),
  });
  await expect(
    f.service().captureOutput("2-0", page(f, Buffer.from(conflict).toString(), "3-0")),
  ).rejects.toThrow();
  expect((await f.service().read()).output.lastSequence).toBe(3);
  expect(await f.service().controlReply(request.requestId)).toEqual(reply);
  await expect(
    withRlsContext(client.db, f.binding, (tx) =>
      tx.execute(sql`DELETE FROM native_command_broker_entries
    WHERE broker_id=${f.binding.brokerId} AND kind='control_reply'`),
    ),
  ).rejects.toThrow();
  expect(await f.service().controlReply(request.requestId)).toEqual(reply);
});

test("concurrent writer claims elect one owner; stale and foreign owners cannot dispatch", async () => {
  const f = await fixture();
  const owners = [crypto.randomUUID(), crypto.randomUUID()];
  const results = await Promise.allSettled(owners.map((id) => f.service().claimWriter(id)));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const loser = owners[results.findIndex((r) => r.status === "rejected")]!;
  await expect(f.service().reserve(loser, 1, fence())).rejects.toThrow();
});

test("concurrent registration is idempotent and a second broker cannot bind the same physical creation", async () => {
  const f = await fixture(false);
  await Promise.all(
    [1, 2].map(() => registerNativeBrokerTransport(client.db, key, f.binding, f.initial)),
  );
  expect(await f.service().read()).toEqual(f.initial);
  const different = { ...f.binding, brokerId: crypto.randomUUID() };
  await expect(
    registerNativeBrokerTransport(
      client.db,
      key,
      different,
      initialNativeBrokerTransportState(different),
    ),
  ).rejects.toThrow();
});

test("nested savepoint handles cannot return a dispatch before the actual outer commit", async () => {
  const f = await fixture();
  await withRlsContext(client.db, f.binding, async (tx) => {
    expect(() => createDurableNativeBrokerTransport(tx, key, f.binding)).toThrow("outer commit");
    await expect(registerNativeBrokerTransport(tx, key, f.binding, f.initial)).rejects.toThrow(
      "outer commit",
    );
    await expect(
      registerCapturedNativeBrokerBootstrap(
        tx,
        key,
        f.binding,
        {
          sandboxId: f.binding.sandboxId,
          taskId: f.binding.taskId,
          output() {
            throw new Error("provider read inside a transaction");
          },
        },
        { artifactSha256: f.binding.artifactSha256, byteSize: 64, target: "linux-amd64" },
      ),
    ).rejects.toThrow("outer commit");
    await expect(
      registerQualifiedNativeBrokerBootstrap(tx, key, bootstrapAdmission(f), {
        sandboxId: f.binding.sandboxId,
        taskId: f.binding.taskId,
        output() {
          throw new Error("qualified provider read inside a transaction");
        },
        diagnostics() {
          throw new Error("qualified diagnostics read inside a transaction");
        },
      }),
    ).rejects.toThrow("outer commit");
  });
});

test("request reservation and dispatch survive client restart with exact bytes and no duplicate indices", async () => {
  const f = await fixture();
  const { writerId, request, write } = await start(f);
  expect(write.eof).toBe(false);
  expect(await f.service().reserve(writerId, 1, request)).toEqual({
    index: 1,
    alreadyReserved: true,
  });
  expect(await f.service().dispatchIntent(writerId, 1, request.requestId)).toEqual(write);
  await expect(
    f.service().reserve(writerId, 1, { ...request, payload: Buffer.from("different") }),
  ).rejects.toThrow();
  await f.service().providerAcknowledged(writerId, 1, request.requestId);
  await expect(f.service().reserve(writerId, 1, fence())).rejects.toThrow();
  expect((await f.service().read()).input.lastAcceptedInputIndex).toBe(0);
  await f.service().captureOutput("0-0", page(f, Buffer.from(accepted(f, write.input)).toString()));
  expect((await f.service().read()).input.lastAcceptedInputIndex).toBe(1);
  expect(await f.service().dispatchIntent(writerId, 1, request.requestId)).toBeNull();
});

test("failed transaction retains neither request nor advanced state", async () => {
  const f = await fixture();
  const before = await f.service().read();
  await expect(
    f.store.transaction(async (tx) => {
      await tx.insert({
        kind: "request",
        key: crypto.randomUUID(),
        sequence: 1,
        value: "secret-input",
      });
      tx.save({ bad: true });
      throw new Error("injected commit failure");
    }),
  ).rejects.toThrow("injected");
  expect(await f.service().read()).toEqual(before);
  const rows =
    await database.admin`SELECT * FROM native_command_broker_entries WHERE broker_id = ${f.binding.brokerId}`;
  expect(rows).toHaveLength(0);
});

test("one partial frame, cursor, immutable inbox and acceptance commit atomically", async () => {
  const f = await fixture();
  const { write } = await start(f);
  const wire = Buffer.from(accepted(f, write.input)).toString();
  await f.service().captureOutput("0-0", page(f, wire.slice(0, 17)));
  const partial = await f.service().read();
  expect(partial.output.partialBase64).not.toBe("");
  expect(partial.input.lastAcceptedInputIndex).toBe(0);
  await expect(
    f.service().captureOutput("1-0", page(f, wire.slice(17) + "INVALID\n", "2-0")),
  ).rejects.toThrow();
  expect(await f.service().read()).toEqual(partial);
  await f.service().captureOutput("1-0", page(f, wire.slice(17), "2-0"));
  expect((await f.service().read()).input.lastAcceptedInputIndex).toBe(1);
  const counts =
    await database.admin`SELECT kind,count(*)::int AS count FROM native_command_broker_entries
    WHERE broker_id = ${f.binding.brokerId} GROUP BY kind ORDER BY kind`;
  expect(counts.map((row) => [row.kind, row.count])).toEqual([
    ["frame", 1],
    ["page", 2],
    ["request", 1],
  ]);
});

test("expired writer takeover replays old pending body before its own fence", async () => {
  const f = await fixture();
  const { writerId, write, request } = await start(f);
  await database.admin`UPDATE native_command_broker_transports SET writer_until = now() - interval '1 second', revision = revision + 1 WHERE id = ${f.binding.brokerId}`;
  const successor = crypto.randomUUID();
  expect(await f.service().claimWriter(successor)).toMatchObject({ epoch: 2, live: true });
  await expect(f.service().dispatchIntent(writerId, 1, request.requestId)).rejects.toThrow();
  expect(await f.service().dispatchIntent(successor, 2, request.requestId)).toEqual(write);
  await expect(f.service().reserve(successor, 2, fence())).rejects.toThrow();
  await f.service().captureOutput("0-0", page(f, Buffer.from(accepted(f, write.input)).toString()));
  const next = fence();
  expect(await f.service().reserve(successor, 2, next)).toMatchObject({ index: 2 });
  const nextWrite = (await f.service().dispatchIntent(successor, 2, next.requestId))!;
  await f
    .service()
    .captureOutput("1-0", page(f, Buffer.from(accepted(f, nextWrite.input, 2)).toString(), "2-0"));
  expect((await f.service().read()).input.acceptedWriterEpoch).toBe(2);
});

test("racing output collectors cannot split or duplicate a committed page", async () => {
  const f = await fixture();
  const { write } = await start(f);
  const output = page(f, Buffer.from(accepted(f, write.input)).toString());
  const attempts = await Promise.allSettled(
    [1, 2].map(() => f.service().captureOutput("0-0", output)),
  );
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(await f.service().captureOutput("1-0", output)).toMatchObject({ capturedFrames: 0 });
  const frames = await database.admin`SELECT sequence FROM native_command_broker_entries
    WHERE broker_id = ${f.binding.brokerId} AND kind = 'frame'`;
  expect(frames).toHaveLength(1);
  expect((await f.service().read()).input.lastAcceptedInputIndex).toBe(1);
});

test("two identical input reservations consume only one durable index", async () => {
  const f = await fixture();
  const owner = crypto.randomUUID();
  await f.service().claimWriter(owner);
  const request = fence();
  const results = await Promise.all([1, 2].map(() => f.service().reserve(owner, 1, request)));
  expect(results.map((result) => result.index)).toEqual([1, 1]);
  expect(results.filter((result) => result.alreadyReserved)).toHaveLength(1);
  expect((await f.service().read()).input.lastReservedInputIndex).toBe(1);
});

test("output replay is immutable and provider EOF cannot settle a pending command", async () => {
  const f = await fixture();
  const { write, writerId } = await start(f);
  const output = page(f, Buffer.from(accepted(f, write.input)).toString());
  await f.service().captureOutput("0-0", output);
  expect(await f.service().captureOutput("1-0", output)).toMatchObject({ capturedFrames: 0 });
  await expect(
    f
      .service()
      .captureOutput("1-0", { ...output, items: [{ fileDescriptor: 1, data: "changed" }] }),
  ).rejects.toThrow();
  const command = { ...fence(), kind: "prepare" as const, commandId: crypto.randomUUID() };
  await f.service().reserve(writerId, 1, command);
  await f.service().dispatchIntent(writerId, 1, command.requestId);
  const end = { ...output, entryId: "", items: [], eof: true };
  await f.service().captureOutput("1-0", end);
  await f.service().captureOutput("1-0", end);
  expect((await f.service().read()).output).toMatchObject({
    cursor: "1-0",
    providerEof: true,
    lastSequence: 1,
  });
  expect(Object.keys(await f.service().read()).sort()).toEqual(["input", "output", "version"]);
  expect((await f.service().read()).input.pending?.phase).toBe("dispatch_intent");
  await expect(f.service().dispatchIntent(writerId, 1, command.requestId)).rejects.toThrow();
  await expect(f.service().claimWriter(writerId)).rejects.toThrow();
});

test("cross-workspace RLS, immutable receipts, ciphertext and physical identities are enforced", async () => {
  const f = await fixture();
  const other = await fixture();
  const { write } = await start(f);
  await f.service().captureOutput("0-0", page(f, Buffer.from(accepted(f, write.input)).toString()));
  const visible = await withRlsContext(client.db, other.binding, (tx) =>
    rawRows(
      tx,
      sql`SELECT * FROM native_command_broker_transports WHERE id = ${f.binding.brokerId}::uuid`,
    ),
  );
  expect(visible).toHaveLength(0);
  const receipts = await withRlsContext(client.db, other.binding, (tx) =>
    rawRows(
      tx,
      sql`SELECT * FROM native_command_broker_entries WHERE broker_id = ${f.binding.brokerId}::uuid`,
    ),
  );
  expect(receipts).toHaveLength(0);
  await expect(
    createDurableNativeBrokerTransport(client.db, key, { ...f.binding, taskId: "foreign" }).read(),
  ).rejects.toThrow();
  await expect(
    createDurableNativeBrokerTransport(client.db, randomBytes(32), f.binding).read(),
  ).rejects.toThrow();
  const raw =
    await database.admin`SELECT state_encrypted FROM native_command_broker_transports WHERE id = ${f.binding.brokerId}`;
  expect(raw[0]!.state_encrypted.startsWith("v2:")).toBe(true);
  expect(raw[0]!.state_encrypted).not.toContain("frameBase64");
  await expect(
    withRlsContext(client.db, f.binding, (tx) =>
      tx.execute(
        sql`DELETE FROM native_command_broker_entries WHERE broker_id = ${f.binding.brokerId}::uuid`,
      ),
    ),
  ).rejects.toThrow();
  await expect(
    (async () => {
      await database.admin`UPDATE native_command_broker_entries SET sha256 = ${"f".repeat(64)} WHERE broker_id = ${f.binding.brokerId}`;
    })(),
  ).rejects.toThrow("immutable");
  await expect(
    (async () => {
      await database.admin`UPDATE native_command_broker_transports SET binding = '{}'::jsonb, revision = revision+1 WHERE id = ${f.binding.brokerId}`;
    })(),
  ).rejects.toThrow();
});

test("late output remains capturable after physical replacement, but no input can be dispatched", async () => {
  const f = await fixture();
  const { writerId, request, write } = await start(f);
  // Test-only direct owner setup; production replacement remains the canonical lease path.
  await database.admin`UPDATE sandbox_leases SET provider_create_attempt = NULL, instance_id = NULL, liveness = 'cold' WHERE id = ${f.binding.leaseId}`;
  await expect(f.service().dispatchIntent(writerId, 1, request.requestId)).rejects.toThrow();
  await f.service().captureOutput("0-0", page(f, Buffer.from(accepted(f, write.input)).toString()));
  expect((await f.service().read()).input.lastAcceptedInputIndex).toBe(1);
});

test("committed frame scans are bounded, ordered, restartable and physical-scope fenced", async () => {
  const f = await fixture();
  const { write } = await start(f);
  const first = accepted(f, write.input);
  // Cross 9/10: the query must order the numeric column, not its text alias.
  const more = Array.from({ length: 14 }, (_, i) =>
    encodeNativeBrokerFrame({
      direction: "response",
      brokerId: f.binding.brokerId,
      ownerEpoch: 1,
      sequence: i + 2,
      requestId: f.binding.brokerId,
      commandId: null,
      kind: "status",
      offset: 0,
      payload: Buffer.from("{}"),
    }),
  );
  await f.service().captureOutput("0-0", page(f, Buffer.concat([first, ...more]).toString()));
  expect((await f.service().framesAfter(0, 2)).frames.map((frame) => frame.sequence)).toEqual([
    1, 2,
  ]);
  expect((await f.service().framesAfter(2, 2)).frames.map((frame) => frame.sequence)).toEqual([
    3, 4,
  ]);
  expect(await f.service().framesAfter(14, 2)).toMatchObject({
    frames: [{ sequence: 15 }],
    lastSequence: 15,
    providerEof: false,
  });
  expect((await f.service().framesAfter(15)).frames).toHaveLength(0);
  expect((await f.service().framesAfter(0)).frames.map((frame) => frame.sequence)).toEqual(
    Array.from({ length: 15 }, (_, i) => i + 1),
  );
  for (const [sequence, limit] of [
    [-1, 2],
    [16, 2],
    [0, 0],
    [0, 129],
  ])
    await expect(f.service().framesAfter(sequence!, limit!)).rejects.toThrow();
  const foreign = createDurableNativeBrokerTransport(client.db, key, {
    ...f.binding,
    workspaceId: crypto.randomUUID(),
  });
  await expect(foreign.framesAfter(0)).rejects.toThrow();
});

function driverFixture(
  f: Fixture,
  options: {
    write?: NativeBrokerChannel["write"];
    output?: NativeBrokerChannel["output"];
    writerId?: string;
  } = {},
) {
  const writes: Parameters<NativeBrokerChannel["write"]>[0][] = [];
  const channel: NativeBrokerChannel = {
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    write:
      options.write ??
      (async (input) => {
        writes.push(input);
      }),
    output: options.output ?? async function* () {},
  };
  const writerId = options.writerId ?? crypto.randomUUID();
  return {
    channel,
    writerId,
    writes,
    driver: new NativeBrokerDriver(f.service(), channel, writerId),
  };
}

test("driver sends only after intent is durably readable and never repeats known unresolved input", async () => {
  const f = await fixture();
  const request = fence();
  let physicalCalls = 0;
  const setup = driverFixture(f, {
    write: async () => {
      physicalCalls++;
      expect(await f.service().request(request.requestId)).toMatchObject({
        phase: "dispatch_intent",
        accepted: false,
      });
    },
  });
  expect(await setup.driver.send(request)).toEqual({ state: "provider_acknowledged", index: 1 });
  expect(await setup.driver.send(request)).toEqual({ state: "reconciliation_required", index: 1 });
  expect(physicalCalls).toBe(1);
  expect((await f.service().read()).input.pending?.phase).toBe("provider_acknowledged");
});

test("unknown driver write survives restart; only explicit exact replay can send it again", async () => {
  const f = await fixture();
  const request = fence();
  const writes: Parameters<NativeBrokerChannel["write"]>[0][] = [];
  const first = driverFixture(f, {
    write: async (input) => {
      writes.push(input);
      throw new Error("lost response");
    },
  });
  await expect(first.driver.send(request)).rejects.toBeInstanceOf(NativeBrokerDispatchUnknownError);
  const next = driverFixture(f, {
    writerId: first.writerId,
    write: async (input) => {
      writes.push(input);
    },
  });
  expect(await next.driver.send(request)).toEqual({ state: "reconciliation_required", index: 1 });
  expect(writes).toHaveLength(1);
  expect(await next.driver.replayPending()).toEqual({ state: "provider_acknowledged" });
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect((await f.service().read()).input.lastReservedInputIndex).toBe(1);
});

test("driver captures acceptance before next input and reads late output after instance replacement", async () => {
  const f = await fixture();
  const request = fence();
  let output: NativeBrokerOutputPage;
  const setup = driverFixture(f, {
    write: async (input) => {
      output = page(f, Buffer.from(accepted(f, input.input)).toString());
    },
    output: async function* () {
      yield output;
    },
  });
  await setup.driver.send(request);
  await database.admin`UPDATE sandbox_leases SET provider_create_attempt = NULL, instance_id = NULL, liveness = 'cold' WHERE id = ${f.binding.leaseId}`;
  expect(await setup.driver.observe(undefined, 1)).toEqual({
    pages: 1,
    capturedFrames: 1,
    providerEof: false,
  });
  expect(await f.service().request(request.requestId)).toMatchObject({
    accepted: true,
    phase: "accepted",
  });
  await expect(setup.driver.send(fence())).rejects.toThrow();
});

test("provider page commit failure prevents requesting a successor or advancing captured cursor", async () => {
  const f = await fixture();
  const request = fence();
  let nextRequested = false,
    closed = false;
  const setup = driverFixture(f, {
    output: async function* () {
      try {
        yield page(f, "invalid\n");
        nextRequested = true;
        yield page(f, "", "2-0");
      } finally {
        closed = true;
      }
    },
  });
  await setup.driver.send(request);
  await expect(setup.driver.observe()).rejects.toThrow();
  expect(nextRequested).toBe(false);
  expect(closed).toBe(true);
  expect((await f.service().read()).output.cursor).toBe("0-0");
});

test("driver bounds pages and local overlapping writes without serializing cancellation behind a log read", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const setup = driverFixture(f, {
    write: async () => {
      entered();
      await gate;
    },
  });
  const first = setup.driver.send(fence());
  await ready;
  await expect(setup.driver.send(fence())).rejects.toThrow("already in progress");
  // Read observation is independent of the pending write.
  expect(await setup.driver.observe()).toEqual({ pages: 0, capturedFrames: 0, providerEof: false });
  release();
  await first;
  const cancel = new AbortController();
  cancel.abort(new Error("caller stopped"));
  await expect(setup.driver.send(fence(), cancel.signal)).rejects.toThrow("caller stopped");
  await expect(setup.driver.observe(undefined, 129)).rejects.toThrow("bound");
  expect((await f.service().read()).input.lastReservedInputIndex).toBe(1);
});

// Explicit native build fixture only. Normal CI exercises deterministic transport
// and real PostgreSQL above; this additionally needs the repository's static
// ELF and Linux subreaper/pidfd/PTY kernel primitives. It is not Modal admission.
test.skipIf(process.env.OPENGENI_NATIVE_BROKER_LOCAL !== "1")(
  "actual static broker and PostgreSQL journal survive lost dispatch, writer takeover and exact settlement",
  async () => {
    const artifactRoot = join(import.meta.dir, "../../../agent/native/command-supervisor");
    const manifest = JSON.parse(await readFile(join(artifactRoot, "build/artifact.json"), "utf8"));
    const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
    expect(sha(await readFile(join(artifactRoot, "supervisor.c")))).toBe(manifest.sourceFileSha256);
    const elf = await readFile(join(artifactRoot, "build/opengeni-command-supervisor"));
    expect(sha(elf)).toBe(manifest.artifactSha256);
    expect(elf.length).toBe(manifest.byteSize);
    const artifactPin = {
      artifactSha256: manifest.artifactSha256,
      byteSize: manifest.byteSize,
      target: manifest.target,
    };
    const f = await fixture(false, artifactPin);
    const directory = await mkdtemp(join(tmpdir(), "opengeni-native-broker-"));
    const child = Bun.spawn(
      [
        join(artifactRoot, "build/opengeni-command-supervisor"),
        "broker",
        "--broker-id",
        f.binding.brokerId,
      ],
      {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const watchdog = setTimeout(() => child.kill("SIGTERM"), 50_000);
    watchdog.unref();
    const pages: NativeBrokerOutputPage[] = [];
    let wake = () => {},
      streamError: unknown,
      bytes = 0;
    const reader = (async () => {
      try {
        const input = child.stdout.getReader();
        for (;;) {
          const chunk = await input.read();
          const text = chunk.done ? "" : Buffer.from(chunk.value).toString("ascii");
          bytes += text.length;
          if (bytes > 16 * 1024 * 1024) throw new Error("Native fixture output exceeds bound");
          pages.push({ ...page(f, text, `${pages.length + 1}-0`), eof: chunk.done });
          wake();
          if (chunk.done) break;
        }
      } catch (error) {
        streamError = error;
        wake();
      }
    })();
    const diagnosticChunks: string[] = [];
    let diagnosticReadError: unknown;
    const diagnostics = (async () => {
      try {
        let total = 0;
        for await (const chunk of child.stderr) {
          total += chunk.length;
          if (total > 65536) throw new Error("Native fixture diagnostic bound exceeded");
          diagnosticChunks.push(Buffer.from(chunk).toString("utf8"));
        }
        return diagnosticChunks.join("");
      } catch (error) {
        diagnosticReadError = error;
        throw error;
      }
    })();
    let index = 0,
      uncertain = false,
      dispatchCount = 0;
    const channel: NativeBrokerChannel & NativeBrokerDiagnosticsChannel = {
      sandboxId: f.binding.sandboxId,
      taskId: f.binding.taskId,
      async *diagnostics(cursor) {
        expect(cursor).toBe("0-0");
        if (diagnosticReadError) throw diagnosticReadError;
        if (child.exitCode !== null) throw new Error("Native fixture initial process ended");
        if (diagnosticChunks.length)
          yield {
            sandboxId: f.binding.sandboxId,
            taskId: f.binding.taskId,
            requestedFileDescriptor: 2 as const,
            entryId: "1-0",
            eof: false,
            items: diagnosticChunks.map((data) => ({ fileDescriptor: 2 as const, data })),
          };
      },
      async write(input) {
        dispatchCount++;
        // Model the physically measured Modal high-water input-index contract.
        if (input.index <= index) return;
        // Simulate a genuinely unknown response before physical delivery. The
        // journal cannot know this and must keep the exact indexed bytes.
        if (uncertain) {
          uncertain = false;
          throw new Error("uncertain transport");
        }
        index = input.index;
        child.stdin.write(input.input);
        await child.stdin.flush();
      },
      async *output(cursor, signal) {
        let offset = Number(cursor.split("-")[0]);
        for (;;) {
          signal?.throwIfAborted();
          while (offset >= pages.length) {
            if (streamError) throw streamError;
            await new Promise<void>((resolve, reject) => {
              const aborted = () => {
                wake = () => {};
                reject(signal!.reason);
              };
              wake = () => {
                signal?.removeEventListener("abort", aborted);
                resolve();
              };
              signal?.addEventListener("abort", aborted, { once: true });
            });
          }
          const next = pages[offset++]!;
          yield next;
          if (next.eof) return;
        }
      },
    };
    let writerId = crypto.randomUUID();
    let driver: NativeBrokerDriver;
    let coordinator: NativeBrokerCoordinator | undefined;
    let brokerSession: NativeBrokerCommandSession | undefined;
    const frames = async (after = 0) => (await f.service().framesAfter(after, 128)).frames;
    async function observeUntil(predicate: () => Promise<boolean>) {
      for (let attempt = 0; attempt < 128; attempt++) {
        const sequence = coordinator ? (await f.service().read()).output.lastSequence : 0;
        if (await predicate()) return;
        if (coordinator) await coordinator.observeAfter(sequence, AbortSignal.timeout(5_000));
        else await driver.observe(undefined, 1);
      }
      throw new Error("Native fixture observation bound exceeded");
    }
    async function request(
      kind: Parameters<NativeBrokerDriver["send"]>[0]["kind"],
      commandId: string | null = null,
      payload = new Uint8Array(),
      offset = 0,
      requestId = crypto.randomUUID(),
    ) {
      await (coordinator ?? driver).send({ requestId, commandId, kind, payload, offset });
      await observeUntil(async () => (await f.service().request(requestId))?.accepted === true);
      if (kind === "ack") return null;
      await observeUntil(async () =>
        (await frames()).some(
          (frame) => frame.requestId === requestId && ["status", "error"].includes(frame.kind),
        ),
      );
      const frame = (await frames()).find(
        (candidate) =>
          candidate.requestId === requestId && ["status", "error"].includes(candidate.kind),
      )!;
      expect(frame.kind).toBe("status");
      const body = JSON.parse(Buffer.from(frame.payload).toString());
      expect(body.error).toBeUndefined();
      return body;
    }
    const id = crypto.randomUUID();
    try {
      const registered = await registerQualifiedNativeBrokerBootstrap(
        client.db,
        key,
        bootstrapAdmission(f),
        channel,
      );
      f.binding.bootstrapEvidenceSha256 = registered.binding.bootstrapEvidenceSha256;
      driver = new NativeBrokerDriver(registered.journal, channel, writerId);
      const bootstrap = await readNativeBrokerBootstrap(f.service(), artifactPin);
      expect(bootstrap.transcriptSha256).toBe(f.binding.bootstrapEvidenceSha256);
      expect(bootstrap.commandAdmission).toBe(false);
      await request("fence");
      const definition = encodeNativeBrokerCommandDefinition({
        mode: "pipe",
        cwd: directory,
        argv: ["/bin/sh", "-c", "printf x >> once; exec cat"],
        env: [["PATH", "/usr/bin:/bin"]],
        rows: 0,
        columns: 0,
      });
      const size = Buffer.alloc(4);
      size.writeUInt32BE(definition.length);
      const launchRequestId = crypto.randomUUID();
      const retained = ModalBrokerProviderCommand.parse({
        kind: "modal-broker-v1",
        sandboxId: f.binding.sandboxId,
        taskId: f.binding.taskId,
        execId: id,
        pty: false,
        supervision: {
          protocol: "native-subreaper-broker-channel-v1",
          invocationId: id,
          brokerId: f.binding.brokerId,
          launchRequestId,
          launchEpoch: 1,
        },
        capture: { sequence: bootstrap.lastSequence, receiptAckObserved: false },
        streams: {
          stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
          stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        },
      });
      const custody = await retainNativeFixture(f, retained);
      await request("prepare", id, size);
      await request("definition", id, definition);
      expect(await request("launch", id, new Uint8Array(), 0, launchRequestId)).toEqual({
        state: "supervisor_started",
        released: false,
      });
      uncertain = true;
      const release = {
        requestId: crypto.randomUUID(),
        commandId: id,
        kind: "control" as const,
        offset: 0,
        payload: Buffer.from("release"),
      };
      await expect(driver.send(release)).rejects.toBeInstanceOf(NativeBrokerDispatchUnknownError);
      const before = await f.service().request(release.requestId);
      await database.admin`UPDATE native_command_broker_transports SET writer_until = now() - interval '1 second', revision = revision + 1 WHERE id = ${f.binding.brokerId}`;
      writerId = crypto.randomUUID();
      driver = new NativeBrokerDriver(f.service(), channel, writerId);
      expect(await driver.claimWriter()).toMatchObject({ epoch: 2 });
      const count = dispatchCount;
      expect(await driver.send(release)).toMatchObject({ state: "reconciliation_required" });
      expect(dispatchCount).toBe(count);
      await driver.replayPending();
      await observeUntil(
        async () => (await f.service().request(release.requestId))?.accepted === true,
      );
      expect((await f.service().request(release.requestId))!.frame).toEqual(before!.frame);
      await request("fence");
      expect(await driver.send(release)).toMatchObject({ state: "accepted" });
      const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
      const stdinAdmission = await custody.inputAdmission();
      expect(await driver.sendRetainedStdin(stdinAdmission, binary)).toMatchObject({
        state: "provider_acknowledged",
        offset: 0,
      });
      await observeUntil(
        async () => (await f.service().request(stdinAdmission.admissionId))?.accepted === true,
      );
      await observeUntil(
        async () => (await f.service().requestReply(stdinAdmission.admissionId)) !== null,
      );
      const written = (await f.service().requestReply(stdinAdmission.admissionId))!;
      expect(written).toMatchObject({ kind: "status", offset: binary.length });
      expect(JSON.parse(Buffer.from(written.payload).toString())).toEqual({ stdinWritten: true });
      await database.admin`update sandbox_workspace_mutation_admissions set settled_at=now(), provider_outcome='resolved' where id=${stdinAdmission.admissionId}`;
      await request("eof", id, new Uint8Array(), binary.length);
      let receipt:
        | { protocol: string; invocationId: string; receiptId: string; leaderExitCode: number }
        | undefined;
      // Status control waits in the supervisor until this observation; native
      // process exit may lag cat's stdin closure by a scheduler tick.
      for (let attempt = 0; attempt < 64 && !receipt; attempt++) {
        const result = await request("control", id, Buffer.from("status"));
        receipt = result.receipt;
      }
      expect(receipt).toMatchObject({
        protocol: "native-subreaper-broker-channel-v1",
        invocationId: id,
        leaderExitCode: 0,
      });
      // The receipt is already in committed encrypted frames before any ACK.
      expect(
        (await frames()).some((frame) =>
          Buffer.from(frame.payload).toString().includes(receipt!.receiptId),
        ),
      ).toBe(true);
      const controller = new NativeBrokerRetainedCommand(
        retained,
        custody.persistence,
        f.service(),
        driver,
      );
      const beforeAck = await controller.capture(128);
      expect(beforeAck.exitCode).toBeNull();
      expect(await custody.persistence.loadSupervisionReceipt()).toEqual(receipt!);
      await expect(custody.settle()).rejects.toThrow();
      await controller.acknowledgeReceipt();
      await observeUntil(async () =>
        (await frames()).some((frame) => frame.commandId === id && frame.kind === "exit"),
      );
      const captured = await frames();
      const end = captured.find((frame) => frame.commandId === id && frame.kind === "exit")!;
      expect(JSON.parse(Buffer.from(end.payload).toString())).toEqual({
        supervisorExitCode: 0,
        stdoutEof: true,
        stderrEof: true,
      });
      const output = Buffer.concat(
        captured
          .filter((frame) => frame.commandId === id && frame.kind === "stdout")
          .map((frame) => frame.payload),
      );
      expect(output).toEqual(Buffer.from(binary));
      expect(await readFile(join(directory, "once"), "utf8")).toBe("x");
      const launchFrame = captured.find(
        (frame) => frame.commandId === id && frame.kind === "stdout",
      )!;
      const projection = await projectNativeBrokerCommand(
        f.service(),
        initialNativeBrokerCommandSnapshot(
          {
            brokerId: f.binding.brokerId,
            commandId: id,
            launchRequestId: launchFrame.requestId,
            launchEpoch: launchFrame.ownerEpoch,
            mode: "pipe",
          },
          bootstrap.lastSequence,
        ),
        128,
      );
      expect(projection.exitCode).toBe(0);
      expect(projection.receipts).toEqual([receipt!]);
      expect(projection.snapshot).toMatchObject({
        receiptAckObserved: true,
        supervisorExitCode: 0,
      });
      expect(projection.chunks.map((chunk) => chunk.text).join("")).toBe(
        Buffer.from(binary).toString("utf8"),
      );
      // A fresh object reconstructs only canonical saved state after reconnect.
      const afterAck = await new NativeBrokerRetainedCommand(
        retained,
        custody.persistence,
        f.service(),
        driver,
      ).capture(128);
      expect(afterAck.exitCode).toBe(0);
      expect((await custody.settle()).settled).toBe(true);
      expect((await getRetainedProcess(client.db, custody.scope))?.state).toBe("exited");

      coordinator = new NativeBrokerCoordinator(f.service(), channel, writerId);
      const sessionOptions = {
        journal: f.service(),
        coordinator,
        root: directory,
        environment: () => ({ PATH: "/usr/bin:/bin" }),
        identity: {
          sandboxId: f.binding.sandboxId,
          taskId: f.binding.taskId,
          brokerId: f.binding.brokerId,
        },
        // The isolated fixture seeds canonical qualification above. No caller
        // should infer production admission from this test-only callback.
        verify: async () => ({ sandboxId: f.binding.sandboxId, taskId: f.binding.taskId }),
      };
      brokerSession = new NativeBrokerCommandSession(sessionOptions);
      // A partially prepared command has no supervisor and therefore cannot
      // produce a quiescence receipt or exit code. The actual native cancel
      // response must close its birth and settle only its pristine reservation.
      const partialId = crypto.randomUUID();
      const partialWriter = await coordinator.claimWriter();
      const partialState = await f.service().read();
      const partial = ModalBrokerProviderCommand.parse({
        ...retained,
        execId: partialId,
        supervision: {
          ...retained.supervision,
          invocationId: partialId,
          launchRequestId: crypto.randomUUID(),
          launchEpoch: partialWriter.epoch,
        },
        capture: { sequence: partialState.output.lastSequence, receiptAckObserved: false },
        streams: {
          stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
          stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        },
      });
      const partialCustody = await retainNativeFixture(f, partial, 4);
      const prepareId = crypto.randomUUID();
      const partialDefinitionSize = Buffer.alloc(4);
      partialDefinitionSize.writeUInt32BE(20);
      await coordinator.send({
        requestId: prepareId,
        commandId: partialId,
        kind: "prepare",
        offset: 0,
        payload: partialDefinitionSize,
      });
      expect((await coordinator.reply(prepareId)).kind).toBe("status");
      const partialControl = new NativeBrokerRetainedCommand(
        partial,
        partialCustody.persistence,
        f.service(),
        coordinator,
      );
      await partialControl.cancel("explicit_stop");
      await observeUntil(async () =>
        (await frames(partial.capture.sequence)).some(
          (frame) =>
            frame.commandId === partialId &&
            frame.kind === "status" &&
            Buffer.from(frame.payload).toString() === '{"state":"not_started","launchClosed":true}',
        ),
      );
      expect((await partialControl.status()).state).toBe("never_started");
      expect((await getRetainedProcess(client.db, partialCustody.scope))!).toMatchObject({
        state: "lost",
        exitCode: null,
        settlementReason: "provider_start_rejected",
      });
      expect(await partialCustody.persistence.loadSupervisionReceipt()).toBeNull();
      expect(await partialCustody.persistence.load()).toEqual(partial);
      const lateLaunch = partial.supervision.launchRequestId;
      await coordinator.send({
        requestId: lateLaunch,
        commandId: partialId,
        kind: "launch",
        offset: 0,
        payload: new Uint8Array(),
      });
      const denied = await coordinator.reply(lateLaunch);
      expect(denied.kind).toBe("error");
      expect(Buffer.from(denied.payload).toString()).toBe('{"error":"invalid_launch"}');
      expect(
        (await frames(partial.capture.sequence)).some(
          (frame) =>
            frame.commandId === partialId && ["stdout", "stderr", "exit"].includes(frame.kind),
        ),
      ).toBe(false);
      const startRetained = async (cmd: string, handle: number) => {
        let commandCustody!: Awaited<ReturnType<typeof retainNativeFixture>>;
        const started = await withProviderCommandHandle(handle, () =>
          withCommandSupervisionReady(
            true,
            () =>
              withSupervisedLaunchReservation(
                {
                  reserve: async (reservedCommand) => {
                    commandCustody = await retainNativeFixture(
                      f,
                      ModalBrokerProviderCommand.parse(reservedCommand),
                      handle,
                    );
                    brokerSession!.bindProviderCommand(
                      handle,
                      reservedCommand,
                      commandCustody.persistence,
                    );
                  },
                },
                () => brokerSession!.execCommand({ cmd }),
              ),
            "native-subreaper-broker-channel-v1",
          ),
        );
        const command = brokerSession!.getProviderCommand(handle)!;
        expect(brokerSession!.getProviderCommandOutput(started)).toMatchObject({
          exitCode: null,
          chunks: [],
        });
        expect(await brokerSession!.captureCommandOutput(started)).toBe(true);
        return { command, custody: commandCustody };
      };

      // More than the actual 4 MiB native output window. Every provider ACK
      // follows durable journal capture; complete output is independently
      // hashed before canonical receipt/exit settlement.
      const bulkBytes = 6 * 1024 * 1024;
      const bulk = await startRetained(`yes x | head -c ${bulkBytes}`, 2);
      await brokerSession.releaseSupervisedCommand(2);
      await observeUntil(async () =>
        (await frames(bulk.command.capture.sequence)).some(
          (frame) => frame.commandId === bulk.command.execId && frame.kind === "stdout",
        ),
      );
      uncertain = true; // Lose only the first global output ACK, after capture.
      let collected = 0,
        bulkExit: number | null = null,
        presentations = 0;
      const bulkHash = createHash("sha256");
      for (let attempt = 0; attempt < 512; attempt++) {
        const result = await brokerSession.writeStdin({
          sessionId: 2,
          yieldTimeMs: 250,
          maxOutputTokens: 100,
        });
        const view = brokerSession.getProviderCommandOutput(result)!;
        expect(view).not.toBeNull();
        expect(await bulk.custody.persistence.load()).toEqual(view.command);
        expect(await brokerSession.captureCommandOutput(result)).toBe(true);
        let progress = false;
        for (const chunk of view.chunks) {
          expect(chunk.stream).toBe("stdout");
          bulkHash.update(chunk.text);
          collected += Buffer.byteLength(chunk.text);
          progress ||= chunk.text.length > 0;
        }
        if (progress) {
          presentations++;
        }
        if (attempt === 0) {
          const pending = (await f.service().read()).input.pending;
          expect(pending?.phase).toBe("dispatch_intent");
          const decoder = new NativeBrokerFrameDecoder(f.binding.brokerId);
          expect(decoder.push(Buffer.from(pending!.frameBase64, "base64"))[0]!.kind).toBe("ack");
          decoder.finish();
          const sequence = (await f.service().read()).output.lastSequence;
          await driver.replayPending(); // Explicit original-index recovery only.
          await coordinator.observeAfter(sequence, AbortSignal.timeout(5_000));
        }
        bulkExit = view.exitCode;
        if (bulkExit !== null) break;
      }
      expect(bulkExit).toBe(0);
      expect(collected).toBe(bulkBytes);
      expect(bulkHash.digest("hex")).toBe(
        createHash("sha256")
          .update("x\n".repeat(bulkBytes / 2))
          .digest("hex"),
      );
      expect(presentations).toBeGreaterThan(1);
      expect((await bulk.custody.settle()).settled).toBe(true);

      // A third real command exercises controller-owned release, durable
      // cancellation, repeated status and receipt ACK through a fresh object.
      // This local seeded fixture is not the remote 2s/35s release canary.
      const { command: cancelLocator, custody: cancellationCustody } = await startRetained(
        "trap '' TERM; printf ready; while :; do sleep 1; done",
        3,
      );
      const cancelId = cancelLocator.execId;
      expect(cancelLocator.supervision.launchEpoch).toBe(2);
      expect(await cancellationCustody.persistence.load()).toEqual(cancelLocator);
      expect(
        (await frames(cancelLocator.capture.sequence)).some(
          (frame) => frame.commandId === cancelId && frame.kind === "stdout",
        ),
      ).toBe(false);
      await brokerSession.releaseSupervisedCommand(3);
      await observeUntil(async () =>
        (await frames(cancelLocator.capture.sequence)).some(
          (frame) => frame.commandId === cancelId && frame.kind === "stdout",
        ),
      );
      // Inject a definite host-observed fault after release. The real static
      // broker must still accept cancellation and the receipt ACK; the fault
      // is not itself an exit receipt and must not cause early settlement.
      await f.service().recordDiagnosticFault(diagnosticFault(f));
      await expect(cancellationCustody.settle()).rejects.toThrow();
      await brokerSession.cancelSupervisedCommand(3, "explicit_stop");
      expect(await cancellationCustody.persistence.cancellationRequested()).toBe(true);
      await observeUntil(async () => !(await f.service().read()).input.pending);
      let cancelledExit: number | null = null;
      await brokerSession.close();
      // New host object adopts only the exact canonical retained command.
      brokerSession = new NativeBrokerCommandSession(sessionOptions);
      brokerSession.bindProviderCommand(
        3,
        ModalBrokerProviderCommand.parse(await cancellationCustody.persistence.load()),
        cancellationCustody.persistence,
      );
      for (let attempt = 0; attempt < 64; attempt++) {
        await observeUntil(async () => !(await f.service().read()).input.pending);
        const result = await brokerSession.writeStdin({ sessionId: 3, yieldTimeMs: 250 });
        const view = brokerSession.getProviderCommandOutput(result)!;
        expect(await brokerSession.captureCommandOutput(result)).toBe(true);
        cancelledExit = view.exitCode;
        if (cancelledExit !== null) break;
      }
      expect(cancelledExit).toBe(137);
      expect((await cancellationCustody.settle(137)).settled).toBe(true);
    } finally {
      await brokerSession?.close();
      await coordinator?.close();
      child.stdin.end();
      const stopped = await Promise.race([
        child.exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (stopped === null) {
        child.kill("SIGTERM");
        await child.exited;
      }
      try {
        await reader;
        expect(await diagnostics).toBe("");
      } finally {
        await rm(directory, { recursive: true });
        clearTimeout(watchdog);
      }
    }
    expect(await child.exited).toBe(125);
  },
  60_000,
);
