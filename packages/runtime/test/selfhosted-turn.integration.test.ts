// Selfhosted agent-turn contract — the INTEGRATION regression that the prior
// whack-a-mole fixes lacked. It drives the REAL @openai/agents run loop
// (runAgentStream owned branch, a ScriptedModel, creds-free) against a
// RoutingSandboxSession whose ACTIVE backend is a SelfhostedSession pinned from
// turn start. This exercises the full SDK provided-session contract the agent
// loop binds (filesystem/shell/skills capabilities) — createEditor, viewImage,
// execCommand, supportsPty, pathExists, listDir, materializeEntry, state.manifest
// read+write, AND the post-turn cross-backend serialize — over the NATS exec/fs
// primitives (MockAgentResponder).
//
// CRITICAL: the GROUP client is the REAL ModalSandboxClient (prod's group client),
// because the non-owned injected session is serialized at end-of-turn via the
// CONFIGURED client — NOT the selfhosted client. Modal's serialize reads
// `state.environment` (Object.entries), so the selfhosted state MUST carry an
// `environment` field or the post-turn serialize crashes with "Object.entries
// requires that input parameter not be null or undefined" — the exact prod crash a
// multi-step turn hit AFTER exec ran. A fake group client (returning {instanceId})
// would NOT exercise this path, which is why the prior harness missed it.
//
// MULTI-STEP is load-bearing: the crash fired on the post-tool-result serialize, so
// the turns below are genuine two-step (tool_call -> result -> final reply) and
// three-step (two tool calls -> final reply) rounds, not a one-shot response.

import { describe, expect, test } from "bun:test";
import { ScriptedModel, functionCall, assistantMessage } from "@opengeni/testing";
import { testSettings } from "@opengeni/testing";
import { Manifest } from "@openai/agents/sandbox";
import { ModalSandboxClient } from "@openai/agents-extensions/sandbox/modal";
import { buildOpenGeniAgent, runAgentStream, createSandboxClientForBackend } from "../src/index";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import { SelfhostedSession } from "../src/sandbox/selfhosted/session";
import { MockAgentResponder } from "../src/sandbox/selfhosted/testing";

const RELAY = { host: "relay.test", port: 443, tls: true } as const;
const WS = "11111111-1111-1111-1111-111111111111";
// The stable run environment the turn declares (git identity + HOME); the proxy
// default (group) backend and the selfhosted backend BOTH carry it, so the SDK's
// per-turn manifest-env delta is empty.
const ENV = { GIT_AUTHOR_NAME: "OpenGeni Bot", HOME: "/workspace" };

const liveSessions: Array<{ close?: () => Promise<void> }> = [];

/** Drive a full agent turn with the REAL ModalSandboxClient as the GROUP client and
 *  a SelfhostedSession pinned active. Returns the serialized RunState string (the
 *  worker's `state.toString()` — the call that triggers the cross-backend serialize
 *  that used to crash). A contract gap or a serialize crash throws before return. */
async function runPinnedToVmTurn(model: ScriptedModel): Promise<string> {
  const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false, gitAuthorName: "OpenGeni Bot" });
  // A real local session seeds the proxy DEFAULT (group) backend (createEditor /
  // viewImage bearing), but its manifest is forced to the empty-entries shape the
  // prod modal box is created with ({environment} only).
  const local = createSandboxClientForBackend("local", settings) as unknown as {
    create: (m?: unknown) => Promise<{ close?: () => Promise<void>; state: { manifest: Manifest } }>;
  };
  const groupSession = await local.create({});
  liveSessions.push(groupSession);
  groupSession.state.manifest = new Manifest({ root: "/workspace", entries: {}, environment: ENV });

  // The REAL modal client — prod's configured group client. Its serializeSessionState
  // runs on the SELFHOSTED active state at end-of-turn (the regression surface).
  const client = new ModalSandboxClient();

  // The selfhosted machine the session is pinned to. The agent IS the box; exec
  // routes over NATS to the MockAgentResponder (a virtual fs + exec).
  const self = new SelfhostedSession({
    workspaceId: WS,
    agentId: "enroll-1",
    controlRpc: new MockAgentResponder({ hostname: "vm2" }),
    relay: RELAY,
    environment: ENV,
  });

  // The routing proxy: DEFAULT is the group box (createEditor-bearing), but the
  // pointer is PINNED to the selfhosted machine from turn start (epoch 1). Every
  // op the agent loop dispatches lands on the selfhosted backend.
  const proxy = new RoutingSandboxSession({
    defaultResolved: { session: groupSession as never, sandboxId: null, kind: "modal" },
    readPointer: async () => ({ activeSandboxId: "sbx-self", activeEpoch: 1 }),
    resolveActiveBackend: async () => ({ session: self as never, sandboxId: "sbx-self", kind: "selfhosted" }),
  });

  const agent = buildOpenGeniAgent(settings, [], { model, sandboxEnvironment: ENV });
  const result = await runAgentStream(agent, "run echo on the vm", settings, {
    ownedSandbox: { client: client as never, session: proxy as never },
  });
  for await (const _ of result.toStream()) {
    void _;
  }
  await result.completed;
  // The worker persists the turn via state.toString() -> the manager serializes the
  // active (selfhosted) state through the modal group client. THIS is the call that
  // threw "Object.entries(undefined)" before the state.environment fix.
  return result.state.toString();
}

describe("selfhosted agent-turn contract — full run loop over a pinned selfhosted backend", () => {
  test("TWO-STEP turn (deltas -> tool_call(exec) -> result -> final reply) runs + serializes clean", async () => {
    // The exact prod shape: assistant deltas, an exec_command tool call that runs on
    // vm2 (over NATS), a tool result, then a final assistant reply — and the
    // post-tool-result serialize that crashed in prod now succeeds.
    const s = await runPinnedToVmTurn(new ScriptedModel([
      { output: [assistantMessage("let me check the machine"), functionCall("exec_command", { cmd: "echo PINNED" })] },
      { output: [assistantMessage("the machine says PINNED")] },
    ]));
    expect(typeof s).toBe("string");
  });

  test("THREE-STEP turn (two tool calls -> final reply) runs + serializes clean", async () => {
    // Two exec rounds on the selfhosted backend (re-resolve each op within the same
    // epoch) then a final reply, with the cross-backend serialize at the end.
    const s = await runPinnedToVmTurn(new ScriptedModel([
      { output: [functionCall("exec_command", { cmd: "hostname" })] },
      { output: [functionCall("exec_command", { cmd: "whoami" })] },
      { output: [assistantMessage("done on vm2")] },
    ]));
    expect(typeof s).toBe("string");
  });

  test("REGRESSION (focused): the selfhosted state carries the `environment` field the GROUP client's serialize reads", () => {
    // The minimal root-cause property. The non-owned injected session is serialized
    // at end-of-turn via the CONFIGURED (modal) client, whose serialize does
    // `Object.entries(state.environment)`. An absent field crashes with "Object.entries
    // requires that input parameter not be null or undefined" (the prod crash). The
    // end-to-end modal serialize is covered by the TWO-STEP / THREE-STEP turns above
    // (which run it through the SDK manager); here we pin the load-bearing property.
    const self = new SelfhostedSession({ workspaceId: WS, agentId: "enroll-1", controlRpc: new MockAgentResponder(), relay: RELAY, environment: ENV });
    expect(self.state.environment).toEqual(ENV);
    expect(Object.entries(self.state.environment)).not.toThrow;
    // The negotiation/test path (no env) still yields a defined object, never undefined.
    const bare = new SelfhostedSession({ workspaceId: WS, agentId: "enroll-1", controlRpc: new MockAgentResponder(), relay: RELAY });
    expect(bare.state.environment).toEqual({});
    expect(Object.entries(bare.state.environment)).toEqual([]);
  });

  test("the apply_patch editor applies a V4A create-file diff over the NATS fs ops", async () => {
    // The filesystem capability binds session.createEditor(). Prove the selfhosted
    // editor (injected applyDiff + NATS writeFile) creates a file the machine then holds.
    const self = new SelfhostedSession({
      workspaceId: WS,
      agentId: "enroll-1",
      controlRpc: new MockAgentResponder(),
      relay: RELAY,
      environment: ENV,
    });
    const editor = self.createEditor();
    await editor.createFile({
      path: "/workspace/new.txt",
      // V4A create-file syntax: every line starts with "+".
      diff: "+hello from the vm\n+second line",
    });
    const bytes = await self.readFile({ path: "/workspace/new.txt" });
    expect(new TextDecoder().decode(bytes)).toBe("hello from the vm\nsecond line");
  });

  test("viewImage wraps machine bytes in the SDK tool-output image shape (png magic bytes)", async () => {
    const mock = new MockAgentResponder();
    const self = new SelfhostedSession({ workspaceId: WS, agentId: "enroll-1", controlRpc: mock, relay: RELAY });
    // Seed a tiny PNG (magic bytes) on the virtual fs.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await self.writeFile({ path: "/workspace/img.png", content: png });
    const out = await self.viewImage({ path: "/workspace/img.png" });
    expect(out.type).toBe("image");
    expect(out.image.mediaType).toBe("image/png");
    expect(Array.from(out.image.data.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("listDir maps the proto fs entries to the SDK {name,path,type} shape; pathExists works; supportsPty is false; materializeEntry is a no-op", async () => {
    const mock = new MockAgentResponder();
    const self = new SelfhostedSession({ workspaceId: WS, agentId: "enroll-1", controlRpc: mock, relay: RELAY });
    await self.writeFile({ path: "/workspace/a.txt", content: "a" });
    expect(await self.pathExists("/workspace/a.txt")).toBe(true);
    expect(await self.pathExists("/workspace/missing.txt")).toBe(false);
    const entries = await self.listDir({ path: "/workspace" });
    const a = entries.find((e) => e.name === "a.txt");
    expect(a?.type).toBe("file");
    expect(self.supportsPty()).toBe(false);
    // materializeEntry is a no-op (the machine owns its fs) — present so the SDK's
    // provided-session manifest apply path is satisfied; resolves without error.
    await expect(self.materializeEntry({ path: "x", entry: {} })).resolves.toBeUndefined();
  });
});
