// Selfhosted agent-turn contract — the INTEGRATION regression that the prior
// whack-a-mole fixes lacked. It drives the REAL @openai/agents run loop
// (runAgentStream owned branch, a ScriptedModel, creds-free) against a
// RoutingSandboxSession whose ACTIVE backend is a SelfhostedSession pinned from
// turn start. This exercises the full SDK provided-session contract the agent
// loop binds (filesystem/shell/skills capabilities) — createEditor, viewImage,
// execCommand, supportsPty, pathExists, listDir, materializeEntry, state.manifest
// read+write, post-turn serialize — over the NATS exec/fs primitives (MockAgentResponder).
//
// Before the comprehensive fix, a pinned-to-vm turn died at the FIRST capability
// the selfhosted session did not implement (state.manifest undefined ->
// "current.root"; then the env-delta; then "Filesystem sandbox sessions must
// provide createEditor()"). This test fails closed if ANY contract method regresses.

import { describe, expect, test } from "bun:test";
import { ScriptedModel, functionCall, assistantMessage } from "@opengeni/testing";
import { testSettings } from "@opengeni/testing";
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

// A faithful GROUP client: backendId "modal"-like (not local — so the post-turn
// serialize takes the remote path, reading state.manifest rather than a local fs
// snapshot). Its create() yields a real local session ONLY to seed the proxy
// DEFAULT backend with a createEditor/viewImage-bearing session (what the group
// modal box provides in prod).
function groupClientWith(create: (m?: unknown) => Promise<unknown>) {
  return {
    backendId: "modal",
    supportsDefaultOptions: false,
    create,
    async serializeSessionState(state: { instanceId?: string; manifest?: { root?: string } }) {
      return { instanceId: state?.instanceId, manifestRoot: state?.manifest?.root };
    },
    async deserializeSessionState(s: unknown) {
      return s as Record<string, unknown>;
    },
    async canPersistOwnedSessionState() {
      return false;
    },
  } as never;
}

describe("selfhosted agent-turn contract — full run loop over a pinned selfhosted backend", () => {
  test("a complete turn (exec on the vm) runs end-to-end with NO contract crash", async () => {
    const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
    const local = createSandboxClientForBackend("local", settings) as unknown as {
      create: (m?: unknown) => Promise<{ close?: () => Promise<void> }>;
    };
    const groupSession = await local.create({});
    liveSessions.push(groupSession);
    const client = groupClientWith(local.create.bind(local) as never);

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

    // exec_command -> the shell capability calls session.execCommand on the proxy,
    // which dispatches to the selfhosted backend; then a final assistant message.
    const model = new ScriptedModel([
      { output: [functionCall("exec_command", { cmd: "echo hi" })] },
      { output: [assistantMessage("done")] },
    ]);
    const agent = buildOpenGeniAgent(settings, [], { model });

    const result = await runAgentStream(agent, "run echo on the vm", settings, {
      ownedSandbox: { client, session: proxy as never },
    });
    for await (const _ of result.toStream()) {
      void _;
    }
    await result.completed;

    // The run reached its normal finish (a contract gap would have thrown before
    // here), and the post-turn RunState serialize (state._sandbox) succeeds.
    expect(typeof result.state.toString()).toBe("string");
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
