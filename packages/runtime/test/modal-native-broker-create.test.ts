import { describe, expect, test } from "bun:test";
import { createModalProviderCreateBoundary } from "../src/sandbox/providers/modal-create-boundary";
import {
  modalNativeBrokerInitialCommand,
  parseModalNativeBrokerCreatePlan,
  readModalNativeBrokerCreate,
} from "../src/sandbox/providers/modal-native-broker-create";

const operationId = "b0a32a91-c42c-425a-a179-cb4fca76a1bb";
const brokerId = "7bd1fc5e-163f-4f1e-b3dc-2cfc3ecbd3d5";
const plan = () =>
  parseModalNativeBrokerCreatePlan({
    version: 1,
    brokerId,
    sourceSha: "b".repeat(40),
    imageId: "im-pinned",
    artifact: { artifactSha256: "c".repeat(64), byteSize: 108144, target: "linux-amd64" },
  });
type Boundary = ReturnType<typeof createModalProviderCreateBoundary>;
async function invoke(
  boundary: Boundary,
  dispatch: (wire: any, options: any) => Promise<unknown>,
  changes = {},
) {
  const iterator = boundary(
    {
      method: { path: "/modal.client.ModalClient/SandboxCreate" },
      requestStream: false,
      responseStream: false,
      request: {
        appId: "ap-fixture",
        tags: [],
        definition: {
          imageId: "im-pinned",
          workdir: "/",
          entrypointArgs: modalNativeBrokerInitialCommand(plan()),
          ...changes,
        },
      },
      // eslint-disable-next-line require-yield -- Unary middleware returns its exact response.
      next: async function* (wire: unknown, options: unknown) {
        return await dispatch(wire, options);
      },
    } as never,
    {},
  );
  let result = await iterator.next();
  while (!result.done) result = await iterator.next();
  return result.value;
}

describe("initial broker physical-create binding", () => {
  test("exact pre-dispatch and returned receipt retain one immutable selected wire proof", async () => {
    let proof: ReturnType<typeof readModalNativeBrokerCreate>;
    const events: string[] = [];
    const boundary = createModalProviderCreateBoundary({
      operationId,
      nativeBroker: plan(),
      beforeDispatch: async (intent) => {
        events.push("admission");
        expect(Object.isFrozen(intent)).toBe(true);
        proof = readModalNativeBrokerCreate(intent);
        expect(proof).toMatchObject({
          plan: plan(),
          operationId,
          requestSha256: intent.requestSha256,
          commandAdmission: false,
        });
        expect(readModalNativeBrokerCreate({ ...intent })).toBeUndefined();
        expect(Object.isFrozen(proof)).toBe(true);
        expect(Object.isFrozen(proof!.plan.artifact)).toBe(true);
      },
      onReceipt: async (receipt) => {
        events.push("receipt");
        expect(readModalNativeBrokerCreate(receipt)).toBe(proof);
        expect(Object.isFrozen(receipt)).toBe(true);
        expect(readModalNativeBrokerCreate({ ...receipt })).toBeUndefined();
      },
    });
    await invoke(boundary, async (wire, options) => {
      events.push("physical");
      expect(wire.definition.entrypointArgs).toEqual(modalNativeBrokerInitialCommand(plan()));
      expect(options.retries).toBe(0);
      return { sandboxId: "sb-exact" };
    });
    expect(events).toEqual(["admission", "physical", "receipt"]);
  });

  test.each([
    { imageId: "im-other" },
    { entrypointArgs: ["sleep", "infinity"] },
    { entrypointArgs: ["sh", "-c", "broker"] },
    { entrypointArgs: [...modalNativeBrokerInitialCommand(plan()), "extra"] },
    {
      entrypointArgs: [
        "/usr/local/bin/opengeni-command-supervisor",
        "broker",
        "--broker-id",
        crypto.randomUUID(),
      ],
    },
    { workdir: "/workspace" },
    { ptyInfo: {} },
    { readinessProbe: {} },
    { volumeMounts: [{ mountPath: "/usr/local/bin" }] },
    { cloudBucketMounts: [{ mountPath: "/usr" }] },
    { volumeMounts: {} },
  ])("rejects a changed initial process before admission/dispatch: %j", async (change) => {
    let admitted = 0,
      dispatched = 0;
    const boundary = createModalProviderCreateBoundary({
      operationId,
      nativeBroker: plan(),
      beforeDispatch: async () => {
        admitted++;
      },
      onReceipt: async () => {},
    });
    await expect(
      invoke(
        boundary,
        async () => {
          dispatched++;
          return { sandboxId: "sb-wrong" };
        },
        change,
      ),
    ).rejects.toThrow("selected initial process");
    expect(admitted).toBe(0);
    expect(dispatched).toBe(0);
  });

  test("ordinary create retains no broker proof and input mutation cannot change selected recipe", async () => {
    const source = structuredClone(plan());
    const boundary = createModalProviderCreateBoundary({
      operationId,
      nativeBroker: source,
      beforeDispatch: async (intent) => {
        expect(readModalNativeBrokerCreate(intent)!.plan.brokerId).toBe(brokerId);
      },
      onReceipt: async () => {},
    });
    Object.assign(source, { brokerId: crypto.randomUUID() });
    await invoke(boundary, async () => ({ sandboxId: "sb-fixture" }));
    const ordinary = createModalProviderCreateBoundary({
      operationId,
      beforeDispatch: async (intent) => {
        expect(readModalNativeBrokerCreate(intent)).toBeUndefined();
      },
      onReceipt: async (intent) => {
        expect(readModalNativeBrokerCreate(intent)).toBeUndefined();
      },
    });
    await invoke(ordinary, async () => ({ sandboxId: "sb-fixture" }), {
      entrypointArgs: ["sleep", "infinity"],
      workdir: "/workspace",
    });
  });

  test("mutating nested SDK wire values during admission never dispatches the changed request", async () => {
    const args = modalNativeBrokerInitialCommand(plan());
    let dispatched = 0;
    const boundary = createModalProviderCreateBoundary({
      operationId,
      nativeBroker: plan(),
      beforeDispatch: async () => {
        args[0] = "/bin/sh";
      },
      onReceipt: async () => {},
    });
    const send = async () => {
      dispatched++;
      return { sandboxId: "sb-unexpected" };
    };
    await expect(invoke(boundary, send, { entrypointArgs: args })).rejects.toThrow(
      "wire request changed after durable admission",
    );
    await expect(invoke(boundary, send)).rejects.toThrow("already attempted");
    expect(dispatched).toBe(0);
  });

  test.each([
    { brokerId: "caller-string" },
    { brokerId: brokerId.toUpperCase() },
    { sourceSha: "main" },
    { imageId: "latest" },
    { artifact: { ...plan().artifact, byteSize: 0 } },
    { artifact: { ...plan().artifact, target: "any" } },
    { command: ["/bin/sh"] },
    { permission: "qualified" },
  ])("recipe input is closed, bounded and not a capability: %j", (change) => {
    expect(() => parseModalNativeBrokerCreatePlan({ ...plan(), ...change })).toThrow();
  });
});

test.each([
  "broker",
  "ordinary",
  "changed-image",
  "unqualified-image",
  "bad-admission",
  "bad-bootstrap",
  "missing-gate",
  "late-admission",
  "late-broker-admission",
  "late-bootstrap",
  "late-receipt",
])(
  "actual create lifecycle ordering with isolated fake provider: %s",
  async (mode) => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./fixtures/modal-native-broker-create.fixture.ts", import.meta.url).pathname,
        mode,
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({ mode, passed: true });
  },
  20_000,
);
