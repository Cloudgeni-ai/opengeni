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
  ComputeFabricClient,
  ComputeFabricError,
  ComputeSandboxClient,
  ComputeSandboxSession,
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
} from "../src/sandbox";
import { Manifest } from "@openai/agents/sandbox";
import { fileContentDigest } from "../src/sandbox/selfhosted/file-transfer";
import { FakeOpRunner, InMemoryOpStreamTransport } from "../src/sandbox/selfhosted/op-testing";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
const RELAY = { host: "relay.test", port: 443, tls: true } as const;

type FabricBox = {
  id: string;
  body: Record<string, unknown>;
};

/** An in-process fake of the fabric HTTP API (the subset Opengeni uses). */
class FakeFabric {
  readonly boxes = new Map<string, FabricBox>();
  /** request_id -> sandbox id, kept after a delete (410 request_gone). */
  readonly requestIds = new Map<string, string>();
  readonly requests: Array<{ method: string; path: string; body: unknown; apiKey: string | null }> =
    [];
  wakes = 0;
  /** Answer the next N creates with this status before succeeding. */
  failCreates: number[] = [];
  /** Make the sandbox but never answer a create (every attempt is a 504). */
  loseCreateAnswers = false;
  /** Fail request lookups and deletes (the fabric is unreachable for cleanup). */
  failCleanup = false;
  private readonly server: ReturnType<typeof Bun.serve>;
  /** Called when the fabric wakes a sandbox. */
  onWake: (box: FabricBox) => void = () => {};
  onCreate: (box: FabricBox) => void = () => {};

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
        if (request.headers.get("x-api-key") !== "fabric-key") {
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
            box = { id: `sbx-${this.requestIds.size + 1}`, body };
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
          if (this.failCleanup) {
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

  view(box: FabricBox) {
    const agent = (box.body.init as { agent: { workspace_id: string; agent_id: string } }).agent;
    return {
      id: box.id,
      image: (box.body.image as string | undefined) ?? "default",
      config: {},
      metadata: box.body.metadata,
      agent: { workspace: agent.workspace_id, agent: agent.agent_id },
      host: "h1",
      owner_epoch: 1,
      created_ms: 1,
    };
  }

  stop(): void {
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

  controlRpc(options?: { onNoResponders?: (subject: string) => Promise<boolean> }): ControlRpc {
    const fake = this.fakeControlRpc();
    if (!this.natsTransport) return fake;
    const connection: NatsRequestConnection = {
      supportsHeaders: true,
      request: async (subject, payload, opts) => {
        this.natsSubjects.push(subject);
        const base = subject.split(".replay.")[0]!;
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

  async listGroupEnrollments(): Promise<Array<{ enrollmentId: string; createdAtMs: number }>> {
    return [...this.createdAtMs]
      .filter(([id]) => !this.revoked.includes(id))
      .map(([enrollmentId, createdAtMs]) => ({ enrollmentId, createdAtMs }));
  }

  /** Active enrollments (each one may still have a sandbox). */
  active(): string[] {
    return [...this.createdAtMs.keys()].filter((id) => !this.revoked.includes(id));
  }
}

const fabrics: FakeFabric[] = [];
afterEach(() => {
  for (const fabric of fabrics.splice(0)) fabric.stop();
});

function fenced(requestId: string, message: string): ControlResponse {
  return {
    requestId,
    error: { code: ErrorCode.ERROR_CODE_FENCED, message, retryable: false, detail: {} },
    result: undefined,
  };
}

function agentIdOf(box: FabricBox): string {
  return (box.body.init as { agent: { agent_id: string } }).agent.agent_id;
}

function setup(
  options: { connectOnCreate?: boolean; readyTimeoutMs?: number; desktop?: boolean } = {},
) {
  const fabric = new FakeFabric();
  fabrics.push(fabric);
  const plane = new FakeAgentPlane();
  // The guest started the agent and its host opened the agent's session.
  fabric.onCreate = (box) => {
    if (options.connectOnCreate !== false) plane.open(agentIdOf(box));
  };
  const client = new ComputeSandboxClient({
    fabric: new ComputeFabricClient({
      baseUrl: fabric.url,
      apiKey: "fabric-key",
      sleep: async () => {},
    }),
    plane: () => plane,
    relay: RELAY,
    image: "registry.test/compute:1",
    desktop: options.desktop ?? false,
    vcpus: 2,
    memoryMib: 4096,
    readyTimeoutMs: options.readyTimeoutMs ?? 2_000,
    environment: { FOO: "bar" },
  });
  return { fabric, plane, client };
}

const identity = { accountId: ACCOUNT, workspaceId: WORKSPACE, sandboxGroupId: GROUP };

describe("compute sandbox client", () => {
  test("create makes the enrollment, names the agent in the init and waits for it", async () => {
    const { fabric, plane, client } = setup({ desktop: true });
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

    const create = fabric.requests.find((r) => r.method === "POST" && r.path === "/v1/sandboxes");
    const body = create!.body as Record<string, any>;
    expect(create!.apiKey).toBe("fabric-key");
    expect(body).toEqual({
      request_id: session.state.requestId,
      image: "registry.test/compute:1",
      vcpus: 2,
      memory_mib: 4096,
      metadata: {
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
    expect(fabric.wakes).toBe(0);

    await session.writeFile({ path: "/workspace/a.txt", content: "hello" });
    expect(new TextDecoder().decode(await session.readFile({ path: "/workspace/a.txt" }))).toBe(
      "hello",
    );
  });

  test("create retries an uncertain fabric answer with the same request id and body", async () => {
    const { fabric, client } = setup();
    fabric.failCreates = [503, 504];
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const creates = fabric.requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/sandboxes",
    );
    expect(creates).toHaveLength(3);
    expect(new Set(creates.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect((creates[0]!.body as { request_id: string }).request_id).toBe(session.state.requestId);
    expect(fabric.boxes.size).toBe(1);
  });

  test("create without a lease identity fails before calling the fabric", async () => {
    const { fabric, plane, client } = setup();
    await expect(client.create(undefined, {})).rejects.toBeInstanceOf(SandboxConfigError);
    expect(fabric.requests).toHaveLength(0);
    expect(plane.created).toHaveLength(0);
  });

  test("a sandbox whose agent never connects is deleted and its enrollment revoked", async () => {
    const { fabric, plane, client } = setup({ connectOnCreate: false, readyTimeoutMs: 300 });
    await expect(
      client.create(undefined, { opengeniCreateIdentity: identity }),
    ).rejects.toMatchObject({ code: expect.anything() });
    expect(fabric.boxes.size).toBe(0);
    expect(fabric.requests.some((r) => r.method === "DELETE")).toBe(true);
    expect(plane.revoked).toEqual([plane.created[0]!.enrollmentId as string]);
  });

  test("a create whose answer never arrives finds its sandbox by request id and deletes it", async () => {
    const { fabric, plane, client } = setup();
    fabric.loseCreateAnswers = true;
    await expect(
      client.create(undefined, { opengeniCreateIdentity: identity }),
    ).rejects.toBeInstanceOf(ComputeFabricError);
    expect(
      fabric.requests.some((r) => r.method === "GET" && r.path.startsWith("/v1/requests/")),
    ).toBe(true);
    expect(fabric.boxes.size).toBe(0);
    expect(plane.revoked).toEqual([plane.created[0]!.enrollmentId as string]);
  });

  test("the create's request id is its enrollment id", async () => {
    const { client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    expect(session.state.requestId).toBe(session.state.enrollmentId);
  });

  test("a lost create whose cleanup fails stays on record and the next create removes it", async () => {
    const { fabric, plane, client } = setup();
    fabric.loseCreateAnswers = true;
    fabric.failCleanup = true;
    await expect(
      client.create(undefined, { opengeniCreateIdentity: identity }),
    ).rejects.toBeInstanceOf(ComputeFabricError);
    // The fabric holds a sandbox and its enrollment is still active.
    const orphan = plane.created[0]!.enrollmentId as string;
    expect(fabric.boxes.size).toBe(1);
    expect(plane.revoked).toEqual([]);
    expect(plane.active()).toEqual([orphan]);

    // A worker restart retries the group's create once the fabric is back.
    fabric.loseCreateAnswers = false;
    fabric.failCleanup = false;
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    expect(plane.revoked).toEqual([orphan]);
    expect([...fabric.boxes.keys()]).toEqual([session.state.sandboxId]);
    expect(plane.active()).toEqual([session.state.enrollmentId]);
  });

  test("a recent create the fabric has not seen stays on record; an old one is revoked", async () => {
    const { fabric, plane, client } = setup();
    // Two enrollments whose creates never reached the fabric.
    await plane.createEnrollment({ enrollmentId: "in-flight" });
    await plane.createEnrollment({ enrollmentId: "abandoned" });
    plane.createdAtMs.set("abandoned", Date.now() - 11 * 60_000);
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    expect(plane.revoked).toEqual(["abandoned"]);
    expect(plane.active().sort()).toEqual(["in-flight", session.state.enrollmentId].sort());
    expect(fabric.boxes.size).toBe(1);
  });

  test("deleting a group's sandbox removes older unfinished creates, never newer boxes", async () => {
    const { fabric, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const ownCreatedAt = plane.createdAtMs.get(session.state.enrollmentId)!;
    // An older create whose cleanup never finished, and a newer box (one that
    // replaced this sandbox), both still held by the fabric.
    for (const [id, createdAtMs] of [
      ["older", ownCreatedAt - 60_000],
      ["newer", ownCreatedAt + 60_000],
    ] as const) {
      await plane.createEnrollment({ enrollmentId: id });
      plane.createdAtMs.set(id, createdAtMs);
      fabric.boxes.set(`sbx-${id}`, {
        id: `sbx-${id}`,
        body: { request_id: id, init: { agent: { workspace_id: WORKSPACE, agent_id: id } } },
      });
      fabric.requestIds.set(id, `sbx-${id}`);
    }

    await client.delete(session.state);
    expect(plane.revoked.sort()).toEqual(["older", session.state.enrollmentId].sort());
    expect([...fabric.boxes.keys()]).toEqual(["sbx-newer"]);
  });

  test("a sleeping sandbox is reached through its open session without a fabric wake", async () => {
    const { fabric, client } = setup();
    const created = await client.create(undefined, { opengeniCreateIdentity: identity });
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(created.state),
    );
    // Asleep on the fabric: the host keeps its session open and wakes it on
    // the message itself. Resume does nothing but check the sandbox exists.
    const resumed = await client.resumeExact(state);
    await resumed.writeFile({ path: "/workspace/b.txt", content: "x" });
    expect(fabric.wakes).toBe(0);
  });

  test("a sandbox no host serves is woken through the fabric and the request resent", async () => {
    const { fabric, plane, client } = setup();
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
    fabric.onWake = () => plane.open(session.state.enrollmentId, instance);
    const sentBefore = plane.sent.length;

    const bytes = await session.readFile({ path: "/workspace/c.txt" });
    expect(new TextDecoder().decode(bytes)).toBe("c");
    expect(fabric.wakes).toBe(1);
    const reads = plane.sent.slice(sentBefore).filter((s) => s.req.op?.$case === "fsRead");
    // The first read reached no responder; the resend carries the same request id.
    expect(reads.length).toBe(2);
    expect(reads[1]!.req.requestId).toBe(reads[0]!.req.requestId);
  });

  test("no responders on the real replay transport wakes the sandbox at once", async () => {
    const { fabric, plane, client } = setup();
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
    fabric.onWake = () => plane.open(session.state.enrollmentId, instance);
    const before = plane.natsSubjects.length;
    const started = Date.now();

    const bytes = await session.readFile({ path: "/workspace/e.txt" });
    expect(new TextDecoder().decode(bytes)).toBe("e");
    expect(fabric.wakes).toBe(1);
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
    const { fabric, plane, client } = setup();
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
    fabric.onWake = () => {
      restarted = true;
      plane.open(session.state.enrollmentId);
    };
    const started = Date.now();
    expect(new TextDecoder().decode(await session.readFile({ path: "/workspace/f.txt" }))).toBe(
      "f",
    );
    expect(fabric.wakes).toBe(1);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a sandbox with no open session is woken before the operation is sent", async () => {
    const { fabric, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    plane.sessions.delete(session.state.enrollmentId);
    // Adopted elsewhere after the wake: the agent restarted with a new instance.
    fabric.onWake = () => plane.open(session.state.enrollmentId);
    await session.writeFile({ path: "/workspace/d.txt", content: "d" });
    expect(fabric.wakes).toBe(1);
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

  test("resumeExact of a sandbox the fabric no longer has is an unavailable instance", async () => {
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
    const { fabric, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await session.delete();
    await session.delete();
    expect(fabric.boxes.size).toBe(0);
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

describe("compute fabric client", () => {
  test("maps error codes to typed kinds and only retries retryable ones", async () => {
    const fabric = new FakeFabric();
    fabrics.push(fabric);
    const wrongKey = new ComputeFabricClient({
      baseUrl: fabric.url,
      apiKey: "wrong",
      sleep: async () => {},
    });
    const error = await wrongKey.get("nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputeFabricError);
    expect((error as ComputeFabricError).kind).toBe("unauthorized");
    expect((error as ComputeFabricError).retryable).toBe(false);
    expect(fabric.requests).toHaveLength(1);

    const client = new ComputeFabricClient({
      baseUrl: fabric.url,
      apiKey: "fabric-key",
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
    expect((mismatch as ComputeFabricError).kind).toBe("request_mismatch");
    expect((mismatch as ComputeFabricError).retryable).toBe(false);
    await client.delete(view.id);
    const gone = await client.create(body).catch((e: unknown) => e);
    expect((gone as ComputeFabricError).kind).toBe("request_gone");
  });

  test("delete of an absent sandbox succeeds; request lookups and link keys", async () => {
    const fabric = new FakeFabric();
    fabrics.push(fabric);
    const client = new ComputeFabricClient({ baseUrl: fabric.url, apiKey: "fabric-key" });
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

  test("only the fabric's proof that the sandbox is gone counts as provider loss", () => {
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
