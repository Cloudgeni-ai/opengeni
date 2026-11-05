import { describe, expect, test } from "bun:test";
import { SandboxProviderError } from "@openai/agents/sandbox";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildManifest,
  buildOpenGeniAgent,
  runOwnedSandboxSetup,
  takeSandboxSetupNotices,
} from "../src/index";
import { SelfhostedControlError } from "../src/sandbox/selfhosted/control-rpc";

// Imported lazily so the setup regressions above run (and fail) on code
// that predates this module.
async function softFailure() {
  return await import("../src/sandbox-setup-soft-failure");
}

async function lifecycleCommandError() {
  return await import("../src/sandbox/lifecycle-command-error");
}

const environment = { HOME: "/workspace" };

function modalAgent() {
  const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
  const agent = buildOpenGeniAgent(settings, [], {
    model: new ScriptedModel([]),
    sandboxEnvironment: environment,
    codemodeTokenSeed: "fixture-token",
    codemodeTokenSessionId: "fixture-session",
  });
  return { settings, agent };
}

/** A Modal box whose /workspace is full: every platform write fails. */
function fullDiskBox(settings: ReturnType<typeof testSettings>) {
  const commands: string[] = [];
  return {
    commands,
    state: { manifest: buildManifest(settings, [], environment) },
    exec: async ({ cmd }: { cmd: string }) => {
      commands.push(cmd);
      return {
        exitCode: 1,
        output: "mkdir: cannot create directory '/workspace/.opengeni': No space left on device",
      };
    },
    createEditor: () => ({
      createFile: async () => {
        throw new Error("write /workspace/.opengeni/stage.json: No space left on device");
      },
      deleteFile: async () => undefined,
    }),
  };
}

/** What Modal returns (exit 128) for any exec once /bin/sh is gone. */
const MODAL_SHELL_MISSING =
  'executing processes for container: executing command "/bin/sh -c export X=1\\necho hi" in sandbox: failed to load /bin/sh: no such file or directory';

describe("platform setup on a damaged box", () => {
  test("a full /workspace starts the turn with a notice instead of failing it", async () => {
    const { settings, agent } = modalAgent();
    const box = fullDiskBox(settings);
    const preparedInput = { input: "hello" };
    await runOwnedSandboxSetup(agent, box as never, box as never, {
      settings,
      environment,
      preparedInput: preparedInput as never,
    });
    expect(box.commands.length).toBeGreaterThan(0);
    expect(preparedInput.input).toStartWith("hello\n\nPlatform setup notice:");
    expect(preparedInput.input).toContain(
      "- Opengeni tools in the shell (ogtool and the Codemode client) were not installed. No space left on the workspace machine's disk. Free space in /workspace or /tmp",
    );
    expect(preparedInput.input).toContain(
      "- The Opengeni tools sign-in for the shell was not saved, so ogtool calls can fail. No space left on the workspace machine's disk.",
    );
  });

  test("lazy setup on a full /workspace lets the first tool call run", async () => {
    const { settings, agent } = modalAgent();
    const box = fullDiskBox(settings);
    await runOwnedSandboxSetup(agent, box as never, box as never, {
      settings,
      environment,
      recordLazyManifest: true,
    });
    // No turn input is left to add to: the notice is held for the next shell
    // result (sandbox-setup-notices.ts).
    const held = takeSandboxSetupNotices(agent);
    expect(held).toStartWith("Platform setup notice:");
    expect(held).toContain("No space left on the workspace machine's disk");
  });

  test("a /workspace/.opengeni replaced by a file starts the turn with a notice", async () => {
    // Staging repro (4 Nov 2026): `printf x > /workspace/.opengeni`. The SDK's
    // path probe exits 2 under a parent that is not a folder and reports only
    // the path, so every later turn failed before the model could move it.
    const { settings, agent } = modalAgent();
    const blocked = (path: string) =>
      new SandboxProviderError(`ModalSandboxClient failed to check path ${path}`, {
        provider: "modal",
        path,
        status: 2,
        signal: null,
        timedOut: false,
        stdoutBytes: 0,
      });
    const box = {
      state: { manifest: buildManifest(settings, [], environment) },
      // Nothing is installed yet, and no write under the blocked path works.
      exec: async () => ({ exitCode: 1, output: "" }),
      createEditor: () => ({
        createFile: async ({ path }: { path: string }) => {
          throw blocked(path);
        },
        deleteFile: async () => undefined,
      }),
    };
    const preparedInput = { input: "hello" };
    await runOwnedSandboxSetup(agent, box as never, box as never, {
      settings,
      environment,
      preparedInput: preparedInput as never,
    });
    expect(preparedInput.input).toContain(
      "- Opengeni tools in the shell (ogtool and the Codemode client) were not installed. A path is blocked by a file or folder of the wrong kind.",
    );
    // A probe that timed out or was killed is no such proof.
    const { softSetupFailureCause } = await softFailure();
    expect(
      softSetupFailureCause(
        new SandboxProviderError("ModalSandboxClient failed to check path /workspace/x", {
          status: 2,
          timedOut: true,
        }),
      ),
    ).toBeNull();
  });

  test("a Modal box that cannot start programs still fails setup", async () => {
    const { settings, agent } = modalAgent();
    const box = {
      state: { manifest: buildManifest(settings, [], environment) },
      exec: async () => ({ exitCode: 128, output: MODAL_SHELL_MISSING }),
      createEditor: () => ({
        createFile: async () => {
          throw new Error(`Sandbox path failed remote validation: ${MODAL_SHELL_MISSING}`);
        },
        deleteFile: async () => undefined,
      }),
    };
    await expect(
      runOwnedSandboxSetup(agent, box as never, box as never, { settings, environment }),
    ).rejects.toThrow("failed to load /bin/sh");
  });
});

describe("soft setup failure classification", () => {
  test("hard failures keep failing setup", async () => {
    const { softSetupFailureCause } = await softFailure();
    const offline = new SelfhostedControlError({
      message: "agent offline: No space left on device",
      code: "unavailable" as never,
      reason: "agent_offline",
      retryable: true,
      agentOffline: true,
    });
    expect(softSetupFailureCause(offline)).toBeNull();
    expect(
      softSetupFailureCause(
        new Error(`Codemode token seed hook failed with exit code 128:\n${MODAL_SHELL_MISSING}`),
      ),
    ).toBeNull();
    expect(
      softSetupFailureCause(
        new Error(
          "Codemode token seed hook did not finish before the lifecycle command timeout: No space left on device",
        ),
      ),
    ).toBeNull();
    const cancelled = new Error("No space left on device");
    cancelled.name = "TurnOperationCancelledError";
    expect(softSetupFailureCause(cancelled)).toBeNull();
    expect(softSetupFailureCause(new Error("Modal API unavailable"))).toBeNull();
    // Sanitized copies drop Modal's "in sandbox:" prefix.
    expect(
      softSetupFailureCause(new Error("No space left on device; failed to load /bin/sh")),
    ).toBeNull();
    const commandCancelled = new Error("No space left on device");
    commandCancelled.name = "TurnSandboxCommandCancelledError";
    expect(softSetupFailureCause(commandCancelled)).toBeNull();
    expect(
      softSetupFailureCause(
        new Error(
          'spawn or apply execution containment for program "sh" (the null device /dev/null is missing): No such file or directory (os error 2)',
        ),
      ),
    ).toBeNull();
  });

  test("causes the model can fix are recognised through wrappers", async () => {
    const { softSetupFailureCause, softSetupFailureNotice } = await softFailure();
    const wrapped = new Error("Failed to run function tools", {
      cause: new Error("Sandbox path failed remote validation", {
        cause: new Error("mkdir: cannot create directory: No space left on device"),
      }),
    });
    expect(softSetupFailureCause(wrapped)).toEqual({ kind: "no_space" });
    const { SandboxLifecycleCommandExitError } = await lifecycleCommandError();
    const blockedOutput = "mkdir: /workspace/.opengeni: Not a directory";
    expect(
      softSetupFailureCause(
        new SandboxLifecycleCommandExitError("Codemode token seed hook failed", 1, blockedOutput),
        "codemode-token",
      ),
    ).toEqual({ kind: "path_blocked" });
    const nodeError = Object.assign(new Error("EACCES: permission denied, open '/workspace/x'"), {
      code: "EACCES",
      syscall: "open",
      path: "/workspace/x",
    });
    expect(softSetupFailureCause(nodeError, "codemode-client")).toEqual({
      kind: "permission_denied",
    });
    // The worker's own file (a shipped asset) is not the box's state.
    const workerFile = Object.assign(
      new Error("EACCES: permission denied, open '/app/codemode/client.mjs'"),
      { code: "EACCES", syscall: "open", path: "/app/codemode/client.mjs" },
    );
    expect(softSetupFailureCause(workerFile, "codemode-client")).toBeNull();
    // The document tools check reads the image's tools, not /workspace.
    expect(
      softSetupFailureCause(
        new SandboxLifecycleCommandExitError(
          "Artifact runtime doctor failed with exit code 1",
          1,
          "/usr/bin/soffice: Permission denied",
        ),
        "artifact-runtime-doctor",
      ),
    ).toEqual({ kind: "command_failed", exitCode: 1 });
    expect(
      softSetupFailureCause(
        new SandboxLifecycleCommandExitError("Repository clone hook failed", 128, "fatal"),
        "repository-clone",
      ),
    ).toEqual({ kind: "command_failed", exitCode: 128 });
    expect(
      softSetupFailureNotice([{ hookId: "repository-clone", cause: { kind: "read_only" } }]),
    ).toBe(
      "Platform setup notice: part of this workspace machine's setup failed, and the turn continued without it.\n- Repository setup did not finish, so a repository or its Git credentials can be missing or out of date. The file system is read-only. Make /workspace writable again; then repository setup runs again at the start of the next turn.",
    );
  });

  test("only platform hooks fail softly; rig setup still fails", async () => {
    const { softFailingSetupHooks } = await softFailure();
    const failures: unknown[] = [];
    const failing = (id: string) => ({
      id,
      phase: "beforeAgentStart" as const,
      run: async () => {
        throw new Error("No space left on device");
      },
    });
    const [codemode, rig] = softFailingSetupHooks(
      [failing("codemode-client"), failing("rig-setup")],
      failures as never,
    );
    await codemode!.run({} as never, { environment: {} });
    expect(failures).toEqual([{ hookId: "codemode-client", cause: { kind: "no_space" } }]);
    await expect(rig!.run({} as never, { environment: {} })).rejects.toThrow("No space left");
  });
});

describe("a cause belongs to the step that reported it", () => {
  test("git's own 'Permission denied' is a clone failure, not a /workspace permission problem", async () => {
    const { softFailingSetupHooks, softSetupFailureNotice } = await softFailure();
    const { SandboxLifecycleCommandExitError } = await lifecycleCommandError();
    const failures: Array<{ hookId: string; cause: unknown }> = [];
    const [clone] = softFailingSetupHooks(
      [
        {
          id: "repository-clone",
          phase: "beforeAgentStart",
          run: async () => {
            throw new SandboxLifecycleCommandExitError(
              "Repository clone hook failed with exit code 128",
              128,
              "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
            );
          },
        },
      ],
      failures as never,
    );
    await clone!.run({} as never, { environment: {} });
    expect(failures).toEqual([
      { hookId: "repository-clone", cause: { kind: "command_failed", exitCode: 128 } },
    ]);
    expect(softSetupFailureNotice(failures as never)).toContain(
      "Its setup command exited with code 128. Run the git clone or git fetch for the repository yourself to see the error; then repository setup runs again at the start of the next turn.",
    );
    expect(
      softSetupFailureNotice([
        { hookId: "azure-cli-login", cause: { kind: "command_failed", exitCode: 1 } },
      ]),
    ).toContain("Run az login yourself to see the error;");
  });

  test("only a lifecycle command's own exit is a command failure", async () => {
    const { softSetupFailureCause } = await softFailure();
    // Message text alone proves nothing: any error can say these words.
    expect(
      softSetupFailureCause(
        new Error("Credential broker failed with exit code 3"),
        "codemode-token",
      ),
    ).toBeNull();
    expect(
      softSetupFailureCause(new Error("API said: permission denied"), "repository-clone"),
    ).toBeNull();
    expect(softSetupFailureCause(new Error("upstream: file exists"), "codemode-client")).toBeNull();
  });
});

describe("run credential files on a damaged box", () => {
  async function materializeOn(output: string) {
    const { materializeRunCredentials, normalizeRunCredentialsResolution } =
      await import("../src/sandbox");
    const scope = { accountId: "account-a", workspaceId: "workspace-a", sessionId: "session-a" };
    const material = normalizeRunCredentialsResolution(
      {
        status: "ok",
        ...scope,
        environment: { FIXTURE_TOKEN: "fixture-credential-value" },
        files: [],
        fileEnvironment: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      } as never,
      scope,
    );
    const session = { exec: async () => ({ exitCode: 1, output }) };
    return await materializeRunCredentials(session as never, material!, {
      sessionId: "session-a",
      attemptId: "attempt-a",
      executionGeneration: 1,
    }).then(
      () => null,
      (error: unknown) => error,
    );
  }

  test("a full disk is a soft failure, and only the disk phrase leaves the command output", async () => {
    const { softRunCredentialWriteFailure } = await softFailure();
    const error = await materializeOn(
      "fixture-credential-value\nbash: line 4: /tmp/opengeni-run-credentials/x/env: No space left on device",
    );
    expect(error).toBeInstanceOf(Error);
    expect(softRunCredentialWriteFailure(error)).toEqual({
      hookId: "run-credentials",
      cause: { kind: "no_space" },
    });
    const kept = JSON.stringify([
      (error as Error).message,
      ((error as Error).cause as Error | undefined)?.message,
    ]);
    expect(kept).not.toContain("fixture-credential-value");
    expect(kept).not.toContain("/tmp/opengeni-run-credentials");
  });

  test("a box that cannot start programs, or any other failure, still fails setup", async () => {
    const { softRunCredentialWriteFailure } = await softFailure();
    expect(softRunCredentialWriteFailure(await materializeOn(MODAL_SHELL_MISSING))).toBeNull();
    expect(softRunCredentialWriteFailure(await materializeOn("decoder failed"))).toBeNull();
  });
});
