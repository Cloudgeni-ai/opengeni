import { describe, expect, test } from "bun:test";
import { ScriptedModel, testSettings } from "@opengeni/testing";
import { buildManifest, buildOpenGeniAgent, runOwnedSandboxSetup } from "../src/index";
import { RoutingSandboxSession, type RoutableBackendSession } from "../src/sandbox";
import { applyManifestToProvidedSession } from "../../../node_modules/.bun/@openai+agents-core@0.11.6+4b65e697391ccbcb/node_modules/@openai/agents-core/dist/sandbox/runtime/providedSessionManifest.js";

async function manifestEnv(manifest: {
  resolveEnvironment?: () => Promise<Record<string, string>>;
  environment?: Record<string, { value?: string }>;
}): Promise<Record<string, string | undefined>> {
  if (manifest.resolveEnvironment) {
    return manifest.resolveEnvironment();
  }
  return Object.fromEntries(
    Object.entries(manifest.environment ?? {}).map(([key, value]) => [key, value.value]),
  );
}

describe("lazy provisioning synthetic manifest", () => {
  test("SDK provided-session apply sees synthetic current === target and performs no write", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = { HOME: "/workspace", DEPLOY_TARGET: "lazy-test" };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
    });
    const target = (agent as { defaultManifest: unknown }).defaultManifest;
    const synthetic = {
      state: { manifest: target },
      async materializeEntry() {
        throw new Error("synthetic session must not materialize an empty manifest delta");
      },
    };

    await applyManifestToProvidedSession(synthetic as never, target as never);

    expect(synthetic.state.manifest).toBe(target);
  });

  test("manifest environment stays stable when proxy switches from synthetic to real backend", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = {
      HOME: "/workspace",
      DEPLOY_TARGET: "lazy-test",
      GIT_ASKPASS: "/workspace/.opengeni/askpass",
    };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
    });
    const syntheticManifest = (agent as { defaultManifest: unknown }).defaultManifest;
    const realManifest = buildManifest(settings, [], environment);
    const realBackend: RoutableBackendSession = {
      state: { manifest: realManifest },
      async exec() {
        return { stdout: "real", exitCode: 0 };
      },
    };
    const proxy = new RoutingSandboxSession({
      defaultResolved: {
        session: { state: { manifest: syntheticManifest } },
        sandboxId: null,
        kind: "unprovisioned",
      },
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 1 }),
      resolveActiveBackend: async () => ({ session: realBackend, sandboxId: null, kind: "modal" }),
    });

    const before = await manifestEnv((proxy.state as { manifest: never }).manifest);
    await proxy.exec({ cmd: "true" });
    const after = await manifestEnv((proxy.state as { manifest: never }).manifest);

    expect(before).toEqual(environment);
    expect(after).toEqual(environment);
  });

  test("real backend manifest equal to agent manifest emits no env drift during lazy setup", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = {
      HOME: "/workspace",
      DEPLOY_TARGET: "lazy-test",
      GIT_ASKPASS: "/workspace/.opengeni/askpass",
    };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
    });
    const realBackend: RoutableBackendSession = {
      state: { manifest: buildManifest(settings, [], environment) },
    };
    const events: Array<{ type: string; payload: unknown }> = [];

    await runOwnedSandboxSetup(agent, realBackend as never, realBackend as never, {
      settings,
      environment,
      onRuntimeEvent: (event) => {
        events.push(event);
      },
    });

    expect(events.filter((event) => event.type === "sandbox.env.drift")).toEqual([]);
    expect(await manifestEnv((agent as { defaultManifest: never }).defaultManifest)).toEqual(
      environment,
    );
  });

  // REGRESSION: runOwnedSandboxSetup is the LIVE owned-path hook execution (the
  // provided session skips the client create/resume decoration). A rig-bound turn
  // MUST run its frozen setup script here — a merge with the #315 lazy-provisioning
  // refactor once left the rig hooks only on the inert decoration, so rig setup was
  // silently skipped on every lease-owned turn.
  test("runOwnedSandboxSetup runs the rig setup hook on the owned path", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = { HOME: "/workspace" };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
      rigSetup: {
        rigId: "rig-1",
        rigName: "dev-machine",
        versionId: "ver-9",
        script: "echo hi",
        timeoutMs: 60_000,
      },
    });
    const execCmds: string[] = [];
    const backend = {
      state: { manifest: buildManifest(settings, [], environment) },
      exec: async (args: { cmd: string }) => {
        execCmds.push(args.cmd);
        return { exitCode: 0, output: "" };
      },
    };

    await runOwnedSandboxSetup(agent, backend as never, backend as never, {
      settings,
      environment,
    });

    // The rig-setup hook exec'd its marker-guarded program against the box.
    expect(
      execCmds.some((cmd) =>
        cmd.includes(`__OG_RIG_MARKER="$__OG_RIG_ROOT"/'rig-setup-ver-9.done'`),
      ),
    ).toBe(true);
  });

  // REGRESSION (caught live on staging 2026-07-08): the SDK's FilesystemCapability
  // calls session.createEditor() SYNCHRONOUSLY at tool-BIND time (every turn, before
  // any tool runs) and throws "Filesystem sandbox sessions must provide createEditor()"
  // if it returns falsy. Under lazy provisioning the default backend is the synthetic
  // unprovisioned session with NO editor, so a direct delegate returned undefined and
  // EVERY lazy turn died at bind — even chat-only turns. createEditor must return a
  // non-null lazy editor whose ops resolve (establish) the backend on first use.
  test("createEditor returns a non-null lazy editor before establish; editor ops resolve the backend", async () => {
    let resolveCount = 0;
    const realEditorCalls: Array<{ op: string; operation: unknown }> = [];
    const realBackend: RoutableBackendSession = {
      state: { manifest: {} },
      createEditor: () => ({
        createFile: async (operation: unknown) => {
          realEditorCalls.push({ op: "createFile", operation });
          return { output: "created" };
        },
        updateFile: async (operation: unknown) => {
          realEditorCalls.push({ op: "updateFile", operation });
          return { output: "updated" };
        },
        deleteFile: async (operation: unknown) => {
          realEditorCalls.push({ op: "deleteFile", operation });
          return { output: "deleted" };
        },
      }),
    } as unknown as RoutableBackendSession;
    const proxy = new RoutingSandboxSession({
      // Synthetic unprovisioned default: NO createEditor (this is what broke bind).
      defaultResolved: {
        session: { state: { manifest: {} } },
        sandboxId: null,
        kind: "unprovisioned",
      },
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 1 }),
      resolveActiveBackend: async () => {
        resolveCount += 1;
        return { session: realBackend, sandboxId: null, kind: "modal" };
      },
    });

    // The exact SDK bind-time check: createEditor() must be non-null. Before this
    // fix it returned undefined (the synthetic backend had no editor) and threw.
    const editor = proxy.createEditor("root") as {
      createFile: (op: unknown) => Promise<unknown>;
      updateFile: (op: unknown) => Promise<unknown>;
      deleteFile: (op: unknown) => Promise<unknown>;
    };
    expect(editor).toBeTruthy();
    expect(typeof editor.createFile).toBe("function");
    // No backend resolved yet: returning the editor must NOT have established a box.
    expect(resolveCount).toBe(0);

    // The editor op establishes the backend (resolve) on first use and delegates.
    const result = await editor.createFile({
      type: "create_file",
      path: "/workspace/x",
      diff: "+hi",
    });
    expect(resolveCount).toBe(1);
    expect(result).toEqual({ output: "created" });
    expect(realEditorCalls).toEqual([
      { op: "createFile", operation: { type: "create_file", path: "/workspace/x", diff: "+hi" } },
    ]);
  });
});
