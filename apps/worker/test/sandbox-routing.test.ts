// M7 — the WORKER turn-path routing wiring (wrapTurnBoxWithRouting), driven
// against the REAL packages/db on a THROWAWAY postgres + an in-memory
// MemoryEventBus agent responder (the selfhosted control plane stand-in). This is
// the worker companion to packages/runtime/test/routing-proxy.test.ts (the pure
// proxy) and apps/api/test/fleet-tools.test.ts (the fleet service): it proves the
// proxy the worker injects NON-OWNED into the turn re-reads the DB pointer per op
// and dispatches to the currently-active backend after a real setActiveSandbox.
//
// Proves:
//   - default pointer (null): the proxy routes to the established GROUP box.
//   - after setActiveSandbox (swap to the enrolled machine): the NEXT op routes to
//     the MACHINE (the in-memory agent answers it) — the SDK-binds-once contract.
//   - swap back to the group box routes there again (heterogeneous, single-active).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
  MemoryEventBus,
} from "@opengeni/testing";
import { ControlRequest, ControlResponse } from "@opengeni/agent-proto";
import type { OpStreamConnection } from "@opengeni/events";
import {
  createEnrollment,
  createSandbox,
  createSession,
  createDb,
  acquireLease,
  claimEnrollmentConnection,
  claimSessionWorkForAttempt,
  claimWorkspaceArchiveCapture,
  commitWarmingToWarm,
  getSandbox,
  getRetainedProcess,
  initializeSessionStartAtomically,
  markWarmLeaseInstanceLost,
  readLease,
  readActiveSandbox,
  readWorkspaceArchiveCapturePreflight,
  reapStaleLeaseHolders,
  releaseLeaseHolder,
  requestDueSandboxRotationsGlobal,
  retainedProcessSettlementIdentity,
  setActiveSandbox,
  setEnrollmentOpStreamState,
  settleRetainedProcess,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  buildAgentCapabilities,
  buildManifest,
  createMockSelfhostedOpStream,
  MockAgentResponder,
  RoutingBackendRecoveryRequiredError,
  RoutingSandboxSession,
  subjectFor,
  type EstablishedSandboxSession,
  type InMemoryOpStreamTransport,
  type OpStreamJournal,
} from "@opengeni/runtime";
import { swapActiveSandbox, type FleetContext } from "@opengeni/core";
import {
  establishSelfhostedTurnSession,
  wrapLazyTurnBoxWithRouting,
  wrapTurnBoxWithRouting,
  routingEnabled,
} from "../src/sandbox-routing";
import { sandboxLeaseHolderIdForAttempt } from "../src/sandbox-resume";
import { reconcileActiveSandboxPointer } from "../src/activities/agent-turn";
import { ModalCommandControl } from "../../../packages/runtime/src/sandbox/providers/modal-command-control";
import { installModalCommandSession } from "../../../packages/runtime/src/sandbox/providers/modal-command-session";
import {
  ModalCommandRouterWire,
  modalRouterWire,
  type ModalRouterIdentity,
  type ModalRouterStart,
} from "../../../packages/runtime/src/sandbox/providers/modal-command-router-wire";
import type { ChannelASession } from "../../../packages/runtime/src/sandbox/channel-a";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

const settings = testSettings({
  productAccessMode: "managed",
  sandboxSelfhostedEnabled: true,
  agentOpStreamEnabled: true,
  sandboxSelfhostedExecTimeoutMs: 30_000,
  selfhostedRelayUrl: "wss://relay.example",
});
const testOpJournal: OpStreamJournal = {
  attachGeneration: () => "1",
  persistSettled: async () => undefined,
};

/** A MemoryEventBus whose request/reply responder handles bounded control ops
 *  while exec runs through the resumable op-stream protocol. */
function busWithAgent(
  workspaceId: string,
  agentId: string,
  connectionInstanceId: string,
  hostname: string,
  onRequest?: () => void,
): MemoryEventBus {
  const bus = new MemoryEventBus();
  const responder = new MockAgentResponder({ hostname });
  const stream = createMockSelfhostedOpStream({
    responder,
    workspaceId,
    agentId,
    connectionInstanceId,
  });
  bus.subscribeRequests(
    subjectFor(workspaceId, agentId, connectionInstanceId),
    async (payload, subject) => {
      const req = ControlRequest.decode(payload);
      if (req.op?.$case === "opStart") onRequest?.();
      const res = await stream.controlRpc.request(subject, req, {
        timeoutMs: 0,
      });
      return ControlResponse.encode(res).finish();
    },
  );
  const opStreamConnection = opStreamConnectionFor(stream.transport);
  (
    bus as MemoryEventBus & { getOpStreamConnection: () => OpStreamConnection }
  ).getOpStreamConnection = () => opStreamConnection;
  return bus;
}

function opStreamConnectionFor(transport: InMemoryOpStreamTransport): OpStreamConnection {
  return {
    subscribe(subject) {
      const values: Array<{ data: Uint8Array }> = [];
      const readers: Array<(result: IteratorResult<{ data: Uint8Array }>) => void> = [];
      let done = false;
      let release: (() => void) | undefined;
      void transport
        .subscribe(subject, (data) => {
          const message = { data };
          const reader = readers.shift();
          if (reader) reader({ done: false, value: message });
          else values.push(message);
        })
        .then((subscription) => {
          if (done) subscription.unsubscribe();
          else release = subscription.unsubscribe;
        })
        .catch(() => {
          done = true;
          for (const reader of readers.splice(0)) {
            reader({ done: true, value: undefined });
          }
        });
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              const value = values.shift();
              if (value) return Promise.resolve({ done: false as const, value });
              if (done)
                return Promise.resolve({
                  done: true as const,
                  value: undefined,
                });
              return new Promise<IteratorResult<{ data: Uint8Array }>>((resolve) =>
                readers.push(resolve),
              );
            },
          };
        },
        unsubscribe() {
          if (done) return;
          done = true;
          release?.();
          for (const reader of readers.splice(0)) {
            reader({ done: true, value: undefined });
          }
        },
      };
    },
    publish(subject, payload) {
      void transport.publish(subject, payload);
    },
    async flush() {},
  };
}

async function claimTestConnection(input: {
  accountId: string;
  workspaceId: string;
  enrollmentId: string;
  credentialGeneration: number;
}): Promise<string> {
  const connectionInstanceId = crypto.randomUUID();
  const claimed = await claimEnrollmentConnection(db, {
    ...input,
    connectionInstanceId,
    leaseMs: 60_000,
  });
  expect(claimed.claimed).toBe(true);
  expect(
    (
      await setEnrollmentOpStreamState(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        enrollmentId: input.enrollmentId,
        opStream: true,
        connectionInstanceId,
      })
    ).updated,
  ).toBe(true);
  await admin`
    update enrollments
    set workspace_root = '/home/user/project'
    where id = ${input.enrollmentId}
  `;
  return connectionInstanceId;
}

/** A fake established GROUP box whose exec returns a fixed marker — the default
 *  routing target (active_sandbox_id == null). */
function fakeGroupBox(marker: string): EstablishedSandboxSession {
  const session = {
    state: { instanceId: "group-box" },
    modal: {
      cpClient: {
        workspaceNameLookup: async () => ({
          workspaceName: "routing-test",
          username: "routing-test",
        }),
      },
      profile: { serverUrl: "https://modal.test" },
      environmentName: (environment?: string) => environment ?? "",
    },
    async exec(_args: unknown) {
      return { stdout: marker, exitCode: 0 };
    },
  };
  return {
    client: {},
    session,
    sessionState: {},
    instanceId: "group-box",
    backendId: "modal",
  };
}

/** The native Start really reaches a TLS router before its acknowledgement
 * fails. DNS-shaped server text cannot prove non-dispatch or permit replay. */
async function ambiguousModalGroupBox() {
  // Exercise the runtime's pinned native transport without adding a worker
  // dependency solely for this fixture (Bun uses isolated package links).
  const { Server, ServerCredentials, status } = createRequire(
    import.meta.resolve("@opengeni/runtime"),
  )("@grpc/grpc-js");
  type Call<T> = { request: T; metadata: { get(name: string): unknown[] } };
  type Reply = (error: { code: number; details: string } | null, response?: object) => void;
  const directory = mkdtempSync(join(tmpdir(), "opengeni-worker-modal-start-"));
  const keyPath = join(directory, "server.key");
  const certPath = join(directory, "server.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  if (generated.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error("Test TLS certificate generation failed");
  }
  const certificate = readFileSync(certPath);
  const server = new Server();
  const starts: ModalRouterStart[] = [];
  const observations: ModalRouterIdentity[] = [];
  let exitCode: number | null = null;
  const method = (name: string, input: string, output: string, streaming = false) => ({
    path: `/modal.task_command_router.TaskCommandRouter/${name}`,
    requestStream: false,
    responseStream: streaming,
    requestSerialize: (value: object) =>
      Buffer.from(modalRouterWire.lookupType(input).encode(value).finish()),
    requestDeserialize: (bytes: Buffer) => modalRouterWire.lookupType(input).decode(bytes),
    responseSerialize: (value: object) =>
      Buffer.from(modalRouterWire.lookupType(output).encode(value).finish()),
    responseDeserialize: (bytes: Buffer) => modalRouterWire.lookupType(output).decode(bytes),
  });
  server.addService(
    {
      start: method("TaskExecStart", "Start", "Empty"),
      read: method("TaskExecStdioRead", "Read", "Data", true),
      poll: method("TaskExecPoll", "Identity", "Poll"),
    },
    {
      start(call: Call<ModalRouterStart>, callback: Reply) {
        expect(call.metadata.get("authorization")).toEqual(["Bearer test-token"]);
        starts.push(call.request);
        callback({
          code: status.UNAVAILABLE,
          details: "Name resolution failed for target dns:task-worker.w.modal.host:443",
        });
      },
      read(call: Call<ModalRouterIdentity> & { end(): void }) {
        observations.push(call.request);
        call.end();
      },
      poll(call: Call<ModalRouterIdentity>, callback: Reply) {
        observations.push(call.request);
        callback(null, exitCode === null ? {} : { code: exitCode });
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      ServerCredentials.createSsl(null, [
        {
          private_key: readFileSync(keyPath),
          cert_chain: certificate,
        },
      ]),
      (error: Error | null, boundPort: number) => (error ? reject(error) : resolve(boundPort)),
    ),
  );
  const router = new ModalCommandRouterWire(
    {
      url: `https://localhost:${port}`,
      jwt: "test-token",
    },
    certificate,
  );
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: { sandboxGetTaskId: async () => ({ taskId: "task-worker" }) },
    } as never,
    "sb-worker-unknown-start",
    "/workspace",
  );
  // Only replace access discovery/self-signed trust. Request construction,
  // native gRPC Start, adapter retention and database callbacks are production.
  Object.defineProperty(control, "withRouter", {
    value: async (
      taskId: string,
      _signal: AbortSignal | undefined,
      run: (wire: ModalCommandRouterWire) => Promise<unknown>,
    ) => {
      expect(taskId).toBe("task-worker");
      return await run(router);
    },
  });
  const session: ChannelASession = Object.assign(fakeGroupBox("").session, {
    state: { instanceId: "sb-worker-unknown-start", workspaceRootPath: "/workspace" },
  });
  installModalCommandSession(session, control);
  return {
    starts,
    observations,
    complete: () => {
      exitCode = 7;
    },
    established: {
      ...fakeGroupBox(""),
      instanceId: "sb-worker-unknown-start",
      session,
    },
    async close() {
      router.close();
      await control.close();
      server.forceShutdown();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function claimRoutingAttempt(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
}): Promise<{
  accountId: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
}> {
  await initializeSessionStartAtomically(db, {
    ...input,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, input.workspaceId, {
    sessionId: input.sessionId,
    workflowId: `session-${input.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `routing-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") {
    throw new Error(`Routing fixture did not claim its turn: ${claim.reason}`);
  }
  return {
    accountId: input.accountId,
    turnId: claim.turn.id,
    executionGeneration: claim.turn.executionGeneration,
    attemptId,
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-sandbox-routing");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[worker-sandbox-routing] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

describe("M7 worker routing — wrapTurnBoxWithRouting + a real DB pointer + setActiveSandbox", () => {
  test.each(["exited", "lost"] as const)(
    "ambiguous native Modal Start is retained and fenced until exact %s proof",
    async (terminal) => {
      if (!available) throw new Error("PostgreSQL required for unknown-Start regression");
      const fixture = await ambiguousModalGroupBox();
      try {
        const [account] = await admin<{ id: string }[]>`
          insert into managed_accounts (name) values ('modal-start-unknown') returning id`;
        const accountId = account!.id;
        const [workspace] = await admin<{ id: string }[]>`
          insert into workspaces (account_id, name)
          values (${accountId}, 'modal-start-unknown') returning id`;
        const workspaceId = workspace!.id;
        await admin`insert into workspace_inference_controls (workspace_id, account_id)
          values (${workspaceId}, ${accountId})`;
        const session = await createSession(db, {
          accountId,
          workspaceId,
          initialMessage: "Start once",
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "modal",
        });
        const workspaceMutationFence = await claimRoutingAttempt({
          accountId,
          workspaceId,
          sessionId: session.id,
        });
        const holderId = sandboxLeaseHolderIdForAttempt(workspaceMutationFence.attemptId);
        const acquired = await acquireLease(db, {
          accountId,
          workspaceId,
          sandboxGroupId: session.sandboxGroupId,
          kind: "turn",
          holderId,
          subjectId: session.id,
          backend: "modal",
          leaseTtlMs: 45_000,
        });
        const instanceId = fixture.established.instanceId;
        const committed = await commitWarmingToWarm(db, {
          accountId,
          workspaceId,
          sandboxGroupId: session.sandboxGroupId,
          expectedEpoch: acquired.lease.leaseEpoch,
          instanceId,
          resumeBackendId: "modal",
          resumeState: {
            backendId: "modal",
            sessionState: { providerState: { sandboxId: instanceId } },
          },
          leaseTtlMs: 45_000,
        });
        expect(committed.committed).toBe(true);
        const leaseEpoch = committed.lease!.leaseEpoch;
        const proxy = wrapTurnBoxWithRouting(
          {
            db,
            settings: { ...settings, modalCommandSupervisionEnabled: false },
            bus: new MemoryEventBus() as never,
            opJournal: testOpJournal,
          },
          {
            workspaceId,
            sessionId: session.id,
            workspaceMutationFence,
            homeLease: {
              accountId,
              sandboxGroupId: session.sandboxGroupId,
              leaseEpoch,
              instanceId,
              backend: "modal",
            },
          },
          fixture.established,
        ).session as RoutingSandboxSession;
        // Production composition preserves typed uncertainty through the SDK
        // error function so the outer turn fence can retain and render it.
        const shellCapability = buildAgentCapabilities(settings, [], {
          onToolCancellationFence: () => undefined,
        }).find((capability) => capability.type === "shell")!;
        const exec = shellCapability
          .clone()
          .bind(proxy as never)
          .tools()
          .find(
            (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
              tool.type === "function" && tool.name === "exec_command",
          )!;
        const output = await exec.invoke(
          {} as never,
          JSON.stringify({
            cmd: "touch /workspace/once",
            tty: terminal === "exited",
            yield_time_ms: 0,
          }),
        );
        expect(fixture.starts).toHaveLength(1);
        const [admission] = await admin`
          select * from sandbox_workspace_mutation_admissions
          where workspace_id = ${workspaceId} and session_id = ${session.id}`;
        expect(admission).toMatchObject({ provider_outcome: "retained", settled_at: null });
        const [row] = await admin`
          select id, provider_command from sandbox_retained_processes
          where workspace_id = ${workspaceId} and session_id = ${session.id}`;
        const scope = { accountId, workspaceId, sessionId: session.id, processId: row!.id };
        const retained = await getRetainedProcess(db, scope);
        expect(retained).toMatchObject({
          state: "active",
          settledAt: null,
          parentAdmissionId: admission!.id,
          leaseEpoch,
          providerBackend: "modal",
          providerInstanceId: instanceId,
        });
        expect(row!.provider_command).toMatchObject({
          kind: "modal-router-v1",
          sandboxId: instanceId,
          taskId: fixture.starts[0]!.taskId,
          execId: fixture.starts[0]!.execId,
        });
        expect(Boolean(row!.provider_command.pty)).toBe(terminal === "exited");
        expect(row!.provider_command.streams).toEqual({
          stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
          stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        });
        const captureScope = {
          accountId,
          workspaceId,
          sandboxGroupId: session.sandboxGroupId,
          expectedEpoch: leaseEpoch,
          expectedInstanceId: instanceId,
        };
        expect(
          await readWorkspaceArchiveCapturePreflight(db, {
            ...captureScope,
            liveness: "warm",
          }),
        ).toBeNull();
        expect(
          await claimWorkspaceArchiveCapture(db, {
            ...captureScope,
            liveness: "warm",
            captureId: crypto.randomUUID(),
            captureTimeoutMs: 60_000,
            minIntervalMs: 0,
            warmAttempt: {
              sessionId: session.id,
              turnId: workspaceMutationFence.turnId,
              attemptId: workspaceMutationFence.attemptId,
              holderId,
            },
          }),
        ).toMatchObject({ status: "holder_in_progress" });

        // Releasing/aging the turn owner cannot settle the promoted admission,
        // expire its process holder, or let rotation drain/capture the instance.
        await admin`update sandbox_leases set
          provider_created_at = now() - interval '23 hours',
          provider_deadline_at = now() + interval '1 minute'
          where id = ${retained!.leaseId}`;
        expect(await requestDueSandboxRotationsGlobal(db, 60 * 60_000, 500)).toBeGreaterThan(0);
        expect(
          await releaseLeaseHolder(db, {
            accountId,
            workspaceId,
            sandboxGroupId: session.sandboxGroupId,
            kind: "turn",
            holderId,
            idleGraceMs: 0,
            workspaceWritersQuiesced: true,
          }),
        ).toMatchObject({ liveness: "warm", refcount: 1 });
        await admin`update sandbox_lease_holders set last_heartbeat_at = now() - interval '1 day'
          where lease_id = ${retained!.leaseId}`;
        const swept = await reapStaleLeaseHolders(db, {
          workspaceId,
          viewerHolderTtlMs: 1,
          turnHolderTtlMs: 1,
          idleGraceMs: 0,
        });
        expect(swept.drained).toHaveLength(0);
        expect(await readLease(db, workspaceId, session.sandboxGroupId)).toMatchObject({
          liveness: "warm",
          refcount: 1,
          workspaceGeneration: 1,
          archiveCapture: null,
          rotationReason: "provider_deadline",
        });
        const [stillOpen] = await admin`
          select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
          where id = ${admission!.id}`;
        expect(stillOpen).toMatchObject({ provider_outcome: "retained", settled_at: null });
        await expect(
          settleRetainedProcess(db, {
            ...scope,
            expected: {
              ...retainedProcessSettlementIdentity(retained!),
              providerSessionId: retained!.providerSessionId + 1,
            },
            outcome: "exited",
            exitCode: 7,
            reason: "provider_exit_banner",
            idleGraceMs: 0,
          }),
        ).rejects.toThrow("copied durable identity");
        const observed = await proxy.writeStdinForProcessRead({
          sessionId: retained!.providerSessionId,
          chars: "",
          yieldTimeMs: 250,
        });
        expect(observed).toContain(
          `Process running with session ID ${retained!.providerSessionId}`,
        );
        expect((await getRetainedProcess(db, scope))!.state).toBe("active");
        expect(
          await readWorkspaceArchiveCapturePreflight(db, {
            ...captureScope,
            liveness: "warm",
          }),
        ).toBeNull();

        if (terminal === "exited") {
          fixture.complete();
          expect(
            await proxy.writeStdinForProcessRead({
              sessionId: retained!.providerSessionId,
              chars: "",
              yieldTimeMs: 250,
            }),
          ).toContain("Process exited with code 7");
          expect(
            await claimWorkspaceArchiveCapture(db, {
              ...captureScope,
              liveness: "draining",
              captureId: crypto.randomUUID(),
              captureTimeoutMs: 60_000,
              minIntervalMs: 0,
            }),
          ).toMatchObject({ status: "claimed" });
        } else {
          expect(
            await markWarmLeaseInstanceLost(db, {
              ...captureScope,
              expectedBackend: "modal",
              expectedInstanceId: "sb-unrelated",
              diagnostic: "provider_instance_not_found",
            }),
          ).toMatchObject({ status: "stale" });
          expect((await getRetainedProcess(db, scope))!.state).toBe("active");
          expect(
            await markWarmLeaseInstanceLost(db, {
              ...captureScope,
              expectedBackend: "modal",
              diagnostic: "provider_instance_not_found",
            }),
          ).toMatchObject({ status: "marked" });
          expect((await readLease(db, workspaceId, session.sandboxGroupId))!.leaseEpoch).toBe(
            leaseEpoch + 1,
          );
        }
        expect(await getRetainedProcess(db, scope)).toMatchObject({
          state: terminal,
          exitCode: terminal === "exited" ? 7 : null,
        });
        const [settled] = await admin`
          select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
          where id = ${admission!.id}`;
        expect(settled!.provider_outcome).toBe(terminal === "exited" ? "resolved" : "rejected");
        expect(settled!.settled_at).not.toBeNull();
        const [holders] = await admin`
          select count(*)::integer as count from sandbox_lease_holders
          where lease_id = ${retained!.leaseId} and kind = 'process'`;
        expect(holders!.count).toBe(0);
        expect(fixture.observations.length).toBeGreaterThan(0);
        for (const observation of fixture.observations) {
          expect(observation.taskId).toBe(fixture.starts[0]!.taskId);
          expect(observation.execId).toBe(fixture.starts[0]!.execId);
        }
        expect(fixture.starts).toHaveLength(1);
        expect(output).toContain("outcome unknown");
        expect(output).toContain("not replayed");
        expect(output).toContain(String(retained!.providerSessionId));
        expect(output).not.toContain("Please try again");
        expect(output).not.toContain("Process running");
        expect(output).not.toContain("Process exited");
      } finally {
        await fixture.close();
      }
    },
    60_000,
  );

  test("a local SDK process settles against its canonical durable backend", async () => {
    if (!available) throw new Error("PostgreSQL required for retained-process regression");
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('local-process-test') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'local-process-test') returning id`;
    const accountId = account!.id;
    const workspaceId = workspace!.id;
    await admin`insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspaceId}, ${accountId})`;
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "scripted process",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "local",
    });
    const workspaceMutationFence = await claimRoutingAttempt({
      accountId,
      workspaceId,
      sessionId: session.id,
    });
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      kind: "turn",
      holderId: sandboxLeaseHolderIdForAttempt(workspaceMutationFence.attemptId),
      subjectId: session.id,
      backend: "local",
      leaseTtlMs: 45_000,
    });
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "local-process-box",
      resumeBackendId: "unix_local",
      resumeState: { backendId: "unix_local", sessionState: { instanceId: "local-process-box" } },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);
    let executions = 0;
    const established = wrapTurnBoxWithRouting(
      { db, settings, bus: new MemoryEventBus() as never, opJournal: testOpJournal },
      {
        workspaceId,
        sessionId: session.id,
        workspaceMutationFence,
        homeLease: {
          accountId,
          sandboxGroupId: session.sandboxGroupId,
          leaseEpoch: committed.lease!.leaseEpoch,
          instanceId: "local-process-box",
          backend: "local",
        },
      },
      {
        client: {},
        backendId: "unix_local",
        instanceId: "local-process-box",
        sessionState: {},
        session: {
          state: { instanceId: "local-process-box" },
          async exec() {
            executions += 1;
            return { sessionId: 17, stdout: "working" };
          },
          async writeStdin() {
            return "Process exited with code 0\nOutput:\ndone";
          },
        },
      },
    );
    const proxy = established.session as {
      exec: (args: unknown) => Promise<unknown>;
      writeStdin: (args: unknown) => Promise<string>;
    };
    await proxy.exec({ cmd: "scripted" });
    expect(await proxy.writeStdin({ session_id: 17, chars: "" })).toContain(
      "Process exited with code 0",
    );
    const [process] = await admin`select state, exit_code from sandbox_retained_processes
      where workspace_id = ${workspaceId} and session_id = ${session.id}`;
    expect(process).toMatchObject({ state: "exited", exit_code: 0 });
    expect(executions).toBe(1);
  }, 60_000);

  test("the proxy routes to the GROUP box by default, then to the MACHINE after a swap, then back", async () => {
    if (!available) return;
    expect(routingEnabled(settings)).toBe(true);

    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values ('acct') returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
    const accountId = a!.id;
    const workspaceId = w!.id;

    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
    });
    const workspaceMutationFence = await claimRoutingAttempt({
      accountId,
      workspaceId,
      sessionId: session.id,
    });
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:${crypto.randomUUID()}`,
      exposure: "whole-machine",
      hasDisplay: true,
      allowScreenControl: true,
      os: "linux",
      arch: "x86_64",
    });
    const sandbox = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "laptop",
      enrollmentId: enrollment.id,
    });
    const connectionInstanceId = await claimTestConnection({
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      credentialGeneration: enrollment.credentialGeneration,
    });

    // Seed the durable warm home so a same-target route epoch change exercises
    // the worker's lease-backed home resolver instead of the static fallback.
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      kind: "turn",
      holderId: sandboxLeaseHolderIdForAttempt(workspaceMutationFence.attemptId),
      subjectId: session.id,
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "group-box",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "group-box" } },
      },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);

    const bus = busWithAgent(
      workspaceId,
      enrollment.id,
      connectionInstanceId,
      "the-laptop",
    ) as never;

    // Wrap the established group box in the routing proxy (what the turn does).
    const established = wrapTurnBoxWithRouting(
      { db, settings, bus, opJournal: testOpJournal },
      {
        workspaceId,
        sessionId: session.id,
        workspaceMutationFence,
        homeLease: {
          accountId,
          sandboxGroupId: session.sandboxGroupId,
          leaseEpoch: committed.lease!.leaseEpoch,
          instanceId: "group-box",
          backend: "modal",
        },
      },
      fakeGroupBox("group-box-marker"),
    );
    const proxy = established.session as {
      exec: (a: unknown) => Promise<{ stdout: string }>;
    };

    // Default pointer (null) → the op lands on the GROUP box.
    expect((await proxy.exec({ cmd: "uname" })).stdout).toBe("group-box-marker");
    expect(await readLease(db, workspaceId, session.sandboxGroupId)).toMatchObject({
      workspaceGeneration: 1,
      archiveGeneration: null,
      archiveComplete: false,
    });

    // SWAP mid-turn: repoint the session to the enrolled machine (epoch-bumped CAS).
    const swap = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: sandbox.id,
      expectedEpoch: 0,
    });
    expect(swap.swapped).toBe(true);

    // The NEXT op re-reads the pointer and lands on the MACHINE (the agent echoes
    // its hostname) — the SDK-binds-the-proxy-once contract: same object, new box.
    expect((await proxy.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("the-laptop");
    expect(await readLease(db, workspaceId, session.sandboxGroupId)).toMatchObject({
      workspaceGeneration: 1,
      archiveGeneration: null,
      archiveComplete: false,
    });

    // Swap BACK to the group box (target null) → the op routes there again.
    const back = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: null,
      expectedEpoch: swap.pointer!.activeEpoch,
    });
    expect(back.swapped).toBe(true);
    expect((await proxy.exec({ cmd: "uname" })).stdout).toBe("group-box-marker");
    expect(await readLease(db, workspaceId, session.sandboxGroupId)).toMatchObject({
      workspaceGeneration: 2,
      archiveGeneration: null,
      archiveComplete: false,
    });
  }, 60_000);

  test("organization-scoped cross-workspace primary routes its first operation through the origin", async () => {
    if (!available) return;
    const subjectId = `human:${crypto.randomUUID()}`;
    const [account] = await admin<Array<{ id: string }>>`
      insert into managed_accounts (name) values (${`org-primary-${crypto.randomUUID()}`})
      returning id
    `;
    const [originWorkspace] = await admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'organization machine origin') returning id
    `;
    const [targetWorkspace] = await admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'organization machine target') returning id
    `;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id) values
        (${originWorkspace!.id}, ${account!.id}),
        (${targetWorkspace!.id}, ${account!.id})
    `;
    await admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id, authorization_revision
      ) values (${account!.id}, ${subjectId}, 'active', ${originWorkspace!.id}, 1)
    `;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${account!.id}, ${targetWorkspace!.id}, ${subjectId})
    `;
    const machine = await admin.begin(async (tx) => {
      await tx`select
        set_config('opengeni.account_id', ${account!.id}, true),
        set_config('opengeni.workspace_id', ${originWorkspace!.id}, true),
        set_config('opengeni.subject_id', ${subjectId}, true)`;
      const [row] = await tx<Array<{ enrollmentId: string }>>`
        select enrollment_id as "enrollmentId"
        from finalize_scoped_enrollment(
          ${account!.id}::uuid, ${originWorkspace!.id}::uuid, 'organization',
          ${`ed25519:${crypto.randomUUID()}`}, true, true, 'linux', 'x86_64',
          'Organization route machine', true
        )
      `;
      return row!;
    });
    const [machineCredential] = await admin<Array<{ credentialGeneration: number }>>`
      select credential_generation as "credentialGeneration"
      from enrollments
      where id = ${machine.enrollmentId} and authority_scope = 'organization'
    `;
    const connectionInstanceId = await claimTestConnection({
      accountId: account!.id,
      workspaceId: originWorkspace!.id,
      enrollmentId: machine.enrollmentId,
      credentialGeneration: machineCredential!.credentialGeneration,
    });
    let providerRequests = 0;
    const bus = busWithAgent(
      originWorkspace!.id,
      machine.enrollmentId,
      connectionInstanceId,
      "organization-route-machine",
      () => {
        providerRequests += 1;
      },
    ) as never;
    const established = await establishSelfhostedTurnSession(
      { db, settings, bus, opJournal: testOpJournal },
      {
        accountId: account!.id,
        workspaceId: targetWorkspace!.id,
        sessionId: crypto.randomUUID(),
        controlWorkspaceId: originWorkspace!.id,
        agentId: machine.enrollmentId,
        connectionInstanceId,
        workspaceRoot: "/home/user/project",
        opStream: true,
        operationResourcePolicy: {
          memoryMaxBytes: null,
          memoryHighBytes: null,
          cpuMaxMillicores: null,
          revision: 0,
          updatedAt: null,
        },
        operationResourcePolicySupported: false,
        operationCpuQuotaSupported: false,
        epoch: 0,
        environment: {},
        workingDir: null,
      },
    );

    expect(
      (
        (await (established.session as { exec(args: unknown): Promise<unknown> }).exec({
          cmd: "hostname",
        })) as { stdout: string }
      ).stdout.trim(),
    ).toBe("organization-route-machine");
    expect(providerRequests).toBe(1);
  }, 60_000);

  test("revocation fences both cached swapped and pinned personal-machine sessions before dispatch", async () => {
    if (!available) return;
    const subjectId = `human:${crypto.randomUUID()}`;
    const [account] = await admin<Array<{ id: string }>>`
      insert into managed_accounts (name) values (${`personal-route-${crypto.randomUUID()}`})
      returning id
    `;
    const [originWorkspace] = await admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'personal machine origin') returning id
    `;
    const [targetWorkspace] = await admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'personal machine target') returning id
    `;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id) values
        (${originWorkspace!.id}, ${account!.id}),
        (${targetWorkspace!.id}, ${account!.id})
    `;
    const [membership] = await admin<Array<{ id: string }>>`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id, authorization_revision
      ) values (${account!.id}, ${subjectId}, 'active', ${originWorkspace!.id}, 1)
      returning id
    `;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${account!.id}, ${targetWorkspace!.id}, ${subjectId})
    `;
    const machine = await admin.begin(async (tx) => {
      await tx`select
        set_config('opengeni.account_id', ${account!.id}, true),
        set_config('opengeni.workspace_id', ${originWorkspace!.id}, true),
        set_config('opengeni.subject_id', ${subjectId}, true),
        set_config('opengeni.initiating_human_subject_id', ${subjectId}, true)`;
      const [row] = await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
        select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
        from finalize_scoped_enrollment(
          ${account!.id}::uuid, ${originWorkspace!.id}::uuid, 'user',
          ${`ed25519:${crypto.randomUUID()}`}, true, true, 'linux', 'x86_64',
          'Personal route machine', false
        )
      `;
      return row!;
    });
    const [machineCredential] = await admin<Array<{ credentialGeneration: number }>>`
      select credential_generation as "credentialGeneration"
      from enrollments where id = ${machine.enrollmentId}
    `;
    const connectionInstanceId = await claimTestConnection({
      accountId: account!.id,
      workspaceId: originWorkspace!.id,
      enrollmentId: machine.enrollmentId,
      credentialGeneration: machineCredential!.credentialGeneration,
    });
    const session = await createSession(db, {
      accountId: account!.id,
      workspaceId: targetWorkspace!.id,
      initialMessage: "use my personal machine",
      resources: [],
      metadata: {},
      model: "gpt-test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "selfhosted",
      createdBy: { kind: "subject", subjectId },
      subjectId,
    });
    const [authority] = await admin<Array<{ id: string }>>`
      select id from organization_user_resource_authorities
      where account_id = ${account!.id}
        and organization_membership_id = ${membership!.id}
        and resource_kind = 'connected_machine'
        and resource_id = ${machine.enrollmentId}
    `;
    const [sessionAuthority] = await admin<Array<{ visibility: string; authorityEpoch: number }>>`
      select visibility, authority_epoch as "authorityEpoch"
      from sessions where id = ${session.id}
    `;
    const [grant] = await admin.begin(async (tx) => {
      await tx`select
        set_config('opengeni.account_id', ${account!.id}, true),
        set_config('opengeni.workspace_id', ${targetWorkspace!.id}, true),
        set_config('opengeni.subject_id', ${subjectId}, true),
        set_config('opengeni.initiating_human_subject_id', ${subjectId}, true)`;
      return await tx<Array<{ grantId: string }>>`
        select grant_id as "grantId" from issue_self_user_resource_grant(
          ${account!.id}::uuid, ${authority!.id}::uuid,
          ${targetWorkspace!.id}::uuid, 'connected_machine.use', 'session',
          ${sessionAuthority!.visibility}, ${session.id}::uuid, true
        )
      `;
    });
    await admin`
      update sessions set active_sandbox_id = ${machine.sandboxId}
      where account_id = ${account!.id} and workspace_id = ${targetWorkspace!.id}
        and id = ${session.id}
    `;
    const attempt = await claimRoutingAttempt({
      accountId: account!.id,
      workspaceId: targetWorkspace!.id,
      sessionId: session.id,
    });
    let providerRequests = 0;
    const bus = busWithAgent(
      originWorkspace!.id,
      machine.enrollmentId,
      connectionInstanceId,
      "personal-route-machine",
      () => {
        providerRequests += 1;
      },
    ) as never;
    const exactAttempt = {
      accountId: account!.id,
      subjectId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
    };
    const swapped = wrapTurnBoxWithRouting(
      { db, settings, bus, opJournal: testOpJournal },
      {
        workspaceId: targetWorkspace!.id,
        sessionId: session.id,
        workspaceMutationFence: attempt,
        resourceAccountId: account!.id,
        resourceSubjectId: subjectId,
        personalMachineAttempt: exactAttempt,
      },
      fakeGroupBox("unused-home"),
    ).session as {
      exec(args: unknown): Promise<unknown>;
      readFile(args: unknown): Promise<unknown>;
    };
    const pinned = await establishSelfhostedTurnSession(
      { db, settings, bus, opJournal: testOpJournal },
      {
        accountId: account!.id,
        workspaceId: targetWorkspace!.id,
        sessionId: session.id,
        controlWorkspaceId: originWorkspace!.id,
        agentId: machine.enrollmentId,
        connectionInstanceId,
        workspaceRoot: "/home/user/project",
        opStream: true,
        operationResourcePolicy: {
          memoryMaxBytes: null,
          memoryHighBytes: null,
          cpuMaxMillicores: null,
          revision: 0,
          updatedAt: null,
        },
        operationResourcePolicySupported: false,
        operationCpuQuotaSupported: false,
        epoch: 0,
        environment: {},
        workingDir: null,
        personalMachineAttempt: { ...exactAttempt, sessionId: session.id },
      },
    );
    expect(((await swapped.exec({ cmd: "hostname" })) as { stdout: string }).stdout.trim()).toBe(
      "personal-route-machine",
    );
    expect(
      (
        (await (pinned.session as { exec(args: unknown): Promise<unknown> }).exec({
          cmd: "hostname",
        })) as { stdout: string }
      ).stdout.trim(),
    ).toBe("personal-route-machine");
    expect(providerRequests).toBe(2);

    await admin`
      update organization_user_resource_grants
      set status = 'revoked', revoked_at = now()
      where id = ${grant!.grantId}
    `;
    await expect(swapped.readFile({ path: "/workspace/private" })).rejects.toThrow();
    await expect(
      (pinned.session as { exec(args: unknown): Promise<unknown> }).exec({
        cmd: "hostname",
      }),
    ).rejects.toThrow();
    expect(providerRequests).toBe(2);
  }, 60_000);

  test("operation-level 404/NOT_FOUND preserves the warm provider identity and epoch", async () => {
    if (!available) return;
    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values ('acct-subresource-miss') returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, 'ws-subresource-miss') returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
    const accountId = a!.id;
    const workspaceId = w!.id;
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
    });
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      kind: "turn",
      holderId: "subresource-miss-turn",
      subjectId: session.id,
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "box-still-live",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "box-still-live" } },
      },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);
    const warmEpoch = committed.lease!.leaseEpoch;
    const subresourceMissing = Object.assign(new Error("/workspace/missing.txt not found"), {
      code: "NOT_FOUND",
      status: 404,
    });
    const groupBox: EstablishedSandboxSession = {
      client: {},
      session: {
        state: { instanceId: "box-still-live" },
        async writeFile() {
          throw subresourceMissing;
        },
      },
      sessionState: {},
      instanceId: "box-still-live",
      backendId: "modal",
    };
    const established = wrapTurnBoxWithRouting(
      {
        db,
        settings,
        bus: new MemoryEventBus() as never,
        opJournal: testOpJournal,
      },
      {
        workspaceId,
        sessionId: session.id,
        homeLease: {
          accountId,
          sandboxGroupId: session.sandboxGroupId,
          leaseEpoch: warmEpoch,
          instanceId: "box-still-live",
          backend: "modal",
        },
      },
      groupBox,
    );

    const error = await (established.session as { writeFile: (args: unknown) => Promise<unknown> })
      .writeFile({ path: "/workspace/missing.txt", content: "x" })
      .catch((caught) => caught);
    expect(error).toBe(subresourceMissing);
    const lease = await readLease(db, workspaceId, session.sandboxGroupId);
    expect(lease).toMatchObject({
      liveness: "warm",
      instanceId: "box-still-live",
      leaseEpoch: warmEpoch,
      recovery: {
        provider: { status: "exists", instanceId: "box-still-live" },
      },
    });
  }, 60_000);

  test("provider loss retires once and the stable proxy drops the dead backend", async () => {
    if (!available) return;
    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values ('acct-provider-loss') returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, 'ws-provider-loss') returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
    const accountId = a!.id;
    const workspaceId = w!.id;
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
    });

    const archive = Buffer.from("concurrent-route-archive").toString("base64");
    const archiveBytes = Buffer.from(archive, "base64");
    const archiveSha256 = new Bun.CryptoHasher("sha256").update(archiveBytes).digest("hex");
    const descriptor = {
      version: 1 as const,
      revision: `wa1:1900000000000:${archiveSha256}`,
      archiveSha256,
      archiveBytes: archiveBytes.length,
      capturedAt: "2030-03-17T17:46:40.000Z",
      workspace: {
        algorithm: "sha256" as const,
        sha256: "b".repeat(64),
        entryCount: 2,
        fileCount: 1,
        totalFileBytes: 31,
      },
    };
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      kind: "turn",
      holderId: "provider-loss-turn",
      subjectId: session.id,
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "box-before-concurrent-loss",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: {
          providerState: { sandboxId: "box-before-concurrent-loss" },
          workspaceArchive: archive,
          workspaceArchiveMeta: descriptor,
        },
      },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);
    expect(committed.lease?.leaseEpoch).toBe(acquired.lease.leaseEpoch + 1);
    // This setup bypasses the capture activity. Mark its structurally valid
    // archive as the completed capture that the provider-loss path expects.
    await admin`
      update sandbox_leases
      set archive_generation = workspace_generation
      where workspace_id = ${workspaceId}
        and sandbox_group_id = ${session.sandboxGroupId}`;
    const warmEpoch = committed.lease!.leaseEpoch;

    const operationCalls = Array.from({ length: 24 }, () => 0);
    let deadProviderCalls = 0;
    const missing = Object.assign(new Error("provider sandbox missing"), {
      code: "SANDBOX_NOT_FOUND",
      status: 404,
    });
    const groupBox: EstablishedSandboxSession = {
      client: {},
      session: {
        state: { instanceId: "box-before-concurrent-loss" },
        async writeFile(args: unknown) {
          deadProviderCalls += 1;
          const index = (args as { index: number }).index;
          operationCalls[index] += 1;
          await Promise.resolve();
          throw missing;
        },
      },
      sessionState: {},
      instanceId: "box-before-concurrent-loss",
      backendId: "modal",
    };
    const lossEvents: Array<{
      sandboxGroupId: string;
      instanceId: string;
      leaseEpoch: number;
    }> = [];
    const established = wrapTurnBoxWithRouting(
      {
        db,
        settings,
        bus: new MemoryEventBus() as never,
        opJournal: testOpJournal,
        onHomeSandboxLost: async (event) => {
          lossEvents.push(event);
        },
      },
      {
        workspaceId,
        sessionId: session.id,
        homeLease: {
          accountId,
          sandboxGroupId: session.sandboxGroupId,
          leaseEpoch: warmEpoch,
          instanceId: "box-before-concurrent-loss",
          backend: "modal",
        },
      },
      groupBox,
    );
    const proxy = established.session as {
      writeFile: (args: unknown) => Promise<unknown>;
    };

    const results = await Promise.allSettled(
      operationCalls.map((_, index) => proxy.writeFile({ path: `/workspace/${index}`, index })),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    const errors = results.map((result) =>
      result.status === "rejected" ? result.reason : new Error("unexpected fulfilled mutation"),
    );
    expect(errors.every((error) => error instanceof RoutingBackendRecoveryRequiredError)).toBe(
      true,
    );
    const recoveryErrors = errors as RoutingBackendRecoveryRequiredError[];
    const recoveries = recoveryErrors.map((error) => error.recovery);
    expect(recoveries.every((status) => status === "pending" || status === "superseded")).toBe(
      true,
    );

    // Concurrent calls may already hold the shared provider handle, or may
    // re-resolve after the winner invalidates it. Exactly one provider caller
    // retires warm -> cold as pending; other provider callers lose that CAS as
    // superseded. Re-resolved callers observe durable pending recovery before
    // provider dispatch. These are scheduler-dependent subsets, but the durable
    // election, disposition, and no-replay invariants are exact.
    const providerFailures = recoveryErrors.filter((error) => error.op === "writeFile");
    const reResolvedFailures = recoveryErrors.filter(
      (error) => error.op === "resolve_home_backend",
    );
    expect(providerFailures.length + reResolvedFailures.length).toBe(operationCalls.length);
    expect(providerFailures.length).toBeGreaterThanOrEqual(1);
    expect(providerFailures.filter((error) => error.recovery === "pending")).toHaveLength(1);
    expect(providerFailures.filter((error) => error.recovery === "superseded")).toHaveLength(
      providerFailures.length - 1,
    );
    expect(reResolvedFailures.every((error) => error.recovery === "pending")).toBe(true);
    expect(
      recoveryErrors.every((error) => error.leaseEpoch === warmEpoch + 1 && error.retryable),
    ).toBe(true);
    expect(operationCalls.every((calls) => calls === 0 || calls === 1)).toBe(true);
    expect(operationCalls.reduce((sum, calls) => sum + calls, 0)).toBe(deadProviderCalls);
    expect(providerFailures).toHaveLength(deadProviderCalls);
    const callsAfterConcurrentLoss = deadProviderCalls;

    // The route pointer itself did not move in any of the three incidents. The
    // stable proxy must still discard its cached provider handle after the loss
    // transition: the next independent call re-resolves durable cold/recovery
    // truth and never invokes the dead backend again.
    const followUpError = await proxy
      .writeFile({ path: "/workspace/post-loss", index: 24 })
      .catch((error) => error);
    expect(followUpError).toBeInstanceOf(RoutingBackendRecoveryRequiredError);
    expect(followUpError).toMatchObject({
      leaseEpoch: warmEpoch + 1,
      recovery: "pending",
      retryable: true,
    });
    expect(deadProviderCalls).toBe(callsAfterConcurrentLoss);
    expect(lossEvents).toEqual([
      {
        sandboxGroupId: session.sandboxGroupId,
        instanceId: "box-before-concurrent-loss",
        leaseEpoch: warmEpoch + 1,
      },
    ]);

    const lease = await readLease(db, workspaceId, session.sandboxGroupId);
    expect(lease).toMatchObject({
      liveness: "cold",
      instanceId: null,
      leaseEpoch: warmEpoch + 1,
      recovery: {
        provider: {
          status: "missing",
          instanceId: "box-before-concurrent-loss",
          diagnostic: "provider_not_found_during_routed_operation",
        },
        archive: {
          status: "available",
          current: { revision: descriptor.revision },
        },
        restore: { status: "pending", selectedRevision: descriptor.revision },
        workspace: { status: "not_ready", verifiedRevision: null },
      },
    });
    expect(lease?.resumeState).not.toHaveProperty("sessionState.providerState");
    expect(lease?.resumeState).toHaveProperty("sessionState.workspaceArchive", archive);
  }, 60_000);

  test("routingEnabled is false when the selfhosted flag is off (the proxy is not wrapped)", () => {
    const off = testSettings({ sandboxSelfhostedEnabled: false });
    expect(routingEnabled(off)).toBe(false);
  });

  test("lazy wrapper seeds synthetic manifest and default-pointer ops single-flight through the provisioner", async () => {
    if (!available) return;
    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values ('acct-lazy') returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, 'ws-lazy') returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
    const accountId = a!.id;
    const workspaceId = w!.id;
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
    });
    const manifest = buildManifest(settings, [], {
      HOME: "/workspace",
      LAZY: "1",
    });
    let provisions = 0;
    const real = fakeGroupBox("lazy-real");
    const lazy = wrapLazyTurnBoxWithRouting(
      {
        db,
        settings,
        bus: new MemoryEventBus() as never,
        opJournal: testOpJournal,
      },
      {
        workspaceId,
        sessionId: session.id,
        environment: { HOME: "/workspace", LAZY: "1" },
      },
      {
        client: { backendId: "modal" },
        backendId: "modal",
        agentDefaultManifest: manifest,
        provisioner: {
          get: async () => {
            provisions += 1;
            return { established: real };
          },
        },
      },
    );
    const proxy = lazy.session as {
      state: { manifest: unknown };
      supportsPty: () => boolean;
      commandCancellationTransport: () => Promise<"remote_operation" | "shell_session">;
      exec: (a: unknown) => Promise<{ stdout: string }>;
    };

    expect(proxy.state.manifest).toBe(manifest);
    expect(proxy.supportsPty()).toBe(true);
    expect(provisions).toBe(0);
    expect(await proxy.commandCancellationTransport()).toBe("shell_session");
    expect(provisions).toBe(1);
    expect((await proxy.exec({ cmd: "echo hi" })).stdout).toBe("lazy-real");
    expect(provisions).toBe(1);
    expect((await proxy.exec({ cmd: "echo again" })).stdout).toBe("lazy-real");
    expect(provisions).toBe(1);
  });
});

describe("M7 worker routing — turn-start reconcile (issue #341 invariant B)", () => {
  async function seedAcctWs(tag: string): Promise<{ accountId: string; workspaceId: string }> {
    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values (${`acct-${tag}`}) returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, ${`ws-${tag}`}) returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
    return { accountId: a!.id, workspaceId: w!.id };
  }

  test("a stranded Modal-sibling pointer resets to HOME (null) + emits session.route.reconciled (Shapes 1/2)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await seedAcctWs("recon");
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
    });
    // A first-class Modal sibling row (no group/lease/box) — the categorical strand.
    const sibling = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "sibling",
    });
    // Persist a stranded pointer directly (a legacy pre-gate pointer / FK orphan):
    // the session points at the unestablishable sibling at epoch 1.
    const stranded = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: sibling.id,
      expectedEpoch: 0,
    });
    expect(stranded.swapped).toBe(true);
    const pointer = (await readActiveSandbox(db, workspaceId, session.id))!;

    const events: Array<{ type: string; payload: unknown }> = [];
    const result = await reconcileActiveSandboxPointer(
      db,
      { accountId, workspaceId, sessionId: session.id },
      pointer,
      (id) => getSandbox(db, workspaceId, id),
      async (evs) => {
        events.push(...evs);
      },
    );

    // Reset to HOME under the fence: pointer null, epoch bumped, record cleared.
    expect(result.pointer?.activeSandboxId ?? null).toBeNull();
    expect(result.pointer!.activeEpoch).toBe(pointer.activeEpoch + 1);
    expect(result.record).toBeNull();
    // The DB reflects the reset (not just the in-memory return).
    const persisted = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(persisted.activeSandboxId).toBeNull();
    expect(persisted.activeEpoch).toBe(pointer.activeEpoch + 1);
    // A VISIBLE typed event was emitted (never a silent downgrade), carrying the
    // reason + epochs but NO target id.
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("session.route.reconciled");
    expect(events[0]!.payload).toMatchObject({
      reason: "unsupported_backend_context",
      fromEpoch: pointer.activeEpoch,
      toEpoch: pointer.activeEpoch + 1,
    });
    expect(JSON.stringify(events[0]!.payload)).not.toContain(sibling.id);
  }, 60_000);

  test("reconcile is epoch-fenced: a concurrent higher-epoch swap is NOT clobbered", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await seedAcctWs("fence");
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
    });
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:${crypto.randomUUID()}`,
      exposure: "whole-machine",
      hasDisplay: true,
      allowScreenControl: true,
      os: "linux",
      arch: "x86_64",
    });
    const machine = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "laptop",
      enrollmentId: enrollment.id,
    });
    const sibling = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "sibling",
    });

    // The turn LOADS a stranded modal-sibling pointer at epoch 1...
    await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: sibling.id,
      expectedEpoch: 0,
    });
    const stalePointer = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(stalePointer.activeEpoch).toBe(1);

    // ...but a CONCURRENT user swap moves the real pointer to the enrolled machine at a
    // HIGHER epoch (2) before the reconcile CAS runs.
    const concurrent = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: machine.id,
      expectedEpoch: stalePointer.activeEpoch,
    });
    expect(concurrent.swapped).toBe(true);
    expect(concurrent.pointer!.activeEpoch).toBe(2);

    const events: Array<{ type: string }> = [];
    const result = await reconcileActiveSandboxPointer(
      db,
      { accountId, workspaceId, sessionId: session.id },
      stalePointer,
      (id) => getSandbox(db, workspaceId, id),
      async (evs) => {
        events.push(...evs);
      },
    );

    // The stale reset LOST the fence: the user's machine swap survives untouched.
    expect(result.pointer?.activeSandboxId).toBe(machine.id);
    expect(result.pointer!.activeEpoch).toBe(2);
    expect(result.record?.id).toBe(machine.id);
    // No reconcile event (nothing was reset); the DB still points at the machine.
    expect(events).toHaveLength(0);
    const persisted = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(persisted.activeSandboxId).toBe(machine.id);
    expect(persisted.activeEpoch).toBe(2);
  }, 60_000);

  // FAIL-OPEN on a transient lookup failure (issue #341 review / Bugbot): a throwing
  // record lookup must NEVER be read as "row absent" and clear a (possibly healthy)
  // user-chosen pointer. The SAME stranded pointer that reconciles cleanly when the
  // lookup succeeds must be left UNTOUCHED (no CAS, no event) when the lookup throws.
  test("a transient record-lookup failure never mutates the pointer (fail-open to pre-reconcile behavior)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await seedAcctWs("transient");
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
    });
    // A stranded Modal-sibling pointer that WOULD reconcile if the lookup succeeded.
    const sibling = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "sibling",
    });
    await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: sibling.id,
      expectedEpoch: 0,
    });
    const pointer = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(pointer.activeSandboxId).toBe(sibling.id);

    const events: Array<{ type: string }> = [];
    let lookups = 0;
    const result = await reconcileActiveSandboxPointer(
      db,
      { accountId, workspaceId, sessionId: session.id },
      pointer,
      // A transient DB blip: the lookup THROWS (recovered by the time the CAS would run).
      async () => {
        lookups += 1;
        throw new Error("transient db lookup failure");
      },
      async (evs) => {
        events.push(...evs);
      },
    );

    // Fail open: no reconciliation happened. The pointer is UNTOUCHED (still the sibling
    // at the same epoch), record null (→ machinePrimary:false, group box), no event.
    expect(lookups).toBe(1);
    expect(result.pointer?.activeSandboxId).toBe(sibling.id);
    expect(result.pointer!.activeEpoch).toBe(pointer.activeEpoch);
    expect(result.record).toBeNull();
    expect(events).toHaveLength(0);
    // Crucially the DB pointer/epoch never moved — no CAS ran on the transient failure.
    const persisted = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(persisted.activeSandboxId).toBe(sibling.id);
    expect(persisted.activeEpoch).toBe(pointer.activeEpoch);

    // Sanity: the SAME pointer DOES reconcile once the lookup succeeds (proves the throw
    // — not some other condition — is what suppressed the reset).
    const events2: Array<{ type: string }> = [];
    const recovered = await reconcileActiveSandboxPointer(
      db,
      { accountId, workspaceId, sessionId: session.id },
      pointer,
      (id) => getSandbox(db, workspaceId, id),
      async (evs) => {
        events2.push(...evs);
      },
    );
    expect(recovered.pointer?.activeSandboxId ?? null).toBeNull();
    expect(events2).toHaveLength(1);
    expect(events2[0]!.type).toBe("session.route.reconciled");
  }, 60_000);

  // BEHAVIORAL "pointer untouched" (issue #341 invariant A / Shape 1): a rejected
  // Modal-sibling swap must not move the pointer, proven by ROUTING — the next op
  // still lands on the pre-swap backend, not by DB inspection alone.
  test("a rejected sibling swap leaves the pointer untouched: the next op still routes to the pre-swap backend", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await seedAcctWs("reject-untouched");
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
    });
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:${crypto.randomUUID()}`,
      exposure: "whole-machine",
      hasDisplay: true,
      allowScreenControl: true,
      os: "linux",
      arch: "x86_64",
    });
    const machine = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "laptop",
      enrollmentId: enrollment.id,
    });
    const sibling = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "sibling",
    });
    const connectionInstanceId = await claimTestConnection({
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      credentialGeneration: enrollment.credentialGeneration,
    });
    const bus = busWithAgent(
      workspaceId,
      enrollment.id,
      connectionInstanceId,
      "the-laptop",
    ) as never;

    // Pre-swap: pin the session to the machine (the pre-swap backend the ops route to).
    await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: machine.id,
      expectedEpoch: 0,
    });
    const before = (await readActiveSandbox(db, workspaceId, session.id))!;

    const established = wrapTurnBoxWithRouting(
      { db, settings, bus, opJournal: testOpJournal },
      { workspaceId, sessionId: session.id },
      fakeGroupBox("group-box-marker"),
    );
    const proxy = established.session as {
      exec: (a: unknown) => Promise<{ stdout: string }>;
    };
    // The op currently routes to the machine (the pre-swap backend).
    expect((await proxy.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("the-laptop");

    // Attempt to swap onto the Modal sibling → REJECTED before the CAS.
    const ctx: FleetContext = {
      accountId,
      workspaceId,
      sessionId: session.id,
      sessionBackend: "modal",
      sessionGroupId: session.sandboxGroupId,
    };
    const rejected = await swapActiveSandbox({ db, settings, bus }, ctx, sibling.id);
    expect(rejected.swapped).toBe(false);
    expect(rejected.code).toBe("unsupported_backend_context");

    // The pointer never moved: the next op STILL routes to the pre-swap machine, and
    // the persisted pointer/epoch are unchanged.
    expect((await proxy.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("the-laptop");
    const after = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(after.activeSandboxId).toBe(machine.id);
    expect(after.activeEpoch).toBe(before.activeEpoch);
  }, 60_000);
});
