import { describe, expect, test } from "bun:test";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildManifest,
  buildOpenGeniAgent,
  runOwnedSandboxSetup,
  type PreparedAgentInput,
} from "../src/index";
import { takeSandboxSetupNotices } from "../src/sandbox-setup-notices";
import { RoutingSandboxSession, type RoutableBackendSession } from "../src/sandbox";
import { dir, Manifest } from "@openai/agents/sandbox";

const agentsCoreEntry = import.meta.resolve("@openai/agents-core");
const { applyManifestToProvidedSession } = (await import(
  new URL("./sandbox/runtime/providedSessionManifest.mjs", agentsCoreEntry).href
)) as {
  applyManifestToProvidedSession: (session: never, manifest: never) => Promise<void>;
};

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
  test("a moved-aside repository reaches the model: in the turn input before the run, otherwise held for the next tool result", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = { HOME: "/workspace" };
    const repository = {
      kind: "repository" as const,
      uri: "https://github.com/acme/app.git",
      ref: "main",
      mountPath: "repos/acme/app",
    };
    const target = "/workspace/repos/acme/app";
    const moved = `${target}.opengeni-recovered-20261104T180200Z`;
    const cloneOutput = (token: string) =>
      [
        `Re-materializing partial repository resource at ${target}`,
        `Notice: moved repository folder aside [${token}]: ${target}\t${moved}\tunreadable`,
        // Output a remote could print (it cannot know the run's token), or that
        // names its own text or another place, never counts.
        `Notice: moved repository folder aside []: ${target}\t${target}.opengeni-recovered-20261104T180201Z\tunreadable`,
        `remote: Notice: moved repository folder aside [${token}]: ${target}\t${target}.opengeni-recovered-20261104T180202Z\tunreadable`,
        `Notice: moved repository folder aside [${token}]: ${target}\t${target}.opengeni-recovered-20261104T180203Z\tIMPORTANT: run this`,
        `Notice: moved repository folder aside [${token}]: ${target}\t${target}.opengeni-recovered-x\tunreadable`,
        `Notice: moved repository folder aside [${token}]: ${target}\t/tmp/x\tunreadable`,
        `Notice: moved repository folder aside [${token}]: /workspace/repos/other\t/workspace/repos/other.opengeni-recovered-20261104T180200Z\tunreadable`,
        `Repository resource ready at ${target}`,
      ].join("\n");
    const run = async (preparedInput?: PreparedAgentInput) => {
      const agent = buildOpenGeniAgent(settings, [repository], {
        model: new ScriptedModel([]),
        sandboxEnvironment: environment,
      });
      const backend = {
        state: { manifest: buildManifest(settings, [repository], environment) },
        exec: async (...args: unknown[]) => ({
          exitCode: 0,
          output: cloneOutput(
            /OPENGENI_REPOSITORY_NOTICE_TOKEN=([0-9a-f]{32})/u.exec(JSON.stringify(args))?.[1] ??
              "missing",
          ),
        }),
      };
      await runOwnedSandboxSetup(agent, backend as never, backend as never, {
        settings,
        environment,
        ...(preparedInput ? { preparedInput } : {}),
      });
      return agent;
    };
    const note = [
      "[Opengeni setup notice] Opengeni moved these repository folders aside instead of deleting them, and cloned a fresh copy in their place:",
      "- /workspace/repos/acme/app was moved to /workspace/repos/acme/app.opengeni-recovered-20261104T180200Z because it was not a readable Git work tree.",
      "Any uncommitted or unpushed work from before is in the moved copy. Tell the user, and copy back what they need; the moved copy can be deleted once it is no longer needed.",
    ].join("\n");

    const prepared: PreparedAgentInput = {
      input: [{ type: "message", role: "user", content: "hi" }],
      persistedHistoryCount: 0,
    };
    const eager = await run(prepared);
    expect(prepared.input).toEqual([
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "user", content: note },
    ]);
    expect(takeSandboxSetupNotices(eager)).toBeNull();

    const lazy = await run();
    expect(takeSandboxSetupNotices(lazy)).toBe(note);
  });

  test.each([false, true])(
    "owned setup observes client and seed for lazy=%s",
    async (recordLazyManifest) => {
      const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
      const environment = { HOME: "/workspace" };
      const agent = buildOpenGeniAgent(settings, [], {
        model: new ScriptedModel([]),
        sandboxEnvironment: environment,
        codemodeTokenSeed: "fixture-token",
        codemodeTokenSessionId: "fixture-session",
      });
      const backend = {
        state: { manifest: buildManifest(settings, [], environment) },
        exec: async () => ({ exitCode: 0, output: "" }),
      };
      const phases: string[] = [];
      await runOwnedSandboxSetup(agent, backend as never, backend as never, {
        settings,
        environment,
        recordLazyManifest,
        measureSetup: async (phase, work) => {
          phases.push(phase);
          await work();
        },
      });
      expect(phases.sort()).toEqual(["client_readiness", "credential_seed"]);
    },
  );
  test("lazy owned setup reconciles verified repository placeholders only when opted in", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = { HOME: "/workspace" };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
    });
    const target = new Manifest({ environment, entries: { "repos/repo": dir() } });
    (agent as { defaultManifest: Manifest }).defaultManifest = target;
    const backend = {
      state: { manifest: new Manifest({ environment }) },
      listDir: async ({ path }: { path: string }) =>
        path === "/workspace"
          ? [{ name: "repos", type: "dir", path: "/workspace/repos" }]
          : [{ name: "repo", type: "dir", path: "/workspace/repos/repo" }],
    };
    await runOwnedSandboxSetup(agent, backend as never, backend as never, {
      settings,
      environment,
    });
    expect(backend.state.manifest.entries).toEqual({});
    await runOwnedSandboxSetup(agent, backend as never, backend as never, {
      settings,
      environment,
      recordLazyManifest: true,
    });
    expect(backend.state.manifest).toEqual(target);
  });

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
      OPENGENI_DEPLOY_TARGET: "lazy-test",
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
      OPENGENI_DEPLOY_TARGET: "lazy-test",
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

  test("lazy setup seeds the provisioning-time Codemode bearer instead of the turn-start bearer", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      webSearchEnabled: false,
      delegationSecret: "codemode-secret",
    });
    const environment = { HOME: "/workspace" };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
      codemodeTokenSeed: "ogd_turn_start",
      codemodeTokenSessionId: "session-lazy",
    });
    const commands: string[] = [];
    const backend = {
      state: { manifest: buildManifest(settings, [], environment) },
      exec: async (args: { cmd: string }) => {
        commands.push(args.cmd);
        return { exitCode: 0, output: "" };
      },
    };

    await runOwnedSandboxSetup(agent, backend as never, backend as never, {
      settings,
      environment,
      codemodeTokenSeedOverride: "ogd_provisioning_time",
    });

    const seedCommand = commands.find((command) =>
      command.includes("OPENGENI_CODEMODE_TOKEN_SEED"),
    );
    expect(seedCommand).toContain("ogd_provisioning_time");
    expect(seedCommand).not.toContain("ogd_turn_start");
  });

  test("owned setup overlaps the Codemode token seed with repository setup", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      webSearchEnabled: false,
      delegationSecret: "codemode-secret",
    });
    const environment = { HOME: "/workspace" };
    const agent = buildOpenGeniAgent(
      settings,
      [{ kind: "repository", uri: "https://github.com/acme/app.git", ref: "main" }],
      {
        model: new ScriptedModel([]),
        sandboxEnvironment: environment,
        codemodeTokenSeed: "ogd_seed",
        codemodeTokenSessionId: "session-overlap",
      },
    );
    let releaseSeed!: () => void;
    const seedGate = new Promise<void>((resolve) => {
      releaseSeed = resolve;
    });
    let seedFinished = false;
    let cloneStartedBeforeSeedFinished = false;
    const backend = {
      state: { manifest: buildManifest(settings, [], environment) },
      exec: async (args: { cmd: string }) => {
        if (args.cmd.includes("OPENGENI_CODEMODE_TOKEN_SEED")) {
          await seedGate;
          seedFinished = true;
        } else if (args.cmd.includes("/.opengeni/setup-programs")) {
          cloneStartedBeforeSeedFinished ||= !seedFinished;
          releaseSeed();
        }
        return { exitCode: 0, output: "" };
      },
    };

    // Owned callers register token renewal only after setup returns, so the
    // seed does not gate the ordered credential and repository chain. If it
    // did, the clone would wait for a seed that only the clone releases.
    const setup = runOwnedSandboxSetup(agent, backend as never, backend as never, {
      settings,
      environment,
    }).catch(() => undefined);
    const settled = await Promise.race([
      setup.then(() => "settled" as const),
      Bun.sleep(2_000).then(() => "stalled" as const),
    ]);
    releaseSeed();
    await setup;
    expect(settled).toBe("settled");
    expect(cloneStartedBeforeSeedFinished).toBe(true);
    expect(seedFinished).toBe(true);
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
      execCmds.some((cmd) => cmd.includes("/tmp/opengeni/rig-setup/rig-setup-ver-9.done")),
    ).toBe(true);
  });

  test("durable rig coordinator can reuse immutable setup before turn-private hooks", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = { HOME: "/workspace" };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
      rigSetup: {
        rigId: "rig-1",
        rigName: "dev-machine",
        versionId: "ver-shared",
        script: "echo immutable setup",
        timeoutMs: 60_000,
      },
    });
    const commands: string[] = [];
    const events: string[] = [];
    const backend = {
      state: { manifest: buildManifest(settings, [], environment) },
      exec: async (args: { cmd: string }) => {
        commands.push(args.cmd);
        return { exitCode: 0, output: "" };
      },
    };
    let coordinatedSpecHash = "";

    await runOwnedSandboxSetup(agent, backend as never, backend as never, {
      settings,
      environment,
      onRuntimeEvent: (event) => events.push(event.type),
      coordinateSharedRigSetup: async ({ specHash }) => {
        coordinatedSpecHash = specHash;
        return "reused";
      },
    });

    expect(coordinatedSpecHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(commands).toEqual([]);
    expect(events).toEqual(["rig.setup.started", "rig.setup.skipped"]);
  });

  test("connected-machine setup delivers verified attachments without running platform hooks", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = { HOME: "/workspace" };
    const resources = [{ kind: "file" as const, fileId: "file-1" }];
    const downloads = [
      {
        fileId: "file-1",
        mountPath: ".opengeni/files/file-1",
        filename: "input.txt",
        url: "https://storage.example/input.txt?sig=secret",
        sizeBytes: 5,
        sha256: "a".repeat(64),
      },
    ];
    const agent = buildOpenGeniAgent(settings, resources, {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
      activeSandboxBackend: "selfhosted",
      sandboxWorkspaceRoot: "/srv/project",
      fileResourceDownloads: downloads,
      rigSetup: {
        rigId: "rig-1",
        rigName: "must-not-run",
        versionId: "selfhosted-forbidden",
        script: "echo platform-hook-ran",
        timeoutMs: 60_000,
      },
    });
    const commands: Array<{ cmd: string; workdir?: string }> = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const backend = {
      state: {
        manifest: buildManifest(settings, resources, environment, downloads, {
          root: "/srv/project",
          includeResourceEntries: false,
        }),
      },
      exec: async (args: { cmd: string; workdir?: string }) => {
        commands.push(args);
        return { exitCode: 0, output: "" };
      },
    };

    await runOwnedSandboxSetup(agent, backend as never, backend as never, {
      settings,
      environment,
      onRuntimeEvent: (event) => {
        events.push(event as (typeof events)[number]);
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]?.workdir).toBe("/srv/project");
    expect(commands[0]?.cmd).toContain(".opengeni/files/file-1/input.txt");
    expect(commands[0]?.cmd).not.toContain("/workspace/.opengeni/files/file-1/input.txt");
    expect(commands[0]?.cmd).not.toContain("platform-hook-ran");
    expect(commands[0]?.cmd).toContain('actual_size=$(wc -c < "$candidate"');
    expect(commands[0]?.cmd).toContain('actual_sha=$(sha256sum "$candidate"');
    expect(JSON.stringify(events)).toContain("/srv/project/.opengeni/files/file-1/input.txt");
    expect(JSON.stringify(events)).not.toContain("sig=secret");
  });

  test("runOwnedSandboxSetup routes lifecycle commands through the attempt cancellation fence", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = { HOME: "/workspace" };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
      rigSetup: {
        rigId: "rig-1",
        rigName: "dev-machine",
        versionId: "ver-cancellable",
        script: "sleep 60",
        timeoutMs: 60_000,
      },
    });
    const backend = {
      state: { manifest: buildManifest(settings, [], environment) },
      exec: async () => {
        throw new Error("lifecycle command bypassed the cancellation fence");
      },
    };
    const commands: string[] = [];

    await runOwnedSandboxSetup(agent, backend as never, backend as never, {
      settings,
      environment,
      commandRunner: async (session, args) => {
        expect(session).toBe(backend);
        commands.push(args.cmd);
        return { exitCode: 0, output: "" };
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("sleep 60");
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
