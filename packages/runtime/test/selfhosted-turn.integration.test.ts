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
async function runPinnedToVmTurn(
  model: ScriptedModel,
  opts: {
    toolspaceTokenSeed?: string;
    responder?: MockAgentResponder;
    activeSandboxBackend?: "selfhosted";
    onToolspaceTokenSessionReady?: Parameters<
      typeof runAgentStream
    >[3]["onToolspaceTokenSessionReady"];
  } = {},
): Promise<string> {
  const settings = testSettings({
    sandboxBackend: "local",
    webSearchEnabled: false,
    gitAuthorName: "OpenGeni Bot",
  });
  // A real local session seeds the proxy DEFAULT (group) backend (createEditor /
  // viewImage bearing), but its manifest is forced to the empty-entries shape the
  // prod modal box is created with ({environment} only).
  const local = createSandboxClientForBackend("local", settings) as unknown as {
    create: (
      m?: unknown,
    ) => Promise<{ close?: () => Promise<void>; state: { manifest: Manifest } }>;
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
    controlRpc: opts.responder ?? new MockAgentResponder({ hostname: "vm2" }),
    relay: RELAY,
    environment: ENV,
  });

  // The routing proxy: DEFAULT is the group box (createEditor-bearing), but the
  // pointer is PINNED to the selfhosted machine from turn start (epoch 1). Every
  // op the agent loop dispatches lands on the selfhosted backend.
  const proxy = new RoutingSandboxSession({
    defaultResolved: { session: groupSession as never, sandboxId: null, kind: "modal" },
    readPointer: async () => ({ activeSandboxId: "sbx-self", activeEpoch: 1 }),
    resolveActiveBackend: async () => ({
      session: self as never,
      sandboxId: "sbx-self",
      kind: "selfhosted",
    }),
  });

  const agent = buildOpenGeniAgent(settings, [], {
    model,
    sandboxEnvironment: ENV,
    ...(opts.toolspaceTokenSeed
      ? {
          toolspaceTokenSeed: opts.toolspaceTokenSeed,
          toolspaceTokenSessionId: "session-selfhosted",
        }
      : {}),
    ...(opts.activeSandboxBackend ? { activeSandboxBackend: opts.activeSandboxBackend } : {}),
  });
  const result = await runAgentStream(agent, "run echo on the vm", settings, {
    ownedSandbox: { client: client as never, session: proxy as never },
    ...(opts.onToolspaceTokenSessionReady
      ? { onToolspaceTokenSessionReady: opts.onToolspaceTokenSessionReady }
      : {}),
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
    const s = await runPinnedToVmTurn(
      new ScriptedModel([
        {
          output: [
            assistantMessage("let me check the machine"),
            functionCall("exec_command", { cmd: "echo PINNED" }),
          ],
        },
        { output: [assistantMessage("the machine says PINNED")] },
      ]),
    );
    expect(typeof s).toBe("string");
  });

  test("THREE-STEP turn (two tool calls -> final reply) runs + serializes clean", async () => {
    // Two exec rounds on the selfhosted backend (re-resolve each op within the same
    // epoch) then a final reply, with the cross-backend serialize at the end.
    const s = await runPinnedToVmTurn(
      new ScriptedModel([
        { output: [functionCall("exec_command", { cmd: "hostname" })] },
        { output: [functionCall("exec_command", { cmd: "whoami" })] },
        { output: [assistantMessage("done on vm2")] },
      ]),
    );
    expect(typeof s).toBe("string");
  });

  test("TOOLSPACE DELIVERY: the token seed is written to the machine over the exec channel, with NO platform setup", async () => {
    // Selfhosted parity: a connected-machine turn now receives the toolspace token
    // (activeSandboxBackend "selfhosted" + a per-turn seed). The runtime seeds it
    // over the SAME exec channel the docker path uses — off-manifest — while the
    // platform setup hooks (repository clone, az login) stay OFF the user's real
    // machine. Record every exec the machine received and assert both halves.
    const execLog: string[] = [];
    const responder = new MockAgentResponder({
      hostname: "vm2",
      exec: (req) => {
        execLog.push(req.command.join(" "));
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(""),
          stderr: new Uint8Array(0),
          timedOut: false,
          durationMs: "1",
        };
      },
    });
    let renewalSessionIsRouted = false;
    await runPinnedToVmTurn(new ScriptedModel([{ output: [assistantMessage("ok")] }]), {
      toolspaceTokenSeed: "ogd_selfhosted_seed",
      responder,
      activeSandboxBackend: "selfhosted",
      onToolspaceTokenSessionReady: (session) => {
        renewalSessionIsRouted = session instanceof RoutingSandboxSession;
      },
    });
    // The seed hook ran over the machine's exec channel and carried the token value.
    expect(
      execLog.some(
        (c) => c.includes("OPENGENI_TOOLSPACE_TOKEN_SEED") && c.includes("ogd_selfhosted_seed"),
      ),
    ).toBe(true);
    // But NO platform setup ran against the user's real computer.
    expect(execLog.some((c) => c.includes("git clone"))).toBe(false);
    expect(execLog.some((c) => c.includes("az login") || c.includes("az account"))).toBe(false);
    expect(renewalSessionIsRouted).toBe(true);
  });

  test("NO-TOOLSPACE selfhosted turn seeds nothing (the hook list is empty without a token)", async () => {
    const execLog: string[] = [];
    const responder = new MockAgentResponder({
      hostname: "vm2",
      exec: (req) => {
        execLog.push(req.command.join(" "));
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(""),
          stderr: new Uint8Array(0),
          timedOut: false,
          durationMs: "1",
        };
      },
    });
    await runPinnedToVmTurn(new ScriptedModel([{ output: [assistantMessage("ok")] }]), {
      responder,
      activeSandboxBackend: "selfhosted",
    });
    expect(execLog.some((c) => c.includes("OPENGENI_TOOLSPACE_TOKEN_SEED"))).toBe(false);
  });

  test("selfhosted exec exports ONLY the allowlisted toolspace pointers to the machine (not HOME/GIT_*)", async () => {
    // ogtool on the machine reads $OPENGENI_TOOLSPACE_URL/_TOKEN_FILE from its
    // shell env, but selfhosted exec does not consume the manifest env wholesale
    // (pushing HOME=/workspace onto a real computer would break it). Prove the
    // exec carries exactly the two non-secret toolspace pointers and nothing else.
    let capturedEnv: Record<string, string> = {};
    const responder = new MockAgentResponder({
      exec: (req) => {
        capturedEnv = req.env;
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(""),
          stderr: new Uint8Array(0),
          timedOut: false,
          durationMs: "1",
        };
      },
    });
    const self = new SelfhostedSession({
      workspaceId: WS,
      agentId: "enroll-1",
      controlRpc: responder,
      relay: RELAY,
      environment: {
        OPENGENI_TOOLSPACE_URL: "https://app.opengeni.example/v1/workspaces/ws/mcp",
        OPENGENI_TOOLSPACE_TOKEN_FILE: "/workspace/.opengeni/toolspace-token",
        HOME: "/workspace",
        GIT_AUTHOR_NAME: "OpenGeni Bot",
      },
    });
    await self.exec({ cmd: "ogtool list" });
    expect(capturedEnv.OPENGENI_TOOLSPACE_URL).toBe(
      "https://app.opengeni.example/v1/workspaces/ws/mcp",
    );
    expect(capturedEnv.OPENGENI_TOOLSPACE_TOKEN_FILE).toBe("/workspace/.opengeni/toolspace-token");
    expect(capturedEnv.HOME).toBeUndefined();
    expect(capturedEnv.GIT_AUTHOR_NAME).toBeUndefined();
  });

  test("REGRESSION (focused): the selfhosted state carries the `environment` field the GROUP client's serialize reads", () => {
    // The minimal root-cause property. The non-owned injected session is serialized
    // at end-of-turn via the CONFIGURED (modal) client, whose serialize does
    // `Object.entries(state.environment)`. An absent field crashes with "Object.entries
    // requires that input parameter not be null or undefined" (the prod crash). The
    // end-to-end modal serialize is covered by the TWO-STEP / THREE-STEP turns above
    // (which run it through the SDK manager); here we pin the load-bearing property.
    const self = new SelfhostedSession({
      workspaceId: WS,
      agentId: "enroll-1",
      controlRpc: new MockAgentResponder(),
      relay: RELAY,
      environment: ENV,
    });
    expect(self.state.environment).toEqual(ENV);
    expect(() => Object.entries(self.state.environment)).not.toThrow();
    // The negotiation/test path (no env) still yields a defined object, never undefined.
    const bare = new SelfhostedSession({
      workspaceId: WS,
      agentId: "enroll-1",
      controlRpc: new MockAgentResponder(),
      relay: RELAY,
    });
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
    const self = new SelfhostedSession({
      workspaceId: WS,
      agentId: "enroll-1",
      controlRpc: mock,
      relay: RELAY,
    });
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
    const self = new SelfhostedSession({
      workspaceId: WS,
      agentId: "enroll-1",
      controlRpc: mock,
      relay: RELAY,
    });
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
