// P1.2 ownership inversion — the keystone regression, run creds-free against the
// in-tree unix_local backend (no provider creds, no OpenAI key — a ScriptedModel
// drives the agent). This exercises the REAL production runAgentStream owned
// branch (not a hand-rolled run() like spikes/sdk-keystone), proving:
//
//   (KEYSTONE) an injected NON-OWNED session SURVIVES a normal runAgentStream
//              finish un-reaped (session.closed === false, workspace intact);
//   (CONTROL)  an OWNED (sessionState-resumed) session IS reaped on the same
//              normal finish — so the "survived" result is a real distinction.
//
// Plus unit coverage for the two new leaf primitives:
//   - establishSandboxSessionFromEnvelope (cold create + warm resume-by-id)
//   - isProviderSandboxNotFoundError (the per-backend NotFound discriminator)
//   - createSandboxClientForBackend (explicit-backend builder)
//
// No DB, no Docker, no network. The lease-driven slice (acquire -> resume ->
// release) is the DB-backed apps/worker/test/sandbox-resume.integration.ts.

import { existsSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { run } from "@openai/agents";
import { SandboxAgent } from "@openai/agents/sandbox";
import { ScriptedModel, functionCall, assistantMessage } from "@opengeni/testing";
import { testSettings } from "@opengeni/testing";
import {
  buildManifest,
  buildOpenGeniAgent,
  runAgentStream,
  createSandboxClientForBackend,
  establishSandboxSessionFromEnvelope,
  isProviderSandboxGoneDuringRoutedOperation,
  isProviderSandboxNotFoundError,
} from "../src/index";

// local backend, web search OFF (the hosted web_search tool would try the
// network), one canonical history store, one model call per turn cap is
// fine — the scripted model finishes in 2 calls (shell -> final message).
function localSettings() {
  return testSettings({ sandboxBackend: "local", webSearchEnabled: false });
}

type LiveLocalSession = {
  closed: boolean;
  state: { workspaceRootPath: string };
  close: () => Promise<void>;
  exec: (args: { cmd: string }) => Promise<{ stdout?: string }>;
  readFile: (args: { path: string }) => Promise<Uint8Array>;
};

const liveSessions: LiveLocalSession[] = [];

afterEach(async () => {
  // Drop any still-open live session we created (we own them; the SDK never did).
  for (const s of liveSessions.splice(0)) {
    if (!s.closed) {
      await s.close().catch(() => undefined);
    }
  }
});

describe("P1.2 ownership inversion — runAgentStream owned branch (unix_local, creds-free)", () => {
  test("KEYSTONE: an injected NON-OWNED session survives a normal runAgentStream finish un-reaped", async () => {
    const settings = localSettings();
    const client = createSandboxClientForBackend("local", settings) as unknown as {
      backendId: string;
      create: (m?: unknown) => Promise<LiveLocalSession>;
    };
    expect(client.backendId).toBe("unix_local");

    // The externally-owned live box (the lease owns it in production; here WE own
    // it). We inject THIS exact handle non-owned — the SDK must never reap it.
    const liveSession = await client.create({});
    liveSessions.push(liveSession);
    const root = liveSession.state.workspaceRootPath;
    expect(liveSession.closed).toBe(false);
    expect(existsSync(root)).toBe(true);

    const model = new ScriptedModel([
      {
        output: [
          functionCall("exec_command", { cmd: "echo KEYSTONE_P12 > /workspace/marker.txt" }),
        ],
      },
      { output: [assistantMessage("done")] },
    ]);
    const agent = buildOpenGeniAgent(settings, [], { model });

    const result = await runAgentStream(agent, "write the marker", settings, {
      ownedSandbox: {
        client,
        session: liveSession,
        // cold session: no prior sessionState. The owned branch threads the live
        // session straight through; the SDK registers it NON-OWNED.
      },
    });
    // Drain the stream so the run reaches its normal finish (end-of-run cleanup
    // is where an OWNED session would be reaped — see the control below).
    for await (const _ of result.toStream()) {
      void _;
    }
    await result.completed;

    // ── KEYSTONE ASSERTIONS ──
    expect(liveSession.closed).toBe(false); // never closed
    expect(existsSync(root)).toBe(true); // close() would rm -rf it
    const marker = await liveSession.readFile({ path: "/workspace/marker.txt" }).then(
      (b) => Buffer.from(b).toString().trim(),
      () => "<missing>",
    );
    expect(marker).toBe("KEYSTONE_P12"); // the tool hit OUR box
  });

  test("CONTROL: an OWNED (sessionState-resumed) session IS reaped on a normal finish", async () => {
    // The reap distinction at the SDK level: a session resumed from sessionState
    // (priority-3) is marked OWNED and torn down on a normal finish — unlike the
    // non-owned injected session above. We use a minimal SandboxAgent with NO
    // runAs (so the unix_local manifest carries no users) + a raw SDK run(),
    // mirroring spikes/sdk-keystone but inside the runtime package.
    const settings = localSettings();
    const client = createSandboxClientForBackend("local", settings) as unknown as {
      backendId: string;
      create: (m?: unknown) => Promise<LiveLocalSession>;
      serializeSessionState: (state: unknown) => Promise<Record<string, unknown>>;
    };
    const seed = await client.create({});
    const ownedRoot = seed.state.workspaceRootPath;
    await seed.exec({ cmd: "echo OWNED > /workspace/owned.txt" });
    const ownedState = await client.serializeSessionState(
      (seed as unknown as { state: unknown }).state,
    );
    expect(existsSync(ownedRoot)).toBe(true);

    const model = new ScriptedModel([{ output: [assistantMessage("owned done")] }]);
    const agent = new SandboxAgent({
      name: "keystone-control",
      instructions: "control agent",
      model,
    });

    // sandbox: { client, sessionState } -> the SDK resumes a NEW session from the
    // state (reusing the SAME workspace root) and marks it OWNED, so a normal
    // finish reaps it (close() -> rm -rf the workspace root).
    await run(agent, "owned turn", {
      sandbox: { client: client as never, sessionState: ownedState as never },
    });

    expect(existsSync(ownedRoot)).toBe(false); // the OWNED resumed session was reaped
  });
});

describe("P1.2 establishSandboxSessionFromEnvelope (unix_local)", () => {
  test("a null envelope cold-creates a live session (the cold-session path)", async () => {
    const settings = localSettings();
    const established = await establishSandboxSessionFromEnvelope(settings, null, {
      sessionId: "sess-cold",
      recovery: "create-or-restore",
      backendOverride: "local",
    });
    expect(established.backendId).toBe("unix_local");
    expect(established.session).toBeDefined();
    // close it (we own it) so the workspace dir is cleaned.
    await (established.session as { close: () => Promise<void> }).close().catch(() => undefined);
  });

  test("backendOverride selects the client backend independent of settings.sandboxBackend", async () => {
    // settings says 'none', but the override forces 'local' (resume-by-id is
    // fenced to the box's ORIGINAL backend, not the process default).
    const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });
    const established = await establishSandboxSessionFromEnvelope(settings, null, {
      sessionId: "sess-override",
      recovery: "create-or-restore",
      backendOverride: "local",
    });
    expect(established.backendId).toBe("unix_local");
    await (established.session as { close: () => Promise<void> }).close().catch(() => undefined);
  });

  test("the box is created with the SAME manifest environment the agent declares (no provided-session env delta)", async () => {
    // BUG-1 regression (the turn-killer). The box is injected NON-OWNED and the
    // SDK then applies the AGENT's declared manifest to it as a provided-session
    // delta; applyManifestToProvidedSession throws on ANY environment delta. So
    // the box's manifest environment MUST equal the agent's declared environment.
    // The agent declares buildManifest(...).environment === sandboxEnvironment;
    // here we prove establishSandboxSessionFromEnvelope, given that same env via
    // opts.environment, creates a box whose manifest carries exactly that env.
    const settings = localSettings();
    // The minimal real-world delta the live failure surfaced even with NO
    // workspace env: stable git identity + HOME (plus an arbitrary extra var).
    const sandboxEnvironment: Record<string, string> = {
      GIT_AUTHOR_NAME: "OpenGeni Bot",
      GIT_AUTHOR_EMAIL: "bot@opengeni.dev",
      HOME: "/workspace",
      MY_VAR: "value-123",
    };

    // The agent's declared manifest (what the SDK compares the box against).
    const agentManifest = buildManifest(settings, [], sandboxEnvironment);
    const agentEnv = Object.fromEntries(
      Object.entries(agentManifest.environment).map(([k, v]) => [
        k,
        (v as { value?: string }).value,
      ]),
    );

    const established = await establishSandboxSessionFromEnvelope(settings, null, {
      sessionId: "sess-env",
      recovery: "create-or-restore",
      backendOverride: "local",
      environment: sandboxEnvironment,
    });
    try {
      const boxManifest = (
        established.session as {
          state: { manifest: { environment: Record<string, { value?: string }> } };
        }
      ).state.manifest;
      const boxEnv = Object.fromEntries(
        Object.entries(boxManifest.environment).map(([k, v]) => [k, v.value]),
      );
      // Every variable the agent declares is present on the box manifest with the
      // identical value -> serializeManifestEnvironment(box) has no delta vs the
      // agent's, so validateNoEnvironmentDelta passes.
      for (const [key, value] of Object.entries(agentEnv)) {
        expect(boxEnv[key]).toBe(value);
      }
      // And the box declares the same manifest root the agent does (the root-delta
      // guard also fires on a mismatch).
      expect((boxManifest as unknown as { root: string }).root).toBe(
        (agentManifest as unknown as { root: string }).root,
      );
    } finally {
      await (established.session as { close: () => Promise<void> }).close().catch(() => undefined);
    }
  });
});

describe("P1.2 isProviderSandboxNotFoundError (per-backend NotFound discriminator)", () => {
  test("404 status -> NotFound (licenses cold-restore)", () => {
    expect(isProviderSandboxNotFoundError("modal", { status: 404 })).toBe(true);
    expect(isProviderSandboxNotFoundError("e2b", { statusCode: 404 })).toBe(true);
  });

  test("generic numeric gRPC status 5 is not provider NotFound evidence", () => {
    expect(isProviderSandboxNotFoundError("modal", { code: 5 })).toBe(false);
    expect(isProviderSandboxNotFoundError("modal", { status: 5 })).toBe(false);
    expect(isProviderSandboxNotFoundError("modal", { statusCode: 5 })).toBe(false);
  });

  test("only typed codes and Modal's exact terminal grammar are NotFound", () => {
    expect(
      isProviderSandboxNotFoundError(
        "modal",
        new Error("Modal sandbox sb-123 not found (has been terminated)"),
      ),
    ).toBe(true);
    expect(isProviderSandboxNotFoundError("modal", new Error("Sandbox sb-123 not found"))).toBe(
      false,
    );
    expect(
      isProviderSandboxNotFoundError("e2b", new Error("the sandbox is no longer running")),
    ).toBe(false);
    expect(
      isProviderSandboxNotFoundError("daytona", { code: "SANDBOX_NOT_FOUND", message: "gone" }),
    ).toBe(true);
  });

  test("transient typed evidence dominates nested NotFound prose", () => {
    expect(
      isProviderSandboxNotFoundError("modal", {
        code: "UNAVAILABLE",
        status: 14,
        cause: { code: "NOT_FOUND", message: "Modal sandbox sb-old not found" },
      }),
    ).toBe(false);
    expect(
      isProviderSandboxNotFoundError("modal", {
        code: "ENOTFOUND",
        message: "Name resolution failed: sandbox not found",
      }),
    ).toBe(false);
  });

  test("a resume-conflict / still-running / generic error is NOT NotFound (never recreate -> never double-spawn)", () => {
    expect(isProviderSandboxNotFoundError("modal", new Error("sandbox already running"))).toBe(
      false,
    );
    expect(isProviderSandboxNotFoundError("modal", new Error("sandbox is still running"))).toBe(
      false,
    );
    expect(isProviderSandboxNotFoundError("modal", new Error("503 service unavailable"))).toBe(
      false,
    );
    expect(isProviderSandboxNotFoundError("modal", new Error("network timeout"))).toBe(false);
    expect(isProviderSandboxNotFoundError("modal", { status: 500 })).toBe(false);
    expect(isProviderSandboxNotFoundError("modal", null)).toBe(false);
    expect(isProviderSandboxNotFoundError("modal", undefined)).toBe(false);
  });
});

describe("OPE-60 routed-operation sandbox disappearance discriminator", () => {
  test("generic 404 and NOT_FOUND subresource errors do not retire the provider sandbox", () => {
    expect(isProviderSandboxGoneDuringRoutedOperation("modal", { status: 404 })).toBe(false);
    expect(
      isProviderSandboxGoneDuringRoutedOperation("modal", {
        code: "NOT_FOUND",
        status: 404,
        message: "/workspace/missing.txt not found",
      }),
    ).toBe(false);
    expect(
      isProviderSandboxGoneDuringRoutedOperation("modal", {
        code: "RESOURCE_NOT_FOUND",
        message: "exposed port not found",
      }),
    ).toBe(false);
  });

  test("sandbox-scoped typed evidence and Modal terminal grammar retire the exact sandbox", () => {
    expect(
      isProviderSandboxGoneDuringRoutedOperation("daytona", {
        code: "SANDBOX_NOT_FOUND",
        message: "sandbox is gone",
      }),
    ).toBe(true);
    expect(
      isProviderSandboxGoneDuringRoutedOperation(
        "modal",
        new Error("Modal sandbox sb-123 not found (has been terminated)"),
      ),
    ).toBe(true);
    expect(
      isProviderSandboxGoneDuringRoutedOperation(
        "modal",
        new Error("Modal sandbox sb-123 is no longer running."),
      ),
    ).toBe(true);
  });

  test("transient transport evidence dominates nested sandbox disappearance", () => {
    expect(
      isProviderSandboxGoneDuringRoutedOperation("modal", {
        code: "UNAVAILABLE",
        status: 14,
        cause: { code: "SANDBOX_NOT_FOUND" },
      }),
    ).toBe(false);
  });
});

describe("owned-path beforeAgentStart hooks — the provided-session blind spot", () => {
  // The SDK NEVER calls client.create/resume when runOptions.sandbox carries a live
  // `session` (SandboxRuntimeManager.prepareAgent uses sandboxConfig.session as-is),
  // so the create/resume decoration alone can never run lifecycle hooks on the
  // lease-owned box. runAgentStream's owned branch must therefore run them DIRECTLY
  // against the provided session — this is what executes the repository-clone hook
  // (which also seeds the B1 askpass + token file) on production turns. Regression:
  // hooks silently stopped running when sandbox ownership was enabled, which left
  // boxes with an empty repo mount dir and no git auth at all.
  test("repository-clone hook (with B1 token seed) runs against the provided session before the turn", async () => {
    const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
    const repoResource = {
      kind: "repository" as const,
      uri: "https://github.com/example/repo.git",
      ref: "main",
      mountPath: "repos/example/repo",
      // installation+repository ids make repositoryUsesSandboxClone() true on the
      // local backend, mirroring the GitHub-App resources production sessions carry.
      githubInstallationId: 1,
      githubRepositoryId: 2,
    };
    const environment = { HOME: "/workspace", GIT_ASKPASS: "/workspace/.opengeni/askpass" };
    const model = new ScriptedModel([{ output: [assistantMessage("done, no tools")] }]);
    const agent = buildOpenGeniAgent(settings, [repoResource], {
      model,
      sandboxEnvironment: environment,
      gitTokenSeed: "seed-token-e2e",
    });

    // Stub live box: records execs; its manifest mirrors the agent's default manifest
    // so applyManifestToProvidedSession sees no delta to apply.
    const execCalls: Array<{ cmd: string }> = [];
    const providedSession = {
      state: { manifest: buildManifest(settings, [repoResource], environment) },
      exec: async (args: { cmd: string }) => {
        execCalls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      // The SDK's filesystem/shell/skills capabilities require these at prepare
      // time even when the scripted turn never touches a tool.
      createEditor: () => ({}),
      execCommand: async (args: { cmd: string }) => {
        execCalls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      pathExists: async () => false,
      materializeEntry: async () => undefined,
    };
    const stubClient = {
      backendId: "unix_local",
      serializeSessionState: async () => ({}),
    };

    const result = await runAgentStream(agent, "just answer", settings, {
      ownedSandbox: {
        client: stubClient as never,
        session: providedSession as never,
      },
    });
    for await (const _ of result.toStream()) {
      void _;
    }
    await result.completed;

    // The clone/seed command hit the PROVIDED box exactly once, before the turn —
    // carrying both the off-manifest token seed and the clone script.
    const cloneExecs = execCalls.filter((c) => c.cmd.includes("clone_repository"));
    expect(cloneExecs.length).toBe(1);
    expect(cloneExecs[0]!.cmd).toContain("OPENGENI_GIT_TOKEN_SEED");
    expect(cloneExecs[0]!.cmd).toContain("seed-token-e2e");
    expect(cloneExecs[0]!.cmd).toContain("repos/example/repo");
  });

  test("connected machine (effective backend selfhosted): NO platform setup exec touches the user's box", async () => {
    // A connected machine is the user's real computer. The clone hooks are already
    // excluded at construction for selfhosted; the direct owned-path hook run must
    // skip the built-in hooks (az login) there too — even when the session carries
    // an azure-credentialed workspace Environment.
    const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
    const environment = {
      HOME: "/workspace",
      ARM_CLIENT_ID: "cid",
      ARM_CLIENT_SECRET: "secret",
      ARM_TENANT_ID: "tid",
    };
    const model = new ScriptedModel([{ output: [assistantMessage("done, no tools")] }]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      sandboxEnvironment: environment,
      activeSandboxBackend: "selfhosted",
    });

    const execCalls: Array<{ cmd: string }> = [];
    const providedSession = {
      state: { manifest: buildManifest(settings, [], environment) },
      exec: async (args: { cmd: string }) => {
        execCalls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      createEditor: () => ({}),
      execCommand: async (args: { cmd: string }) => {
        execCalls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      pathExists: async () => false,
      materializeEntry: async () => undefined,
    };

    const result = await runAgentStream(agent, "just answer", settings, {
      ownedSandbox: {
        client: { backendId: "unix_local", serializeSessionState: async () => ({}) } as never,
        session: providedSession as never,
      },
    });
    for await (const _ of result.toStream()) {
      void _;
    }
    await result.completed;

    expect(execCalls.length).toBe(0);
  });
});
