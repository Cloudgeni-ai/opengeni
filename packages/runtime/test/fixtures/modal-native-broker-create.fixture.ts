import assert from "node:assert/strict";
import { mock } from "bun:test";

const mode = process.argv[2]!;
const events: string[] = [];
let instanceCount = 0;
let wire: any;
let middleware: any;
mock.module("modal", () => ({
  Sandbox: class { constructor(public client: unknown, public id: string) {} },
  ModalClient: class {
    constructor(options: any) { instanceCount++; middleware = options.grpcMiddleware[0]; }
    close() { events.push("transport-close"); }
    logger = { warn() { events.push("warning"); } };
    apps = { fromName: async () => ({ appId: "ap-fixture" }) };
    sandboxes = { create: async (_app: unknown, image: any, options: any) => {
      const iterator = middleware({
        method: { path: "/modal.client.ModalClient/SandboxCreate" }, requestStream: false, responseStream: false,
        request: { appId: "ap-fixture", tags: [], definition: { imageId: image.imageId, entrypointArgs: options.command, workdir: options.workdir } },
        // eslint-disable-next-line require-yield -- Model the pinned unary middleware boundary without a provider call.
        next: async function* (request: unknown) {
          wire = request;
          events.push("physical");
          if (mode === "late-receipt") await new Promise(resolve => setTimeout(resolve, 30));
          return { sandboxId: "sb-fixture" };
        },
      }, {});
      let result = await iterator.next();
      while (!result.done) result = await iterator.next();
      return result.value;
    } };
  },
}));
mock.module("@openai/agents-extensions/sandbox/modal", () => ({
  ModalImageSelector: { fromTag: (value: string) => ({ kind: "tag", value }) },
  ModalSandboxSession: class {
    state: any;
    constructor(args: any) { this.state = args.state; }
    async applyManifest() { events.push("manifest"); }
    async close() { events.push("session-close"); }
  },
  buildModalCloudBucketMountConfig() { throw new Error("fixture has no mounts"); },
  isModalCloudBucketMountEntry() { return false; },
}));
mock.module("../../src/sandbox/providers/modal-registry-image", () => ({
  prepareCanonicalModalCreateImage: async () => {
    const imageId = mode === "changed-image" ? "im-other" : "im-pinned";
    return { image: { imageId }, preparation: { kind: mode === "unqualified-image" ? "unqualified-image" : "provider-image-id", imageId } };
  },
}));
mock.module("../../src/sandbox/providers/modal-command-start-errors", () => ({
  modalCommandStartCleanupIsSafe: () => true,
}));

const { createModalSessionWithLifecycle } = await import("../../src/sandbox/providers/modal-create-session");
const { parseModalNativeBrokerCreatePlan, readModalNativeBrokerCreate } = await import("../../src/sandbox/providers/modal-native-broker-create");
const plan = parseModalNativeBrokerCreatePlan({
  version: 1, brokerId: "7bd1fc5e-163f-4f1e-b3dc-2cfc3ecbd3d5", sourceSha: "b".repeat(40), imageId: "im-pinned",
  artifact: { artifactSha256: "c".repeat(64), byteSize: 108144, target: "linux-amd64" },
});
let failure: unknown;
try {
  const session = await createModalSessionWithLifecycle({
    appName: "fixture", imageTag: "fixture", ...(mode.startsWith("late-") ? { sandboxCreateTimeoutS: 0.005 } : {}),
  }, { manifest: { root: mode === "foreign-root" ? "/other" : "/workspace",
    entries: mode === "initial-entries" ? { child: { type: "dir", children: {} } } : {},
  } }, {
    beforeDispatch: async () => {
      events.push("lease-admission");
      if (mode === "late-admission") await new Promise(resolve => setTimeout(resolve, 30));
    },
    onCreated: async () => { events.push("physical-receipt"); },
    ...(mode === "ordinary" ? {} : { nativeBroker: {
      plan,
      beforeDispatch: async (intent: any) => {
        events.push("broker-admission");
        assert.deepEqual(readModalNativeBrokerCreate(intent)!.plan, plan);
        if (mode === "bad-admission") throw new Error("test admission rejected");
        if (mode === "late-broker-admission") await new Promise(resolve => setTimeout(resolve, 30));
      },
      verifyCreated: mode === "missing-gate" ? undefined as never : async (_session: unknown, intent: any) => {
        events.push("bootstrap");
        assert.deepEqual(readModalNativeBrokerCreate(intent)!.plan, plan);
        if (mode === "bad-bootstrap") throw new Error("test bootstrap rejected");
        if (mode === "late-bootstrap") await new Promise(resolve => setTimeout(resolve, 30));
      },
    } }),
  }, createdSession => createdSession);
  assert.equal(session.state.useSleepCmd, mode === "ordinary");
  await session.close();
} catch (error) { failure = error; }
if (mode.startsWith("late-")) await new Promise(resolve => setTimeout(resolve, 60));
switch (mode) {
  case "broker":
    assert.equal(failure, undefined);
    assert.deepEqual(events, ["lease-admission", "broker-admission", "physical", "physical-receipt", "bootstrap", "session-close", "transport-close"]);
    assert.equal(wire.definition.workdir, "/");
    assert.deepEqual(wire.definition.entrypointArgs, ["/usr/local/bin/opengeni-command-supervisor", "broker", "--broker-id", plan.brokerId]);
    break;
  case "ordinary":
    assert.equal(failure, undefined);
    assert.deepEqual(events, ["lease-admission", "physical", "physical-receipt", "manifest", "session-close", "transport-close"]);
    assert.deepEqual(wire.definition.entrypointArgs, ["sleep", "infinity"]);
    assert.equal(wire.definition.workdir, "/workspace");
    break;
  case "missing-gate":
    assert.match(String(failure), /durable admission and bootstrap gates/);
    assert.equal(instanceCount, 0);
    assert.deepEqual(events, []);
    break;
  case "foreign-root":
  case "initial-entries":
    assert.match(String(failure), /initial manifest entries or noncanonical root/);
    assert.equal(instanceCount, 0);
    assert.deepEqual(events, []);
    break;
  case "changed-image":
  case "unqualified-image":
    assert.match(String(failure), /unqualified physical image/);
    assert.deepEqual(events, ["transport-close"]);
    break;
  case "bad-admission":
    assert.match(String(failure), /test admission rejected/);
    assert.deepEqual(events, ["lease-admission", "broker-admission", "transport-close"]);
    break;
  case "bad-bootstrap":
    assert.match(String(failure), /test bootstrap rejected/);
    // Existing failure cleanup closes the owned transport both through the
    // session wrapper and its finally guard; the real Modal close is idempotent.
    assert.deepEqual(events, ["lease-admission", "broker-admission", "physical", "physical-receipt", "bootstrap", "session-close", "transport-close", "transport-close"]);
    break;
  case "late-admission":
    assert.match(String(failure), /timed out/);
    assert.equal(events.includes("physical"), false);
    assert.equal(events.includes("broker-admission"), false);
    assert.equal(events.at(-1), "transport-close");
    break;
  case "late-receipt":
    assert.match(String(failure), /timed out/);
    assert.equal(events.includes("physical-receipt"), true);
    assert.equal(events.includes("bootstrap"), false);
    assert.equal(events.includes("manifest"), false);
    assert.equal(events.includes("session-close"), true);
    break;
  case "late-broker-admission":
    assert.match(String(failure), /timed out/);
    assert.equal(events.includes("broker-admission"), true);
    assert.equal(events.includes("physical"), false);
    assert.equal(events.at(-1), "transport-close");
    break;
  case "late-bootstrap":
    assert.match(String(failure), /timed out/);
    assert.equal(events.includes("physical-receipt"), true);
    assert.equal(events.includes("bootstrap"), true);
    assert.equal(events.includes("manifest"), false);
    assert.equal(events.includes("session-close"), true);
    break;
  default: throw new Error("Unknown fixture mode");
}
console.log(JSON.stringify({ mode, passed: true }));
