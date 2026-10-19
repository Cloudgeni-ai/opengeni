import { afterEach, describe, expect, test } from "bun:test";
import {
  ControlRequest,
  ControlResponse,
  ErrorCode,
  OpLostReason,
  OpState,
  type OpStatus,
} from "@opengeni/agent-proto";
import {
  ComputeControlClient,
  ComputeControlError,
  ComputeSandboxClient,
  ComputeSandboxSession,
  ComputeWakeGate,
  ComputeWakingControlRpc,
  MockAgentResponder,
  NatsControlRpc,
  SandboxConfigError,
  SandboxExactResumeInstanceUnavailableError,
  SelfhostedControlError,
  classifyProviderSandboxFailure,
  isProviderSandboxGoneDuringRoutedOperation,
  negotiateCapabilities,
  offlineControlResponse,
  usesAgentTransport,
  type ComputeAgentConnection,
  type ComputeAgentPlane,
  type ControlRpc,
  type NatsRequestConnection,
  sweepComputeOrphans,
  createComputeOrphanSweepProgress,
  reconcileStaleComputeEnrollments,
  serializeEstablishedSandboxEnvelope,
  wakeComputeSandboxOnNoResponders,
} from "../src/sandbox";
import { COMPUTE_ORPHAN_SWEEP_LIMIT } from "../src/sandbox/compute/orphans";
import { applyDiff } from "@openai/agents";
import { Manifest } from "@openai/agents/sandbox";
import { setSelfhostedApplyDiff } from "../src/sandbox/selfhosted/session";
import { fileContentDigest } from "../src/sandbox/selfhosted/file-transfer";
import { FakeOpRunner, InMemoryOpStreamTransport } from "../src/sandbox/selfhosted/op-testing";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
const RELAY = { host: "relay.test", port: 443, tls: true } as const;
const GATEWAY = "wss://gateway.test/v1/compute/agent-link";

type FakeSandbox = {
  id: string;
  body: Record<string, unknown>;
  createdMs?: number;
};

/** An in-process fake of the control service HTTP API (the subset Opengeni uses). */
class FakeControlService {
  readonly boxes = new Map<string, FakeSandbox>();
  /** request_id -> sandbox id, kept after a delete (410 request_gone). */
  readonly requestIds = new Map<string, string>();
  readonly requests: Array<{ method: string; path: string; body: unknown; apiKey: string | null }> =
    [];
  wakes = 0;
  /** Answer the next N creates with this status before succeeding. */
  failCreates: number[] = [];
  /** Make the sandbox but never answer a create (every attempt is a 504). */
  loseCreateAnswers = false;
  /** Fail request lookups and deletes (the control service is unreachable for cleanup). */
  failCleanup = false;
  /** Sandboxes whose delete never answers until the client gives up. */
  readonly stallDeletes = new Set<string>();
  /** Sandboxes whose delete always fails. */
  readonly failDeletes = new Set<string>();
  private readonly stalls = new Set<() => void>();
  private readonly server: ReturnType<typeof Bun.serve>;
  /** Called when the control service wakes a sandbox. */
  onWake: (box: FakeSandbox) => void = () => {};
  onCreate: (box: FakeSandbox) => void = () => {};

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const text =
          request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
        const body = text ? JSON.parse(text) : undefined;
        this.requests.push({
          method: request.method,
          path: url.pathname + url.search,
          body,
          apiKey: request.headers.get("x-api-key"),
        });
        if (request.headers.get("x-api-key") !== "control-key") {
          return Response.json({ code: "unauthorized", message: "bad key" }, { status: 401 });
        }
        const parts = url.pathname.split("/").filter(Boolean);
        if (request.method === "GET" && url.pathname === "/v1/link/keys") {
          return Response.json({ team: "opengeni", keys: [] });
        }
        if (request.method === "GET" && parts[1] === "requests") {
          if (this.failCleanup) {
            return Response.json({ code: "unavailable", message: "down" }, { status: 503 });
          }
          const id = this.requestIds.get(parts[2] ?? "");
          if (!id) return Response.json({ code: "not_found", message: "none" }, { status: 404 });
          const box = this.boxes.get(id);
          if (!box)
            return Response.json({ code: "request_gone", message: "gone" }, { status: 410 });
          return Response.json(this.view(box));
        }
        if (request.method === "GET" && url.pathname === "/v1/sandboxes") {
          const wanted = [...url.searchParams];
          return Response.json(
            [...this.boxes.values()]
              .filter((box) =>
                wanted.every(
                  ([key, value]) =>
                    (box.body.metadata as Record<string, string> | undefined)?.[key] === value,
                ),
              )
              .map((box) => this.view(box)),
          );
        }
        if (request.method === "POST" && url.pathname === "/v1/sandboxes") {
          const status = this.failCreates.shift();
          if (status) return Response.json({ code: "busy", message: "try again" }, { status });
          const knownId = this.requestIds.get(body.request_id);
          let box = knownId ? this.boxes.get(knownId) : undefined;
          if (knownId && !box) {
            return Response.json({ code: "request_gone", message: "deleted" }, { status: 410 });
          }
          if (box && JSON.stringify(box.body) !== JSON.stringify(body)) {
            return Response.json(
              { code: "request_mismatch", message: "another body" },
              { status: 409 },
            );
          }
          if (!box) {
            box = { id: `sbx-${this.requestIds.size + 1}`, body, createdMs: Date.now() };
            this.boxes.set(box.id, box);
            this.requestIds.set(body.request_id, box.id);
            this.onCreate(box);
          }
          if (this.loseCreateAnswers) {
            return Response.json({ code: "unknown_outcome", message: "lost" }, { status: 504 });
          }
          return Response.json(this.view(box), { status: 201 });
        }
        const box = parts[2] ? this.boxes.get(parts[2]) : undefined;
        if (!box) return Response.json({ code: "not_found", message: "none" }, { status: 404 });
        if (request.method === "POST" && parts[3] === "wake") {
          this.wakes += 1;
          this.onWake(box);
          return Response.json({ waited_us: 10, generation: 1, host: "h1" });
        }
        if (request.method === "GET") return Response.json(this.view(box));
        if (request.method === "DELETE") {
          if (this.stallDeletes.has(box.id)) {
            await new Promise<void>((resolve) => {
              this.stalls.add(resolve);
              request.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return Response.json({ code: "unavailable", message: "stalled" }, { status: 503 });
          }
          if (this.failCleanup || this.failDeletes.has(box.id)) {
            return Response.json({ code: "unavailable", message: "down" }, { status: 503 });
          }
          this.boxes.delete(box.id);
          return new Response(null, { status: 204 });
        }
        return Response.json({ code: "invalid", message: "no route" }, { status: 400 });
      },
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  view(box: FakeSandbox) {
    const agent = (box.body.init as { agent: { workspace_id: string; agent_id: string } }).agent;
    return {
      id: box.id,
      image: (box.body.image as string | undefined) ?? "default",
      config: {},
      metadata: box.body.metadata,
      agent: { workspace: agent.workspace_id, agent: agent.agent_id },
      host: "h1",
      owner_epoch: 1,
      created_ms: box.createdMs ?? 1,
    };
  }

  /** Put an orphan of this deployment on the control service, created long ago. */
  addOrphan(id: string, enrollmentId: string = crypto.randomUUID()): FakeSandbox {
    const box: FakeSandbox = {
      id,
      createdMs: 1,
      body: {
        metadata: {
          opengeni_gateway: GATEWAY,
          opengeni_workspace_id: WORKSPACE,
          opengeni_sandbox_group_id: GROUP,
          opengeni_enrollment_id: enrollmentId,
        },
        init: { agent: { workspace_id: WORKSPACE, agent_id: enrollmentId } },
      },
    };
    this.boxes.set(id, box);
    return box;
  }

  stop(): void {
    for (const release of this.stalls) release();
    this.stalls.clear();
    this.server.stop(true);
  }
}

/** The gateway as the runtime sees it: an agent is reachable while its host
 * holds its session open (asleep or not); with no session, no responder. */
class FakeAgentPlane implements ComputeAgentPlane {
  readonly transport = new InMemoryOpStreamTransport();
  readonly responder = new MockAgentResponder();
  readonly created: Array<Record<string, unknown>> = [];
  readonly revoked: string[] = [];
  readonly sent: Array<{ subject: string; req: ControlRequest }> = [];
  /** enrollment id -> the instance whose session the gateway holds. */
  readonly sessions = new Map<string, string>();
  /** The agent's Hello advertised `run_as`. */
  runAs = false;
  /** Every exec the agent ran over its op-stream. */
  readonly execs: Array<{ cmd: string; runAs: string }> = [];
  /** Serve control requests through the real NATS control transport (with
   * its replay recovery) over this fake request connection. */
  natsTransport = false;
  /** Every subject a request was sent on over that connection. */
  readonly natsSubjects: string[] = [];
  /** Instances whose host still takes requests but whose agent is gone: a
   * request there is held and never answered, so it times out. */
  readonly heldInstances = new Set<string>();
  /** The agent's Hello advertised transactional file writes, and whether
   * they also accept machine-addressed (epoch 0) transactions. */
  transactional = false;
  transactionalMachine = false;
  /** Transactional writes by op id, as the agent's upload engine keeps them. */
  readonly uploads = new Map<string, { epoch: number; path: string; bytes: number[] }>();
  private readonly runners = new Map<string, FakeOpRunner>();

  private runner(agentId: string, instance: string): FakeOpRunner {
    const key = `${agentId}:${instance}`;
    let runner = this.runners.get(key);
    if (!runner) {
      runner = new FakeOpRunner({
        transport: this.transport,
        workspaceId: WORKSPACE,
        agentId,
        connectionInstanceId: instance,
        defaultScript: async (exec) => {
          this.execs.push({ cmd: exec.command.join(" "), runAs: exec.runAs });
          const response = await this.responder.runExec(exec);
          return {
            frames:
              response.stdout.length > 0
                ? [{ channel: "stdout" as const, bytes: response.stdout }]
                : [],
            exit: { exitCode: response.exitCode, timedOut: false },
          };
        },
      });
      this.runners.set(key, runner);
    }
    return runner;
  }

  /** The host opened the agent's session at the gateway. */
  open(agentId: string, instance: string = crypto.randomUUID()): string {
    this.sessions.set(agentId, instance);
    return instance;
  }

  /** The no-responders handler the latest session gave its transport. */
  onNoResponders: ((subject: string) => Promise<boolean>) | undefined;

  controlRpc(options?: { onNoResponders?: (subject: string) => Promise<boolean> }): ControlRpc {
    this.onNoResponders = options?.onNoResponders;
    const fake = this.fakeControlRpc();
    if (!this.natsTransport) return fake;
    const connection: NatsRequestConnection = {
      supportsHeaders: true,
      request: async (subject, payload, opts) => {
        this.natsSubjects.push(subject);
        const base = subject.split(".replay.")[0]!;
        if (this.heldInstances.has(base.split(".")[4] ?? "")) {
          await Bun.sleep(opts.timeout);
          throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
        }
        if (this.sessions.get(base.split(".")[2] ?? "") !== base.split(".")[4]) {
          throw Object.assign(new Error("503 no responders"), { code: "503" });
        }
        const answer = await fake.request(base, ControlRequest.decode(payload), {
          timeoutMs: opts.timeout,
        });
        return {
          data: ControlResponse.encode(answer).finish(),
          headers: { get: (name: string) => (name === "Opengeni-Control-Replay" ? "1" : "") },
        };
      },
    };
    return new NatsControlRpc(
      async () => connection,
      options?.onNoResponders ? { onNoResponders: options.onNoResponders } : {},
    );
  }

  private fakeControlRpc(): ControlRpc {
    return {
      request: async (subject, req, opts) => {
        this.sent.push({ subject, req });
        const agentId = subject.split(".")[2] ?? "";
        const instance = subject.split(".")[4] ?? "";
        if (this.sessions.get(agentId) !== instance) {
          return offlineControlResponse(req.requestId, true);
        }
        const upload = await this.uploadStep(req);
        if (upload) return upload;
        const answer = await this.responder.request(subject, req, opts);
        if (answer.error?.code === ErrorCode.ERROR_CODE_UNSUPPORTED) {
          return await this.runner(agentId, instance).request(subject, req, opts);
        }
        return answer;
      },
    };
  }

  opStreamTransport() {
    return this.transport;
  }

  /** The agent's transactional write engine: a begin, chunks and queries
   * must all repeat the begin's epoch exactly; epoch 0 (machine-addressed)
   * only on an agent that advertises it. */
  private async uploadStep(req: ControlRequest): Promise<ControlResponse | null> {
    const op = req.op;
    if (op?.$case === "opStart" && op.opStart.op?.$case === "fsWrite") {
      if (req.epoch === 0 && !this.transactionalMachine) {
        return fenced(req.requestId, "transaction requires a nonzero session epoch");
      }
      this.uploads.set(req.requestId, {
        epoch: req.epoch,
        path: op.opStart.op.fsWrite.path,
        bytes: [],
      });
      return {
        requestId: req.requestId,
        error: undefined,
        result: {
          $case: "opStart",
          opStart: { accepted: true, status: this.uploadStatus(req.requestId) },
        },
      };
    }
    const opId =
      op?.$case === "writeChunk"
        ? op.writeChunk.opId
        : op?.$case === "opQuery" && this.uploads.has(op.opQuery.opId)
          ? op.opQuery.opId
          : null;
    if (opId === null || !op) return null;
    const upload = this.uploads.get(opId);
    if (!upload || upload.epoch !== req.epoch) return fenced(req.requestId, "epoch changed");
    if (op.$case === "writeChunk") {
      upload.bytes.push(...op.writeChunk.bytes);
      if (op.writeChunk.last) {
        await this.responder.request(
          "",
          ControlRequest.fromPartial({
            requestId: crypto.randomUUID(),
            epoch: req.epoch,
            op: {
              $case: "fsWrite",
              fsWrite: { path: upload.path, content: Uint8Array.from(upload.bytes) },
            },
          }),
        );
      }
      return {
        requestId: req.requestId,
        error: undefined,
        result: { $case: "writeChunk", writeChunk: { seq: op.writeChunk.seq } },
      };
    }
    return {
      requestId: req.requestId,
      error: undefined,
      result: { $case: "opStatus", opStatus: this.uploadStatus(opId) },
    };
  }

  private uploadStatus(opId: string): OpStatus {
    const bytes = Uint8Array.from(this.uploads.get(opId)?.bytes ?? []);
    return {
      opId,
      state: OpState.OP_STATE_COMPLETE,
      nextSeq: "0",
      exit: {
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        durationMs: "0",
        digests: { content: fileContentDigest(bytes) },
        totals: { content: String(bytes.byteLength) },
        failureCode: "",
        failureDetail: {},
        backgroundChildrenStopped: false,
      },
      lostReason: OpLostReason.OP_LOST_REASON_UNSPECIFIED,
      writeOffset: String(bytes.byteLength),
    };
  }

  async resolveConnection(input: {
    workspaceId: string;
    enrollmentId: string;
  }): Promise<ComputeAgentConnection | null> {
    const instance = this.sessions.get(input.enrollmentId);
    if (!instance) return null;
    return {
      workspaceId: input.workspaceId,
      connectionInstanceId: instance,
      workspaceRoot: "/workspace",
      opStream: true,
      transactionalFsWriteSupported: this.transactional,
      transactionalFsWriteMachineSupported: this.transactionalMachine,
      browserControlHttpSupported: false,
      runAsSupported: this.runAs,
    };
  }

  async createEnrollment(input: Record<string, unknown>): Promise<void> {
    this.created.push(input);
    this.createdAtMs.set(input.enrollmentId as string, Date.now());
  }

  async revokeEnrollment(input: { workspaceId: string; enrollmentId: string }): Promise<void> {
    this.revoked.push(input.enrollmentId);
    this.sessions.delete(input.enrollmentId);
  }

  /** enrollment id -> when it was created (tests may backdate it). */
  readonly createdAtMs = new Map<string, number>();

  /** Active enrollments (each one may still have a sandbox). */
  active(): string[] {
    return [...this.createdAtMs.keys()].filter((id) => !this.revoked.includes(id));
  }
}

const controls: FakeControlService[] = [];
afterEach(() => {
  for (const control of controls.splice(0)) control.stop();
});

function fenced(requestId: string, message: string): ControlResponse {
  return {
    requestId,
    error: { code: ErrorCode.ERROR_CODE_FENCED, message, retryable: false, detail: {} },
    result: undefined,
  };
}

function agentIdOf(box: FakeSandbox): string {
  return (box.body.init as { agent: { agent_id: string } }).agent.agent_id;
}

function setup(
  options: {
    connectOnCreate?: boolean;
    readyTimeoutMs?: number;
    desktop?: boolean;
    controlTimeoutMs?: number;
    execTimeoutMs?: number;
  } = {},
) {
  const control = new FakeControlService();
  controls.push(control);
  const plane = new FakeAgentPlane();
  // The guest started the agent and its host opened the agent's session.
  control.onCreate = (box) => {
    if (options.connectOnCreate !== false) plane.open(agentIdOf(box));
  };
  const client = new ComputeSandboxClient({
    control: new ComputeControlClient({
      baseUrl: control.url,
      apiKey: "control-key",
      sleep: async () => {},
    }),
    plane: () => plane,
    relay: RELAY,
    gateway: GATEWAY,
    image: "registry.test/compute:1",
    desktop: options.desktop ?? false,
    vcpus: 2,
    memoryMib: 4096,
    readyTimeoutMs: options.readyTimeoutMs ?? 2_000,
    ...(options.controlTimeoutMs !== undefined
      ? { controlTimeoutMs: options.controlTimeoutMs }
      : {}),
    ...(options.execTimeoutMs !== undefined ? { execTimeoutMs: options.execTimeoutMs } : {}),
    environment: { FOO: "bar" },
  });
  return { control, plane, client };
}

const identity = { accountId: ACCOUNT, workspaceId: WORKSPACE, sandboxGroupId: GROUP };

describe("compute sandbox client", () => {
  test("create makes the enrollment, names the agent in the init and waits for it", async () => {
    const { control, plane, client } = setup({ desktop: true });
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    expect(session).toBeInstanceOf(ComputeSandboxSession);
    expect(session.backendId).toBe("compute");
    expect(session.state.instanceId).toBe(session.state.sandboxId);
    expect(session.state.agentId).toBe(session.state.enrollmentId);
    expect(plane.created).toEqual([
      {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        enrollmentId: session.state.enrollmentId,
        sandboxGroupId: GROUP,
        hasDisplay: true,
        workspaceRoot: "/workspace",
      },
    ]);

    const create = control.requests.find((r) => r.method === "POST" && r.path === "/v1/sandboxes");
    const body = create!.body as Record<string, any>;
    expect(create!.apiKey).toBe("control-key");
    expect(body).toEqual({
      request_id: session.state.requestId,
      image: "registry.test/compute:1",
      vcpus: 2,
      memory_mib: 4096,
      metadata: {
        opengeni_gateway: GATEWAY,
        opengeni_workspace_id: WORKSPACE,
        opengeni_sandbox_group_id: GROUP,
        opengeni_enrollment_id: session.state.enrollmentId,
      },
      init: {
        env_vars: { FOO: "bar" },
        default_user: "root",
        default_workdir: "/workspace",
        // No secret: the agent is reached through its host's link.
        agent: {
          workspace_id: WORKSPACE,
          agent_id: session.state.enrollmentId,
          workspace_root: "/workspace",
          desktop: true,
        },
      },
    });
    // The agent answered a probe before create returned, with no wake.
    expect(plane.sent.some((s) => s.req.op?.$case === "ping")).toBe(true);
    expect(control.wakes).toBe(0);

    await session.writeFile({ path: "/workspace/a.txt", content: "hello" });
    expect(new TextDecoder().decode(await session.readFile({ path: "/workspace/a.txt" }))).toBe(
      "hello",
    );
  });

  test("create retries an uncertain control service answer with the same request id and body", async () => {
    const { control, client } = setup();
    control.failCreates = [503, 504];
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const creates = control.requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/sandboxes",
    );
    expect(creates).toHaveLength(3);
    expect(new Set(creates.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect((creates[0]!.body as { request_id: string }).request_id).toBe(session.state.requestId);
    expect(control.boxes.size).toBe(1);
  });

  test("create without a lease identity fails before calling the control service", async () => {
    const { control, plane, client } = setup();
    await expect(client.create(undefined, {})).rejects.toBeInstanceOf(SandboxConfigError);
    expect(control.requests).toHaveLength(0);
    expect(plane.created).toHaveLength(0);
  });

  test("a sandbox whose agent never connects is deleted and its enrollment revoked", async () => {
    const { control, plane, client } = setup({ connectOnCreate: false, readyTimeoutMs: 300 });
    await expect(
      client.create(undefined, { opengeniCreateIdentity: identity }),
    ).rejects.toMatchObject({ code: expect.anything() });
    expect(control.boxes.size).toBe(0);
    expect(control.requests.some((r) => r.method === "DELETE")).toBe(true);
    expect(plane.revoked).toEqual([plane.created[0]!.enrollmentId as string]);
  });

  test("a create whose answer never arrives finds its sandbox by request id and deletes it", async () => {
    const { control, plane, client } = setup();
    control.loseCreateAnswers = true;
    await expect(
      client.create(undefined, { opengeniCreateIdentity: identity }),
    ).rejects.toBeInstanceOf(ComputeControlError);
    expect(
      control.requests.some((r) => r.method === "GET" && r.path.startsWith("/v1/requests/")),
    ).toBe(true);
    expect(control.boxes.size).toBe(0);
    expect(plane.revoked).toEqual([plane.created[0]!.enrollmentId as string]);
  });

  test("the create's request id is its enrollment id", async () => {
    const { client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    expect(session.state.requestId).toBe(session.state.enrollmentId);
  });

  test("a lost create whose cleanup fails is left to the orphan sweep, which removes it", async () => {
    const { control, plane, client } = setup();
    control.loseCreateAnswers = true;
    control.failCleanup = true;
    await expect(
      client.create(undefined, { opengeniCreateIdentity: identity }),
    ).rejects.toBeInstanceOf(ComputeControlError);
    // The control service holds a sandbox nothing names, and its enrollment is active.
    const orphan = plane.created[0]!.enrollmentId as string;
    expect(control.boxes.size).toBe(1);
    expect(plane.active()).toEqual([orphan]);
    const [box] = control.boxes.values();
    expect(box!.body.metadata).toEqual({
      opengeni_gateway: GATEWAY,
      opengeni_workspace_id: WORKSPACE,
      opengeni_sandbox_group_id: GROUP,
      opengeni_enrollment_id: orphan,
    });

    control.loseCreateAnswers = false;
    control.failCleanup = false;
    const sweep = (nowMs: number) =>
      sweepComputeOrphans({
        control: new ComputeControlClient({ baseUrl: control.url, apiKey: "control-key" }),
        gateway: GATEWAY,
        named: async () => false,
        revokeEnrollment: (input) => plane.revokeEnrollment(input),
        nowMs,
      });
    // Too young: its create may still be committing.
    expect((await sweep(Date.now())).deleted).toEqual([]);
    expect(control.boxes.size).toBe(1);
    const swept = await sweep(Date.now() + 11 * 60_000);
    expect(swept.deleted).toEqual([
      {
        sandboxId: box!.id,
        workspaceId: WORKSPACE,
        sandboxGroupId: GROUP,
        enrollmentId: orphan,
      },
    ]);
    expect(control.boxes.size).toBe(0);
    expect(plane.revoked).toEqual([orphan]);
  });

  test("the orphan sweep keeps named sandboxes and never touches another deployment's", async () => {
    const { control, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const other = crypto.randomUUID();
    control.boxes.set("sbx-other", {
      id: "sbx-other",
      body: {
        metadata: {
          opengeni_gateway: "wss://another-deployment.test/v1/compute/agent-link",
          opengeni_workspace_id: WORKSPACE,
          opengeni_sandbox_group_id: GROUP,
          opengeni_enrollment_id: other,
        },
        init: { agent: { workspace_id: WORKSPACE, agent_id: other } },
      },
    });
    const asked: string[] = [];
    setSelfhostedApplyDiff(applyDiff);
    const sentBefore = plane.sent.length;
    const result = await sweepComputeOrphans({
      control: new ComputeControlClient({ baseUrl: control.url, apiKey: "control-key" }),
      gateway: GATEWAY,
      named: async (sandbox) => {
        asked.push(sandbox.sandboxId);
        return sandbox.enrollmentId === session.state.enrollmentId;
      },
      revokeEnrollment: (input) => plane.revokeEnrollment(input),
      nowMs: Date.now() + 11 * 60_000,
    });
    expect(asked).toEqual([session.state.sandboxId]);
    expect(result).toEqual({ examined: 1, deleted: [], failed: 0 });
    expect([...control.boxes.keys()].sort()).toEqual(["sbx-other", session.state.sandboxId].sort());
    // The sweep never messages an agent.
    expect(plane.sent).toHaveLength(sentBefore);
  });

  test("an orphan whose delete fails is revoked, counted and kept for the next sweep", async () => {
    const { control, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    control.failCleanup = true;
    const sweep = () =>
      sweepComputeOrphans({
        control: new ComputeControlClient({
          baseUrl: control.url,
          apiKey: "control-key",
          sleep: async () => {},
        }),
        gateway: GATEWAY,
        named: async () => false,
        revokeEnrollment: (input) => plane.revokeEnrollment(input),
        nowMs: Date.now() + 11 * 60_000,
      });
    expect(await sweep()).toMatchObject({ examined: 1, deleted: [], failed: 1 });
    // Revoked first: the sandbox is still listed, so the next sweep owns it.
    expect(plane.revoked).toEqual([session.state.enrollmentId]);
    expect(control.boxes.size).toBe(1);
    // A pass deletes at most its limit; the next pass continues.
    control.failCleanup = false;
    const capped = await sweepComputeOrphans({
      control: new ComputeControlClient({ baseUrl: control.url, apiKey: "control-key" }),
      gateway: GATEWAY,
      named: async () => false,
      revokeEnrollment: (input) => plane.revokeEnrollment(input),
      nowMs: Date.now() + 11 * 60_000,
      maxDeletions: 0,
    });
    expect(capped.deleted).toEqual([]);
    expect(control.boxes.size).toBe(1);
    control.failCleanup = false;
    expect((await sweep()).deleted).toHaveLength(1);
    expect(control.boxes.size).toBe(0);
  });

  test("an orphan whose revoke fails is not deleted, so the next sweep still owns it", async () => {
    const { control } = setup();
    const enrollmentId = crypto.randomUUID();
    control.addOrphan("sbx-orphan", enrollmentId);
    const revoked: string[] = [];
    let revokeFails = true;
    const sweep = () =>
      sweepComputeOrphans({
        control: new ComputeControlClient({ baseUrl: control.url, apiKey: "control-key" }),
        gateway: GATEWAY,
        named: async () => false,
        revokeEnrollment: async (input) => {
          if (revokeFails) throw new Error("database unavailable");
          revoked.push(input.enrollmentId);
        },
      });
    expect(await sweep()).toMatchObject({ examined: 1, deleted: [], failed: 1 });
    expect(control.boxes.has("sbx-orphan")).toBe(true);
    expect(control.requests.some((r) => r.method === "DELETE")).toBe(false);
    revokeFails = false;
    expect((await sweep()).deleted).toHaveLength(1);
    expect(revoked).toEqual([enrollmentId]);
    expect(control.boxes.size).toBe(0);
  });

  test("one stalled delete never holds up the other orphans, and the sweep ends with its signal", async () => {
    const { control } = setup();
    for (const id of ["sbx-a", "sbx-stuck", "sbx-b", "sbx-c"]) control.addOrphan(id);
    control.stallDeletes.add("sbx-stuck");
    const budget = new AbortController();
    const controlClient = new ComputeControlClient({
      baseUrl: control.url,
      apiKey: "control-key",
      requestTimeoutMs: 60_000,
      signal: budget.signal,
    });
    const started = Date.now();
    const sweeping = sweepComputeOrphans({
      control: controlClient,
      gateway: GATEWAY,
      named: async () => false,
      revokeEnrollment: async () => {},
      concurrency: 2,
      signal: budget.signal,
    });
    // The healthy siblings are deleted while the stuck delete hangs.
    for (let i = 0; i < 100 && control.boxes.size > 1; i += 1) await Bun.sleep(10);
    expect([...control.boxes.keys()]).toEqual(["sbx-stuck"]);
    budget.abort();
    const result = await sweeping;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.deleted.map((d) => d.sandboxId).sort()).toEqual(["sbx-a", "sbx-b", "sbx-c"]);
    // The stop abandoned the stuck delete; it is not a failure to defer.
    expect(result.failed).toBe(0);
    // An aborted signal starts nothing new.
    control.stallDeletes.clear();
    const after = await sweepComputeOrphans({
      control: controlClient,
      gateway: GATEWAY,
      named: async () => false,
      revokeEnrollment: async () => {},
      signal: budget.signal,
    });
    expect(after).toEqual({ examined: 0, deleted: [], failed: 0 });
    expect(control.boxes.has("sbx-stuck")).toBe(true);
  });

  test("a prefix of failing orphans never starves the healthy ones behind it", async () => {
    const { control } = setup();
    const ids = Array.from({ length: 57 }, (_, i) => `sbx-${String(i).padStart(3, "0")}`);
    for (const id of ids) control.addOrphan(id);
    // With the production limit, 56 failing deletes ahead of one healthy one.
    for (const id of ids.slice(0, 56)) control.failDeletes.add(id);
    const progress = createComputeOrphanSweepProgress();
    const startedAt = Date.now();
    const sweep = (nowMs: number) =>
      sweepComputeOrphans({
        control: new ComputeControlClient({
          baseUrl: control.url,
          apiKey: "control-key",
          maxAttempts: 1,
        }),
        gateway: GATEWAY,
        named: async () => false,
        revokeEnrollment: async () => {},
        nowMs,
        progress,
      });
    const first = await sweep(startedAt);
    expect(first.failed).toBe(COMPUTE_ORPHAN_SWEEP_LIMIT);
    expect(first.deleted).toEqual([]);
    // The next pass (one sweep interval later) reaches the rest.
    const second = await sweep(startedAt + 5 * 60_000);
    expect(second.deleted.map((d) => d.sandboxId)).toEqual(["sbx-056"]);
    expect(second.failed).toBe(6);
    // Failed candidates come back once their retry time has passed.
    control.failDeletes.clear();
    expect((await sweep(startedAt + 5 * 60_000 + 1)).deleted).toEqual([]);
    const later = await sweep(startedAt + 30 * 60_000);
    expect(later.deleted).toHaveLength(COMPUTE_ORPHAN_SWEEP_LIMIT);
    expect(control.boxes.size).toBe(6);
    // Only the six not reached yet still carry their earlier failure.
    expect(progress.failures.size).toBe(6);
  });

  test("each pass resumes after the last orphan the previous one reached", async () => {
    const { control } = setup();
    for (const id of ["sbx-a", "sbx-b", "sbx-c"]) control.addOrphan(id);
    const progress = createComputeOrphanSweepProgress();
    const reached: string[] = [];
    const sweep = () =>
      sweepComputeOrphans({
        control: new ComputeControlClient({ baseUrl: control.url, apiKey: "control-key" }),
        gateway: GATEWAY,
        named: async (orphan) => {
          reached.push(orphan.sandboxId);
          return true;
        },
        revokeEnrollment: async () => {},
        concurrency: 1,
        maxDeletions: 1,
        progress,
      });
    const stop = new AbortController();
    // A pass stopped after its first check leaves the rest to the next one.
    await sweepComputeOrphans({
      control: new ComputeControlClient({ baseUrl: control.url, apiKey: "control-key" }),
      gateway: GATEWAY,
      named: async (orphan) => {
        reached.push(orphan.sandboxId);
        stop.abort();
        return true;
      },
      revokeEnrollment: async () => {},
      concurrency: 1,
      signal: stop.signal,
      progress,
    });
    expect(reached).toEqual(["sbx-a"]);
    await sweep();
    expect(reached).toEqual(["sbx-a", "sbx-b", "sbx-c", "sbx-a"]);
    await sweep();
    expect(reached.slice(4)).toEqual(["sbx-b", "sbx-c", "sbx-a"]);
  });

  test("a stopped sweep abandons a database check that waits", async () => {
    const { control } = setup();
    control.addOrphan("sbx-waiting");
    const stop = new AbortController();
    const started = Date.now();
    const sweeping = sweepComputeOrphans({
      control: new ComputeControlClient({ baseUrl: control.url, apiKey: "control-key" }),
      gateway: GATEWAY,
      named: () => new Promise<boolean>(() => {}),
      revokeEnrollment: async () => {},
      signal: stop.signal,
    });
    setTimeout(() => stop.abort(), 50);
    expect(await sweeping).toEqual({ examined: 1, deleted: [], failed: 0 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(control.boxes.has("sbx-waiting")).toBe(true);
  });

  test("one stale enrollment stuck on a lock never keeps the others waiting, pass after pass", async () => {
    const listed = ["enr-a", "enr-b", "enr-c"].map((enrollmentId) => ({
      workspaceId: "ws",
      enrollmentId,
    }));
    const progress = createComputeOrphanSweepProgress();
    const attempts: string[] = [];
    // enr-a's workspace stays locked: its revoke fails at its own short
    // deadline. The others revoke at once.
    const reconcile = (nowMs: number, concurrency: number) =>
      reconcileStaleComputeEnrollments({
        list: async () => ({ candidates: listed, more: false }),
        revoke: async (candidate) => {
          attempts.push(candidate.enrollmentId);
          if (candidate.enrollmentId === "enr-a") {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error("The maintenance deadline passed; the database work was rolled back.");
          }
          return true;
        },
        nowMs,
        concurrency,
        progress,
      });
    const startedAt = Date.now();
    const first = await reconcile(startedAt, 1);
    expect(first.revoked.map((r) => r.enrollmentId)).toEqual(["enr-b", "enr-c"]);
    expect(first.failed).toBe(1);
    // The failed one sits out the next pass instead of using it up.
    attempts.length = 0;
    await reconcile(startedAt + 5 * 60_000, 1);
    expect(attempts).toEqual(["enr-b", "enr-c"]);
    // A revoke that never answers holds one slot only, and the pass still ends
    // with its signal.
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    const stuck = await reconcileStaleComputeEnrollments({
      list: async () => ({ candidates: listed, more: false }),
      revoke: async (candidate) =>
        candidate.enrollmentId === "enr-a" ? await new Promise<boolean>(() => {}) : true,
      concurrency: 2,
      signal: stop.signal,
    });
    expect(stuck.revoked.map((r) => r.enrollmentId)).toEqual(["enr-b", "enr-c"]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("stale enrollments that keep failing never hide the ones after them", async () => {
    // The inventory, read a page of three at a time in id order: the first
    // three keep failing, and only the next page holds healthy ones.
    const inventory = ["enr-1", "enr-2", "enr-3", "enr-4", "enr-5"].map((enrollmentId) => ({
      workspaceId: "ws",
      enrollmentId,
    }));
    const list = async (after: string | undefined) => {
      const rest = inventory.filter((c) => after === undefined || c.enrollmentId > after);
      return { candidates: rest.slice(0, 3), more: rest.length > 3 };
    };
    const progress = createComputeOrphanSweepProgress();
    const attempts: string[] = [];
    const reconcile = (nowMs: number) =>
      reconcileStaleComputeEnrollments({
        list,
        revoke: async (candidate) => {
          attempts.push(candidate.enrollmentId);
          if (["enr-1", "enr-2", "enr-3"].includes(candidate.enrollmentId)) {
            throw new Error("locked");
          }
          inventory.splice(
            inventory.findIndex((c) => c.enrollmentId === candidate.enrollmentId),
            1,
          );
          return true;
        },
        nowMs,
        progress,
      });
    const startedAt = Date.now();
    const first = await reconcile(startedAt);
    expect(first).toMatchObject({ examined: 3, failed: 3, revoked: [] });
    // Even straight away, before any failure may retry, the next pass reads
    // the page after the failures.
    const second = await reconcile(startedAt + 1);
    expect(second.revoked.map((r) => r.enrollmentId)).toEqual(["enr-4", "enr-5"]);
    // Then it starts again at the beginning, where the failures sit out
    // their retry delay.
    attempts.length = 0;
    const third = await reconcile(startedAt + 2);
    expect(third).toMatchObject({ examined: 3, failed: 0, revoked: [] });
    expect(attempts).toEqual([]);
  });

  test("deleting a sandbox revokes its enrollment only after the control service delete", async () => {
    const { control, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    control.failCleanup = true;
    await expect(client.delete(session.state)).rejects.toBeInstanceOf(ComputeControlError);
    // Still on record: the drain's retry (or the orphan sweep) finishes it.
    expect(plane.active()).toEqual([session.state.enrollmentId]);
    control.failCleanup = false;
    await client.delete(session.state);
    expect(plane.revoked).toEqual([session.state.enrollmentId]);
    expect(control.boxes.size).toBe(0);
    // A retry after success is still success.
    await client.delete(session.state);
  });

  test("a sleeping sandbox is reached through its open session without a wake from the control service", async () => {
    const { control, client } = setup();
    const created = await client.create(undefined, { opengeniCreateIdentity: identity });
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(created.state),
    );
    // Asleep on the control service: the host keeps its session open and wakes it on
    // the message itself. Resume does nothing but check the sandbox exists.
    const resumed = await client.resumeExact(state);
    await resumed.writeFile({ path: "/workspace/b.txt", content: "x" });
    expect(control.wakes).toBe(0);
  });

  test("a sandbox no host serves is woken through the control service and the request resent", async () => {
    const { control, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await session.writeFile({ path: "/workspace/c.txt", content: "c" });
    const instance = plane.sessions.get(session.state.enrollmentId)!;
    // The host was lost: the session is gone but its claim has not lapsed, so
    // the connection still resolves and the request finds no responder.
    plane.sessions.set(session.state.enrollmentId, "lost");
    const lostResolve = plane.resolveConnection.bind(plane);
    plane.resolveConnection = async (input) => {
      const connection = await lostResolve(input);
      return connection ? { ...connection, connectionInstanceId: instance } : null;
    };
    // The wake places and adopts it; the new host reopens the same instance.
    control.onWake = () => plane.open(session.state.enrollmentId, instance);
    setSelfhostedApplyDiff(applyDiff);
    const sentBefore = plane.sent.length;

    const bytes = await session.readFile({ path: "/workspace/c.txt" });
    expect(new TextDecoder().decode(bytes)).toBe("c");
    expect(control.wakes).toBe(1);
    const reads = plane.sent.slice(sentBefore).filter((s) => s.req.op?.$case === "fsRead");
    // The first read reached no responder; the resend carries the same request id.
    expect(reads.length).toBe(2);
    expect(reads[1]!.req.requestId).toBe(reads[0]!.req.requestId);
  });

  test("no responders on the real replay transport wakes the sandbox at once", async () => {
    const { control, plane, client } = setup();
    plane.natsTransport = true;
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await session.writeFile({ path: "/workspace/e.txt", content: "e" });
    const instance = plane.sessions.get(session.state.enrollmentId)!;
    // The host was lost while the claim has not lapsed: the connection still
    // resolves and every delivery finds no responder until the sandbox wakes.
    plane.sessions.set(session.state.enrollmentId, "lost");
    const lostResolve = plane.resolveConnection.bind(plane);
    plane.resolveConnection = async (input) => {
      const connection = await lostResolve(input);
      return connection ? { ...connection, connectionInstanceId: instance } : null;
    };
    control.onWake = () => plane.open(session.state.enrollmentId, instance);
    const before = plane.natsSubjects.length;
    const started = Date.now();

    const bytes = await session.readFile({ path: "/workspace/e.txt" });
    expect(new TextDecoder().decode(bytes)).toBe("e");
    expect(control.wakes).toBe(1);
    // Woken on the first "no responders", not after the transport's recovery
    // allowance (minutes).
    expect(Date.now() - started).toBeLessThan(3_000);
    // Every attempt was the same delivery: its replay identity was kept.
    const deliveries = plane.natsSubjects.slice(before);
    expect(deliveries.length).toBeGreaterThanOrEqual(2);
    expect(new Set(deliveries).size).toBe(1);
    expect(deliveries[0]).toContain(".replay.");
  });

  test("no responders stops retrying at once when the agent is back on another connection", async () => {
    const { control, plane, client } = setup();
    plane.natsTransport = true;
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await session.writeFile({ path: "/workspace/f.txt", content: "f" });
    const old = plane.sessions.get(session.state.enrollmentId)!;
    plane.sessions.set(session.state.enrollmentId, "lost");
    const lostResolve = plane.resolveConnection.bind(plane);
    let restarted = false;
    plane.resolveConnection = async (input) => {
      const connection = await lostResolve(input);
      return connection && !restarted ? { ...connection, connectionInstanceId: old } : connection;
    };
    // The wake cold-boots it: the agent restarted with a new instance.
    control.onWake = () => {
      restarted = true;
      plane.open(session.state.enrollmentId);
    };
    const started = Date.now();
    expect(new TextDecoder().decode(await session.readFile({ path: "/workspace/f.txt" }))).toBe(
      "f",
    );
    expect(control.wakes).toBe(1);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a sandbox with no open session is woken before the operation is sent", async () => {
    const { control, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    plane.sessions.delete(session.state.enrollmentId);
    // Adopted elsewhere after the wake: the agent restarted with a new instance.
    control.onWake = () => plane.open(session.state.enrollmentId);
    await session.writeFile({ path: "/workspace/d.txt", content: "d" });
    expect(control.wakes).toBe(1);
    expect(new TextDecoder().decode(await session.readFile({ path: "/workspace/d.txt" }))).toBe(
      "d",
    );
  });

  test("commands run over the agent's op-stream", async () => {
    const { client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const result = await session.exec({ cmd: "echo hi" });
    expect(result.exitCode).toBe(0);
  });

  test("a manifest applied as another user carries runAs when the agent supports it", async () => {
    const { plane, client } = setup();
    plane.runAs = true;
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await session.materializeEntry({
      path: "project",
      entry: { type: "dir", permissions: "drwxr-x---" } as never,
      runAs: "builder",
    });
    await session.writeFile({ path: "/workspace/project/a.txt", content: "x", runAs: "builder" });
    expect(plane.execs.filter((e) => e.runAs === "builder").map((e) => e.cmd)).toEqual([
      "mkdir -p -- '/workspace/project'",
      "chmod 750 -- '/workspace/project'",
    ]);
    const write = plane.sent.find((s) => s.req.op?.$case === "fsWrite")?.req.op;
    expect(write?.$case === "fsWrite" && write.fsWrite.runAs).toBe("builder");
  });

  test("a manifest applied as another user is refused when the agent lacks runAs", async () => {
    const { plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await expect(
      session.materializeEntry({
        path: "project",
        entry: { type: "dir" } as never,
        runAs: "builder",
      }),
    ).rejects.toThrow("does not support runAs");
    expect(plane.execs).toEqual([]);
  });

  test("runAs is refused, never dropped, when the agent stops advertising it after a check", async () => {
    const { plane, client } = setup();
    plane.runAs = true;
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const resolve = plane.resolveConnection.bind(plane);
    // The capability check sees run-as; the agent then reconnects without it
    // before the command is dispatched.
    plane.resolveConnection = async (input) => {
      const connection = await resolve(input);
      plane.runAs = false;
      return connection;
    };
    await expect(
      session.materializeEntry({
        path: "project",
        entry: { type: "dir" } as never,
        runAs: "builder",
      }),
    ).rejects.toThrow("does not support runAs");
    expect(plane.execs).toEqual([]);
    // A compute agent runs as root: every other runAs operation is refused
    // rather than run as root, and nothing reaches the agent.
    setSelfhostedApplyDiff(applyDiff);
    const sentBefore = plane.sent.length;
    for (const attempt of [
      () => session.exec({ cmd: "id -u", runAs: "builder" }),
      () => session.readFile({ path: "/workspace/a.txt", runAs: "builder" }),
      () => session.writeFile({ path: "/workspace/a.txt", content: "x", runAs: "builder" }),
      () => session.createEditor("builder").deleteFile({ path: "a.txt" }),
    ]) {
      await expect(attempt()).rejects.toThrow("runAs");
    }
    expect(plane.execs).toEqual([]);
    expect(plane.sent.length).toBe(sentBefore);
  });

  test("a transactional runAs write is refused when the same agent stops advertising run-as before begin", async () => {
    const { plane, client } = setup();
    plane.runAs = true;
    plane.transactional = true;
    plane.transactionalMachine = true;
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const instance = plane.sessions.get(session.state.enrollmentId);
    const before = plane.sent.length;
    const resolve = plane.resolveConnection.bind(plane);
    // The write's own admission and its base-content check see run-as; the same
    // connection then stops advertising it right before the transfer begins.
    plane.resolveConnection = async (input) => {
      if (plane.sent.slice(before).some((s) => s.req.op?.$case === "fsStat")) plane.runAs = false;
      return await resolve(input);
    };
    await expect(
      session.writeFile({
        path: "/workspace/big.txt",
        content: "x".repeat(300 * 1024),
        runAs: "builder",
      }),
    ).rejects.toThrow("runAs");
    expect(plane.sessions.get(session.state.enrollmentId)).toBe(instance);
    expect(plane.uploads.size).toBe(0);
    expect(plane.sent.slice(before).some((s) => s.req.op?.$case === "opStart")).toBe(false);
  });

  test("resumeExact of a sandbox the control service no longer has is an unavailable instance", async () => {
    const { client } = setup();
    const created = await client.create(undefined, { opengeniCreateIdentity: identity });
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(created.state),
    );
    await client.delete(state);
    await expect(client.resumeExact(state)).rejects.toBeInstanceOf(
      SandboxExactResumeInstanceUnavailableError,
    );
  });

  test("delete removes the sandbox and revokes its enrollment, and is idempotent", async () => {
    const { control, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await session.delete();
    await session.delete();
    expect(control.boxes.size).toBe(0);
    expect(plane.revoked).toEqual([session.state.enrollmentId, session.state.enrollmentId]);
  });

  test("serialized state round-trips the sandbox and enrollment identity", async () => {
    const { client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const serialized = await client.serializeSessionState(session.state);
    expect(serialized).toMatchObject({
      stateVersion: 1,
      sandboxId: session.state.sandboxId,
      enrollmentId: session.state.enrollmentId,
      workspaceId: WORKSPACE,
      accountId: ACCOUNT,
      sandboxGroupId: GROUP,
      workspacePersistence: "tar",
    });
    const restored = await client.deserializeSessionState(JSON.parse(JSON.stringify(serialized)));
    expect(restored.sandboxId).toBe(session.state.sandboxId);
    expect(restored.manifest.root).toBe("/workspace");
    await expect(
      client.deserializeSessionState({ ...serialized, stateVersion: 2 }),
    ).rejects.toBeInstanceOf(SandboxConfigError);
  });

  test("the lease envelope names the sandbox and enrollment where the sweeps look", async () => {
    // The stale-enrollment inventory, its revoke and the orphan sweep's record
    // check read sessionState.providerState.{enrollmentId,sandboxId} of the
    // lease envelope; this is the shape the worker persists.
    const { client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const envelope = await serializeEstablishedSandboxEnvelope({
      client,
      session,
      sessionState: session.state,
      instanceId: session.state.sandboxId,
      backendId: client.backendId,
    });
    expect(envelope).toMatchObject({
      backendId: "compute",
      sessionState: {
        providerState: {
          sandboxId: session.state.sandboxId,
          enrollmentId: session.state.enrollmentId,
        },
      },
    });
  });

  test("a turn binding shares the sandbox state and wake gate", async () => {
    const { client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const bound = session.bindTurn({ terminalScopeId: "chat-1" });
    expect(bound.state).toBe(session.state);
    expect(bound.gate).toBe(session.gate);
    expect(bound.backendId).toBe("compute");
  });

  test("large writes are machine-addressed transactions under one exact epoch", async () => {
    const { client, plane } = setup();
    plane.transactional = true;
    plane.transactionalMachine = true;
    // Larger than one chunk, so the agent's transactional upload engine runs.
    const big = "x".repeat(300 * 1024);
    const session = await client.create(
      {
        manifest: new Manifest({
          root: "/workspace",
          entries: { "setup.txt": { type: "file", content: big } },
        }),
      },
      { opengeniCreateIdentity: identity },
    );
    await session.bindTurn({}).writeFile({ path: "/workspace/turn.txt", content: big });
    const resumed = await client.resume(await client.serializeSessionState(session.state));
    await resumed.writeFile({ path: "/workspace/later.txt", content: big });

    for (const name of ["setup.txt", "turn.txt", "later.txt"]) {
      const read = await resumed.readFile({ path: `/workspace/${name}` });
      expect(read.byteLength).toBe(big.length);
    }
    // The manifest writes in chunks; the two large writes were transactions.
    expect(plane.uploads.size).toBe(2);
    expect(plane.sent.every((s) => s.req.epoch === 0)).toBe(true);
  });

  test("an agent without machine-addressed transactions refuses large writes up front", async () => {
    const { client, plane } = setup();
    plane.transactional = true;
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await session.writeFile({ path: "/workspace/small.txt", content: "fits" });
    const error = await session
      .writeFile({ path: "/workspace/big.txt", content: "x".repeat(300 * 1024) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SelfhostedControlError);
    expect(plane.uploads.size).toBe(0);
  });

  test("a session whose sandbox was deleted reaches no agent", async () => {
    const { client, plane } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await client.delete(await client.serializeSessionState(session.state));
    const sent = plane.sent.length;
    const error = await session
      .writeFile({ path: "/workspace/late.txt", content: "stale" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(plane.sent.slice(sent).some((s) => s.req.op?.$case === "fsWrite")).toBe(false);
  });
});

describe("compute control service client", () => {
  test("maps error codes to typed kinds and only retries retryable ones", async () => {
    const control = new FakeControlService();
    controls.push(control);
    const wrongKey = new ComputeControlClient({
      baseUrl: control.url,
      apiKey: "wrong",
      sleep: async () => {},
    });
    const error = await wrongKey.get("nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputeControlError);
    expect((error as ComputeControlError).kind).toBe("unauthorized");
    expect((error as ComputeControlError).retryable).toBe(false);
    expect(control.requests).toHaveLength(1);

    const client = new ComputeControlClient({
      baseUrl: control.url,
      apiKey: "control-key",
      sleep: async () => {},
    });
    const body = {
      request_id: "req-1",
      vcpus: 1,
      memory_mib: 512,
      metadata: {},
      init: {
        env_vars: {},
        agent: {
          workspace_id: WORKSPACE,
          agent_id: "a",
          workspace_root: "/workspace",
          desktop: false,
        },
      },
    };
    const view = await client.create(body);
    const mismatch = await client.create({ ...body, vcpus: 2 }).catch((e: unknown) => e);
    expect((mismatch as ComputeControlError).kind).toBe("request_mismatch");
    expect((mismatch as ComputeControlError).retryable).toBe(false);
    await client.delete(view.id);
    const gone = await client.create(body).catch((e: unknown) => e);
    expect((gone as ComputeControlError).kind).toBe("request_gone");
  });

  test("a body that stalls after the headers ends with the timeout or the caller's signal", async () => {
    let status = 200;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              // Headers and a first byte, then nothing more.
              controller.enqueue(new TextEncoder().encode(status === 200 ? "[" : "{"));
            },
          }),
          { status, headers: { "content-type": "application/json" } },
        ),
    });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      let started = Date.now();
      const timedOut = await new ComputeControlClient({
        baseUrl,
        apiKey: "control-key",
        requestTimeoutMs: 200,
        maxAttempts: 1,
      })
        .list({})
        .catch((e: unknown) => e);
      expect(timedOut).toBeInstanceOf(ComputeControlError);
      expect((timedOut as ComputeControlError).kind).toBe("transport");
      expect(Date.now() - started).toBeLessThan(3_000);

      const stop = new AbortController();
      setTimeout(() => stop.abort(), 100);
      started = Date.now();
      const stopped = await new ComputeControlClient({
        baseUrl,
        apiKey: "control-key",
        requestTimeoutMs: 60_000,
        signal: stop.signal,
      })
        .list({})
        .catch((e: unknown) => e);
      expect(stopped).toBeInstanceOf(ComputeControlError);
      expect(Date.now() - started).toBeLessThan(3_000);

      // An error answer whose body stalls still ends, with its status.
      status = 503;
      started = Date.now();
      const failed = await new ComputeControlClient({
        baseUrl,
        apiKey: "control-key",
        requestTimeoutMs: 200,
        maxAttempts: 1,
      })
        .delete("sbx")
        .catch((e: unknown) => e);
      expect((failed as ComputeControlError).status).toBe(503);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await server.stop(true);
    }
  });

  test("delete of an absent sandbox succeeds; request lookups and link keys", async () => {
    const control = new FakeControlService();
    controls.push(control);
    const client = new ComputeControlClient({ baseUrl: control.url, apiKey: "control-key" });
    await client.delete("gone");
    expect(await client.lookupRequest("never")).toEqual({ state: "none" });
    const view = await client.create({
      request_id: "req-2",
      vcpus: 1,
      memory_mib: 512,
      metadata: {},
      init: {
        env_vars: {},
        agent: {
          workspace_id: WORKSPACE,
          agent_id: "a",
          workspace_root: "/workspace",
          desktop: false,
        },
      },
    });
    expect(await client.lookupRequest("req-2")).toMatchObject({
      state: "live",
      sandbox: { id: view.id, agent: { workspace: WORKSPACE, agent: "a" } },
    });
    await client.delete(view.id);
    expect(await client.lookupRequest("req-2")).toEqual({ state: "gone" });
    expect(await client.linkKeys()).toEqual({ team: "opengeni", keys: [] });
  });
});

describe("compute at the transport points", () => {
  test("compute and Connected Machines use the agent transport; managed providers do not", () => {
    expect(usesAgentTransport("compute")).toBe(true);
    expect(usesAgentTransport("selfhosted")).toBe(true);
    expect(usesAgentTransport("modal")).toBe(false);
    expect(usesAgentTransport(null)).toBe(false);
  });

  test("only the control service's proof that the sandbox is gone counts as provider loss", () => {
    const gone = new SandboxExactResumeInstanceUnavailableError("compute", "sbx-1");
    expect(classifyProviderSandboxFailure("compute", gone).kind).toBe("not_found");
    expect(isProviderSandboxGoneDuringRoutedOperation("compute", gone)).toBe(true);
    // The agent's own not-found and offline answers concern files and
    // connections, never the sandbox.
    const fileMissing = Object.assign(new Error("No such file"), {
      status: 404,
      code: "NOT_FOUND",
    });
    expect(classifyProviderSandboxFailure("compute", fileMissing).kind).toBe("other");
    const offline = new SelfhostedControlError({
      message: "agent offline",
      code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
      reason: "agent_offline",
      retryable: false,
    });
    expect(classifyProviderSandboxFailure("compute", offline).kind).toBe("other");
    expect(isProviderSandboxGoneDuringRoutedOperation("compute", offline)).toBe(false);
  });

  test("a compute desktop is the agent's relay framebuffer", () => {
    const caps = negotiateCapabilities({
      sessionId: "00000000-0000-0000-0000-000000000001",
      backend: "compute",
      os: "linux",
      liveness: "warm",
      leaseEpoch: 1,
      desktopEnabled: true,
    });
    expect(caps.DesktopStream.transport).toBe("relay-frames");
    expect(caps.DesktopStream.client).toBe("frames");
    expect(caps.DesktopStream.mode).toBe("read-only");
    const modal = negotiateCapabilities({
      sessionId: "00000000-0000-0000-0000-000000000001",
      backend: "modal",
      os: "linux",
      liveness: "warm",
      leaseEpoch: 1,
      desktopEnabled: true,
    });
    expect(modal.DesktopStream.transport).toBe("vnc-ws");
  });
});

describe("waking a compute sandbox for an exact-locator request", () => {
  const ENROLLMENT = "44444444-4444-4444-8444-444444444444";
  const subject = `agent.${WORKSPACE}.${ENROLLMENT}.connection.launch.rpc`;

  test("wakes the enrollment's sandbox at most once per interval and keeps retrying", async () => {
    let nowMs = 0;
    const wakes: string[] = [];
    const lookups: Array<{ workspaceId: string; enrollmentId: string }> = [];
    const onNoResponders = wakeComputeSandboxOnNoResponders({
      control: {
        wake: async (sandboxId) => {
          wakes.push(sandboxId);
          return {} as never;
        },
      },
      sandboxOf: async (agent) => {
        lookups.push(agent);
        return "box-1";
      },
      connectionCurrent: async () => true,
      now: () => nowMs,
    });
    expect(await onNoResponders(subject)).toBe(true);
    nowMs = 1_000;
    expect(await onNoResponders(subject)).toBe(true);
    nowMs = 6_000;
    expect(await onNoResponders(subject)).toBe(true);
    expect(wakes).toEqual(["box-1", "box-1"]);
    expect(lookups).toEqual([{ workspaceId: WORKSPACE, enrollmentId: ENROLLMENT }]);
  });

  test("a Connected Machine is never woken; a deleted sandbox stops the retries", async () => {
    const wakes: string[] = [];
    const machine = wakeComputeSandboxOnNoResponders({
      control: {
        wake: async (sandboxId) => {
          wakes.push(sandboxId);
          return {} as never;
        },
      },
      sandboxOf: async () => null,
      connectionCurrent: async () => true,
    });
    expect(await machine(subject)).toBe(true);
    expect(await machine("not.an.agent.subject")).toBe(true);
    expect(wakes).toEqual([]);
    const gone = wakeComputeSandboxOnNoResponders({
      control: {
        wake: async () => {
          throw new ComputeControlError({ kind: "not_found", status: 404, message: "gone" });
        },
      },
      sandboxOf: async () => "box-1",
      connectionCurrent: async () => true,
    });
    expect(await gone(subject)).toBe(false);
  });

  test("a request bound to a replaced connection wakes nothing and stops retrying", async () => {
    const wakes: string[] = [];
    const lookups: unknown[] = [];
    const checked: string[] = [];
    const onNoResponders = wakeComputeSandboxOnNoResponders({
      control: {
        wake: async (sandboxId) => {
          wakes.push(sandboxId);
          return {} as never;
        },
      },
      sandboxOf: async (agent) => {
        lookups.push(agent);
        return "box-1";
      },
      connectionCurrent: async (asked) => {
        checked.push(asked);
        return false;
      },
    });
    expect(await onNoResponders(subject)).toBe(false);
    expect(checked).toEqual([subject]);
    expect(wakes).toEqual([]);
    expect(lookups).toEqual([]);
  });

  test("a failed lookup is asked again, and a failed wake keeps retrying", async () => {
    let lookups = 0;
    let nowMs = 0;
    const onNoResponders = wakeComputeSandboxOnNoResponders({
      control: {
        wake: async () => {
          throw new ComputeControlError({ kind: "unavailable", status: 503, message: "busy" });
        },
      },
      sandboxOf: async () => {
        lookups += 1;
        if (lookups === 1) throw new Error("database unavailable");
        return "box-1";
      },
      connectionCurrent: async () => true,
      now: () => nowMs,
    });
    expect(await onNoResponders(subject)).toBe(true);
    nowMs = 10_000;
    expect(await onNoResponders(subject)).toBe(true);
    expect(lookups).toBe(2);
  });
});

describe("an operation whose agent restarts", () => {
  // The VM dies and boots fresh on its disk: the host still takes requests
  // for the old agent connection and holds them, and the new agent comes up
  // with a new connection instance.
  function restartAgent(plane: FakeAgentPlane, agentId: string, afterMs: number): string {
    const old = plane.sessions.get(agentId)!;
    plane.heldInstances.add(old);
    setTimeout(() => plane.open(agentId), afterMs);
    return old;
  }

  test("an exec in flight ends as lost once the new agent is live, and the next one runs", async () => {
    const { plane, client, control } = setup({ controlTimeoutMs: 500, execTimeoutMs: 30_000 });
    plane.natsTransport = true;
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    expect((await session.exec({ cmd: "echo hi" })).exitCode).toBe(0);
    const old = restartAgent(plane, session.state.enrollmentId, 200);
    const startedAt = Date.now();
    const error = await session.exec({ cmd: "echo again" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(String(error)).toMatch(/was replaced/);
    // Well inside the exec's own 30 s timeout and the 120 s recovery allowance.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(control.wakes).toBe(0);
    const next = await session.exec({ cmd: "echo after" });
    expect(next.exitCode).toBe(0);
    expect(plane.sent.at(-1)?.subject.split(".")[4]).not.toBe(old);
  }, 20_000);

  test("a read in flight across the restart is read again from the new agent", async () => {
    const { plane, client, control } = setup({ controlTimeoutMs: 500 });
    plane.natsTransport = true;
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await session.writeFile({ path: "/workspace/r.txt", content: "kept" });
    const old = restartAgent(plane, session.state.enrollmentId, 200);
    const startedAt = Date.now();
    const bytes = await session.readFile({ path: "/workspace/r.txt" });
    expect(new TextDecoder().decode(bytes)).toBe("kept");
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(control.wakes).toBe(0);
    const reads = plane.sent.filter((s) => s.req.op?.$case === "fsRead");
    expect(reads.at(-1)?.subject.split(".")[4]).not.toBe(old);
  }, 20_000);

  test("a request bound to the old connection never wakes the sandbox; one to the live connection does", async () => {
    const { plane, client, control } = setup();
    plane.natsTransport = true;
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    expect((await session.exec({ cmd: "echo hi" })).exitCode).toBe(0);
    const agentId = session.state.enrollmentId;
    const old = plane.sessions.get(agentId)!;
    const oldSubject = `agent.${WORKSPACE}.${agentId}.connection.${old}.rpc`;
    // The VM booted fresh: its new agent holds the connection, and nothing
    // answers the old one.
    const fresh = plane.open(agentId);
    const transportHandler = plane.onNoResponders!;
    expect(await transportHandler(oldSubject)).toBe(false);
    expect(control.wakes).toBe(0);
    // The session-level resend after a no-responder answer stops too.
    const waking = new ComputeWakingControlRpc(
      { request: async (_subject, req) => offlineControlResponse(req.requestId, true) },
      new ComputeWakeGate({
        control: {
          wake: async () => {
            control.wakes += 1;
            return {} as never;
          },
        },
        sandboxId: "box",
        enrollmentId: agentId,
        resolveConnection: async () =>
          await plane.resolveConnection({ workspaceId: WORKSPACE, enrollmentId: agentId }),
        probe: async () => true,
        readyTimeoutMs: 2_000,
      }),
      agentId,
    );
    const answer = await waking.request(oldSubject, pingRequestFor(), { timeoutMs: 100 });
    expect(answer.error?.code).toBe(ErrorCode.ERROR_CODE_AGENT_OFFLINE);
    expect(control.wakes).toBe(0);
    // No host serves the sandbox at all (it sleeps unplaced): the live
    // connection's request wakes it.
    plane.sessions.delete(agentId);
    const liveSubject = `agent.${WORKSPACE}.${agentId}.connection.${fresh}.rpc`;
    expect(await transportHandler(liveSubject)).toBe(true);
    expect(control.wakes).toBe(1);
  }, 20_000);

  test("an exec whose agent never answers ends at its own timeout, start included", async () => {
    const { plane, client } = setup({ controlTimeoutMs: 500, execTimeoutMs: 1_000 });
    plane.natsTransport = true;
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    expect((await session.exec({ cmd: "echo hi" })).exitCode).toBe(0);
    // The same agent connection stays current, but nothing answers on it.
    plane.heldInstances.add(plane.sessions.get(session.state.enrollmentId)!);
    const startedAt = Date.now();
    const error = await session.exec({ cmd: "sleep 600" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 30_000);
});

function pingRequestFor(): ControlRequest {
  return ControlRequest.fromPartial({
    requestId: crypto.randomUUID(),
    op: { $case: "ping", ping: { nonce: "0" } },
  });
}
