import { afterEach, describe, expect, test } from "bun:test";
import { ErrorCode, type ControlRequest } from "@opengeni/agent-proto";
import { verifyEnrollToken } from "@opengeni/contracts";
import {
  ComputeFabricClient,
  ComputeFabricError,
  ComputeSandboxClient,
  ComputeSandboxSession,
  MockAgentResponder,
  SandboxConfigError,
  SandboxExactResumeInstanceUnavailableError,
  offlineControlResponse,
  type ComputeAgentConnection,
  type ComputeAgentPlane,
  type ControlRpc,
} from "../src/sandbox";
import { FakeOpRunner, InMemoryOpStreamTransport } from "../src/sandbox/selfhosted/op-testing";

const SECRET = "compute-test-enrollment-signing-secret";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
const RELAY = { host: "relay.test", port: 443, tls: true } as const;

type FabricBox = {
  id: string;
  asleep: boolean;
  body: Record<string, unknown>;
};

/** An in-process fake of the fabric HTTP API (the subset Opengeni uses). */
class FakeFabric {
  readonly boxes = new Map<string, FabricBox>();
  readonly requests: Array<{ method: string; path: string; body: unknown; apiKey: string | null }> =
    [];
  wakes = 0;
  /** Answer the next N creates with this status before succeeding. */
  failCreates: number[] = [];
  private readonly server: ReturnType<typeof Bun.serve>;
  /** Called when the fabric wakes a box (the agent reconnects). */
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
        if (request.method === "POST" && url.pathname === "/v1/sandboxes") {
          const status = this.failCreates.shift();
          if (status) return Response.json({ code: "x", message: "try again" }, { status });
          const existing = [...this.boxes.values()].find(
            (box) => box.body.request_id === body.request_id,
          );
          const box = existing ?? {
            id: `sbx-${this.boxes.size + 1}`,
            asleep: false,
            body,
          };
          if (!existing) {
            this.boxes.set(box.id, box);
            this.onCreate(box);
          }
          return Response.json(this.view(box));
        }
        const box = parts[2] ? this.boxes.get(parts[2]) : undefined;
        if (!box) return Response.json({ code: "not_found", message: "no box" }, { status: 404 });
        if (request.method === "POST" && parts[3] === "wake") {
          this.wakes += 1;
          if (box.asleep) {
            box.asleep = false;
            this.onWake(box);
          }
          return Response.json({ waited_us: 10, generation: 1, host: "h1" });
        }
        if (request.method === "GET") return Response.json(this.view(box));
        if (request.method === "DELETE") {
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
    return {
      id: box.id,
      image: (box.body.image as string | undefined) ?? "default",
      config: {},
      metadata: box.body.metadata,
      host: "h1",
      owner_epoch: 1,
      created_ms: 1,
    };
  }

  stop(): void {
    this.server.stop(true);
  }
}

/** The box's agent: online once enrolled and awake; no responder while asleep. */
class FakeAgentPlane implements ComputeAgentPlane {
  readonly transport = new InMemoryOpStreamTransport();
  readonly responder = new MockAgentResponder();
  readonly revoked: string[] = [];
  readonly sent: Array<{ subject: string; req: ControlRequest }> = [];
  enrolled = new Map<string, { instance: string; asleep: () => boolean }>();
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

  controlRpc(): ControlRpc {
    return {
      request: async (subject, req, opts) => {
        this.sent.push({ subject, req });
        const agentId = subject.split(".")[2] ?? "";
        const instance = subject.split(".")[4] ?? "";
        const agent = this.enrolled.get(agentId);
        if (!agent || agent.instance !== instance || agent.asleep()) {
          return offlineControlResponse(req.requestId, true);
        }
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

  async resolveConnection(input: {
    workspaceId: string;
    enrollmentId: string;
  }): Promise<ComputeAgentConnection | null> {
    const agent = this.enrolled.get(input.enrollmentId);
    if (!agent) return null;
    return {
      workspaceId: input.workspaceId,
      connectionInstanceId: agent.instance,
      workspaceRoot: "/workspace",
      opStream: true,
      transactionalFsWriteSupported: false,
      browserControlHttpSupported: false,
    };
  }

  async revokeEnrollment(input: { workspaceId: string; enrollmentId: string }): Promise<void> {
    this.revoked.push(input.enrollmentId);
    this.enrolled.delete(input.enrollmentId);
  }
}

const fabrics: FakeFabric[] = [];
afterEach(() => {
  for (const fabric of fabrics.splice(0)) fabric.stop();
});

function setup(options: { enrollOnCreate?: boolean; readyTimeoutMs?: number } = {}) {
  const fabric = new FakeFabric();
  fabrics.push(fabric);
  const plane = new FakeAgentPlane();
  const sleeping = new Set<string>();
  fabric.onCreate = async (box) => {
    if (options.enrollOnCreate === false) return;
    // The guest's agent exchanges its token: the plane learns the enrollment.
    const token = (box.body.init as { agent: { enroll_token: string } }).agent.enroll_token;
    const claims = await verifyEnrollToken(SECRET, token);
    if (claims?.typ !== "enroll_sandbox") throw new Error("bad token");
    plane.enrolled.set(claims.enrollmentId, {
      instance: crypto.randomUUID(),
      asleep: () => fabric.boxes.get(box.id)?.asleep === true || sleeping.has(box.id),
    });
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
    vcpus: 2,
    memoryMib: 4096,
    agentApiUrl: "https://opengeni.test",
    enrollmentSigningSecret: SECRET,
    readyTimeoutMs: options.readyTimeoutMs ?? 2_000,
    environment: { FOO: "bar" },
  });
  return { fabric, plane, client };
}

const identity = { accountId: ACCOUNT, workspaceId: WORKSPACE, sandboxGroupId: GROUP };

describe("compute sandbox client", () => {
  test("create mints a sandbox enrollment, creates the box and waits for its agent", async () => {
    const { fabric, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    expect(session).toBeInstanceOf(ComputeSandboxSession);
    expect(session.backendId).toBe("compute");
    expect(session.state.instanceId).toBe(session.state.sandboxId);
    expect(session.state.agentId).toBe(session.state.enrollmentId);

    const create = fabric.requests.find((r) => r.method === "POST" && r.path === "/v1/sandboxes");
    const body = create!.body as Record<string, any>;
    expect(create!.apiKey).toBe("fabric-key");
    expect(body.request_id).toBe(session.state.requestId);
    expect(body.image).toBe("registry.test/compute:1");
    expect(body.vcpus).toBe(2);
    expect(body.memory_mib).toBe(4096);
    expect(body.metadata).toEqual({
      opengeni_workspace_id: WORKSPACE,
      opengeni_sandbox_group_id: GROUP,
      opengeni_enrollment_id: session.state.enrollmentId,
      opengeni_request_id: session.state.requestId,
    });
    expect(body.init.env_vars).toEqual({ FOO: "bar" });
    expect(body.init.default_workdir).toBe("/workspace");
    expect(body.init.agent.api_url).toBe("https://opengeni.test");
    expect(body.init.agent.workspace_root).toBe("/workspace");
    const claims = await verifyEnrollToken(SECRET, body.init.agent.enroll_token);
    expect(claims).toMatchObject({
      typ: "enroll_sandbox",
      workspaceId: WORKSPACE,
      accountId: ACCOUNT,
      allowScreenControl: true,
      enrollmentId: session.state.enrollmentId,
      sandboxGroupId: GROUP,
      requestId: session.state.requestId,
    });
    // The agent answered a probe before create returned.
    expect(plane.sent.some((s) => s.req.op?.$case === "ping")).toBe(true);

    await session.writeFile({ path: "/workspace/a.txt", content: "hello" });
    expect(new TextDecoder().decode(await session.readFile({ path: "/workspace/a.txt" }))).toBe(
      "hello",
    );
  });

  test("create retries an uncertain fabric answer with the same request id", async () => {
    const { fabric, client } = setup();
    fabric.failCreates = [503, 504];
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const creates = fabric.requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/sandboxes",
    );
    expect(creates).toHaveLength(3);
    const ids = new Set(creates.map((r) => (r.body as { request_id: string }).request_id));
    expect([...ids]).toEqual([session.state.requestId]);
    expect(fabric.boxes.size).toBe(1);
  });

  test("create without a lease identity fails before calling the fabric", async () => {
    const { fabric, client } = setup();
    await expect(client.create(undefined, {})).rejects.toBeInstanceOf(SandboxConfigError);
    expect(fabric.requests).toHaveLength(0);
  });

  test("a box whose agent never connects is deleted and its enrollment revoked", async () => {
    const { fabric, plane, client } = setup({ enrollOnCreate: false, readyTimeoutMs: 300 });
    await expect(
      client.create(undefined, { opengeniCreateIdentity: identity }),
    ).rejects.toMatchObject({ code: expect.anything() });
    expect(fabric.boxes.size).toBe(0);
    expect(fabric.requests.some((r) => r.method === "DELETE")).toBe(true);
    expect(plane.revoked).toHaveLength(1);
  });

  test("an asleep box is woken before the first operation after resume", async () => {
    const { fabric, client } = setup();
    const created = await client.create(undefined, { opengeniCreateIdentity: identity });
    const serialized = await client.serializeSessionState(created.state);
    fabric.boxes.get(created.state.sandboxId)!.asleep = true;
    const wakesBefore = fabric.wakes;

    const state = await client.deserializeSessionState(serialized);
    const resumed = await client.resumeExact(state);
    await resumed.writeFile({ path: "/workspace/b.txt", content: "x" });
    expect(fabric.wakes).toBe(wakesBefore + 1);
    expect(fabric.boxes.get(created.state.sandboxId)!.asleep).toBe(false);
  });

  test("a box that slept since its agent answered is woken and the request resent unchanged", async () => {
    const { fabric, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await session.writeFile({ path: "/workspace/c.txt", content: "c" });
    // The fabric put the box to sleep behind Opengeni's back.
    fabric.boxes.get(session.state.sandboxId)!.asleep = true;
    const wakesBefore = fabric.wakes;
    const sentBefore = plane.sent.length;

    const bytes = await session.readFile({ path: "/workspace/c.txt" });
    expect(new TextDecoder().decode(bytes)).toBe("c");
    expect(fabric.wakes).toBe(wakesBefore + 1);
    const reads = plane.sent.slice(sentBefore).filter((s) => s.req.op?.$case === "fsRead");
    // The first read reached no responder; the resend carries the same request id.
    expect(reads.length).toBe(2);
    expect(reads[1]!.req.requestId).toBe(reads[0]!.req.requestId);
  });

  test("commands run over the agent's op-stream", async () => {
    const { client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const result = await session.exec({ cmd: "echo hi" });
    expect(result.exitCode).toBe(0);
  });

  test("resumeExact of a box the fabric no longer has is an unavailable instance", async () => {
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

  test("delete removes the box and revokes its enrollment, and is idempotent", async () => {
    const { fabric, plane, client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    await session.delete();
    await session.delete();
    expect(fabric.boxes.size).toBe(0);
    expect(plane.revoked).toEqual([session.state.enrollmentId, session.state.enrollmentId]);
  });

  test("serialized state round-trips the box and enrollment identity", async () => {
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

  test("a turn binding shares the box state and wake gate", async () => {
    const { client } = setup();
    const session = await client.create(undefined, { opengeniCreateIdentity: identity });
    const bound = session.bindTurn({ epoch: 3 });
    expect(bound.state).toBe(session.state);
    expect(bound.gate).toBe(session.gate);
    expect(bound.backendId).toBe("compute");
  });
});

describe("compute fabric client", () => {
  test("maps error statuses to typed kinds and only retries retryable ones", async () => {
    const fabric = new FakeFabric();
    fabrics.push(fabric);
    const client = new ComputeFabricClient({
      baseUrl: fabric.url,
      apiKey: "wrong",
      sleep: async () => {},
    });
    const error = await client.get("nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputeFabricError);
    expect((error as ComputeFabricError).kind).toBe("unauthorized");
    expect((error as ComputeFabricError).retryable).toBe(false);
    expect(fabric.requests).toHaveLength(1);
  });

  test("delete of an absent box succeeds; list sends the metadata query", async () => {
    const fabric = new FakeFabric();
    fabrics.push(fabric);
    const client = new ComputeFabricClient({ baseUrl: fabric.url, apiKey: "fabric-key" });
    await client.delete("gone");
    await client.list({ opengeni_sandbox_group_id: GROUP }).catch(() => undefined);
    expect(fabric.requests.at(-1)!.path).toBe(`/v1/sandboxes?opengeni_sandbox_group_id=${GROUP}`);
  });
});
