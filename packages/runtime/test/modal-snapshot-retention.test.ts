import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { Manifest, type SandboxSessionLike } from "@openai/agents/sandbox";
import { ModalSandboxClient } from "@openai/agents-extensions/sandbox/modal";
import { testSettings } from "@opengeni/testing";
import { ModalClient } from "modal";
import {
  OpenGeniModalSandboxClient,
  installOpenGeniModalSnapshotPolicy,
  isModalExecAlreadyCompletedError,
  modalProvider,
} from "../src/sandbox/providers/modal";
import { discoverWorkspaceSkills } from "../src/workspace-skills";

type Persistence = "tar" | "snapshot_filesystem" | "snapshot_directory";
const SNAPSHOT_REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function fakeSession(
  persistence: Persistence,
  sandbox?: Record<string, unknown>,
  sdkVersion = "0.9.0",
) {
  const state = {
    workspacePersistence: persistence,
    snapshotFilesystemTimeoutMs: 120_000,
  };
  const session = {
    modal: { version: () => sdkVersion },
    sandbox,
    state,
    persistWorkspace: mock(async (_options?: { requestId: string }) => {
      if (state.workspacePersistence === "snapshot_filesystem") {
        await (
          session.sandbox?.snapshotFilesystem as
            | ((timeoutMs?: number) => Promise<unknown>)
            | undefined
        )?.(state.snapshotFilesystemTimeoutMs);
      } else if (state.workspacePersistence === "snapshot_directory") {
        await (
          session.sandbox?.snapshotDirectory as ((path: string) => Promise<unknown>) | undefined
        )?.("/workspace");
      }
      return new Uint8Array([1]);
    }),
  };
  return session;
}

function modalExecResponse(output: string, exitCode: number): string {
  return [
    "Chunk ID: modal-test",
    "Wall time: 0.0001 seconds",
    `Process exited with code ${exitCode}`,
    "Output:",
    output,
  ].join("\n");
}

function fakeModalFilesystemSession(root: string) {
  const read = async ({ path, maxBytes }: { path: string; maxBytes?: number }) => {
    const bytes = new Uint8Array(await readFile(path.startsWith("/") ? path : join(root, path)));
    return typeof maxBytes === "number" ? bytes.subarray(0, maxBytes) : bytes;
  };
  const session = Object.assign(fakeSession("tar"), {
    state: {
      ...fakeSession("tar").state,
      manifest: new Manifest({ root }),
    },
    readFile: read,
    execCommand: async ({ cmd }: { cmd: string }) => {
      const child = Bun.spawn(["/bin/bash", "--noprofile", "--norc", "-c", cmd], {
        cwd: root,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return modalExecResponse(`${stdout}${stderr}`, exitCode);
    },
  });
  return { session, read };
}

describe("OpenGeni Modal 0.9 snapshot policy", () => {
  test("the pinned Modal patch binds both native snapshot operations to caller UUIDs", async () => {
    // This is deliberately a distribution-level assertion. The takeover
    // contract depends on the request UUID reaching Modal's protobuf, beneath
    // the adapter mock exercised by the tests below.
    const source = await readFile(fileURLToPath(import.meta.resolve("modal")), "utf8");
    const callerOwnedSnapshotIds = source.match(/params\?\.snapshotId \?\? uuidv4\w*\(\)/g) ?? [];
    expect(callerOwnedSnapshotIds).toHaveLength(2);
  });

  test("the runtime resolves the exact supported Modal SDK", () => {
    const modal = new ModalClient({
      tokenId: "test-token-id",
      tokenSecret: "test-token-secret",
    });
    try {
      expect(modal.version()).toBe("0.9.0");
    } finally {
      modal.close();
    }
  });

  test("translates snapshot_filesystem timeout and disables provider expiry", async () => {
    const snapshotFilesystem = mock(async (_params?: unknown) => ({ imageId: "im-fs" }));
    const session = fakeSession("snapshot_filesystem", { snapshotFilesystem });

    installOpenGeniModalSnapshotPolicy(session);
    await session.persistWorkspace({ requestId: SNAPSHOT_REQUEST_ID });

    expect(snapshotFilesystem).toHaveBeenCalledTimes(1);
    expect(snapshotFilesystem.mock.calls[0]?.[0]).toEqual({
      timeoutMs: 120_000,
      ttlMs: null,
      snapshotId: SNAPSHOT_REQUEST_ID,
    });
  });

  test("refuses an unreceipted indefinite native snapshot", async () => {
    const snapshotFilesystem = mock(async (_params?: unknown) => ({ imageId: "im-fs" }));
    const session = fakeSession("snapshot_filesystem", { snapshotFilesystem });

    installOpenGeniModalSnapshotPolicy(session);

    await expect(session.persistWorkspace()).rejects.toThrow("requires a valid UUID request id");
    expect(snapshotFilesystem).not.toHaveBeenCalled();
  });

  test("current configuration replaces a legacy resume-envelope snapshot timeout", async () => {
    const resumed = fakeSession("snapshot_filesystem", {
      snapshotFilesystem: async () => ({ imageId: "im-resumed" }),
    });
    const resume = spyOn(ModalSandboxClient.prototype, "resume").mockResolvedValue(
      resumed as never,
    );
    const settings = testSettings({
      sandboxBackend: "modal",
      modalAppName: "opengeni-test",
      modalTokenId: "test-token-id",
      modalTokenSecret: "test-token-secret",
      sandboxSnapshotTimeoutMs: 600_000,
    });
    const client = modalProvider.build({
      settings,
      environment: {},
      exposedPorts: [],
    }) as OpenGeniModalSandboxClient;
    const legacyState = {
      snapshotFilesystemTimeoutMs: 60_000,
      durableIdentity: "preserve-me",
    };

    try {
      await client.resume(legacyState as never);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(resume.mock.calls[0]?.[0]).toEqual({
        snapshotFilesystemTimeoutMs: 600_000,
        durableIdentity: "preserve-me",
      });
      expect(legacyState.snapshotFilesystemTimeoutMs).toBe(60_000);
    } finally {
      resume.mockRestore();
    }
  });

  test("passes snapshot_directory timeout, disables expiry, and reuses its durable id", async () => {
    const snapshotDirectory = mock(async (_path: string, _params?: unknown) => ({
      imageId: "im-dir",
    }));
    const session = fakeSession("snapshot_directory", { snapshotDirectory });

    installOpenGeniModalSnapshotPolicy(session);
    await session.persistWorkspace({ requestId: SNAPSHOT_REQUEST_ID });

    expect(snapshotDirectory).toHaveBeenCalledTimes(1);
    expect(snapshotDirectory.mock.calls[0]?.[0]).toBe("/workspace");
    expect(snapshotDirectory.mock.calls[0]?.[1]).toEqual({
      timeoutMs: 120_000,
      ttlMs: null,
      snapshotId: SNAPSHOT_REQUEST_ID,
    });
    expect(session.state.snapshotFilesystemTimeoutMs).toBe(120_000);
  });

  test("restores an explicitly present undefined directory timeout exactly", async () => {
    const snapshotDirectory = mock(async (_path: string, _params?: unknown) => ({
      imageId: "im-dir",
    }));
    const session = fakeSession("snapshot_directory", { snapshotDirectory });
    session.state.snapshotFilesystemTimeoutMs = undefined as never;

    installOpenGeniModalSnapshotPolicy(session);
    await session.persistWorkspace({ requestId: SNAPSHOT_REQUEST_ID });

    expect(Object.hasOwn(session.state, "snapshotFilesystemTimeoutMs")).toBe(true);
    expect(session.state.snapshotFilesystemTimeoutMs).toBeUndefined();
    expect(snapshotDirectory.mock.calls[0]?.[1]).toEqual({
      timeoutMs: undefined,
      ttlMs: null,
      snapshotId: SNAPSHOT_REQUEST_ID,
    });
  });

  test("rebinds the policy after filesystem hydration replaces the sandbox", async () => {
    const firstSnapshot = mock(async (_params?: unknown) => ({ imageId: "im-first" }));
    const secondSnapshot = mock(async (_params?: unknown) => ({ imageId: "im-second" }));
    const session = fakeSession("snapshot_filesystem", {
      snapshotFilesystem: firstSnapshot,
    });

    installOpenGeniModalSnapshotPolicy(session);
    await session.persistWorkspace({ requestId: SNAPSHOT_REQUEST_ID });
    session.sandbox = { snapshotFilesystem: secondSnapshot };
    await session.persistWorkspace({ requestId: SNAPSHOT_REQUEST_ID });

    expect(firstSnapshot.mock.calls[0]?.[0]).toEqual({
      timeoutMs: 120_000,
      ttlMs: null,
      snapshotId: SNAPSHOT_REQUEST_ID,
    });
    expect(secondSnapshot.mock.calls[0]?.[0]).toEqual({
      timeoutMs: 120_000,
      ttlMs: null,
      snapshotId: SNAPSHOT_REQUEST_ID,
    });
  });

  test("leaves tar persistence unchanged", async () => {
    const session = fakeSession("tar");
    const originalPersistWorkspace = session.persistWorkspace;

    installOpenGeniModalSnapshotPolicy(session);
    installOpenGeniModalSnapshotPolicy(session);
    await session.persistWorkspace();

    expect(originalPersistWorkspace).toHaveBeenCalledTimes(1);
  });

  test("adds the missing directory capability required by workspace skill discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-modal-skills-"));
    try {
      const { session, read } = fakeModalFilesystemSession(root);
      const searchPaths = [{ path: ".agents/skills", source: ".agents/skills" }];

      await expect(
        discoverWorkspaceSkills(session as unknown as SandboxSessionLike, searchPaths),
      ).rejects.toThrow(
        "Workspace skill discovery requires sandbox listDir() and readFile() support",
      );

      installOpenGeniModalSnapshotPolicy(session);
      expect(session.readFile).toBe(read);
      expect(typeof (session as unknown as SandboxSessionLike).listDir).toBe("function");
      await mkdir(join(root, ".agents/skills"), { recursive: true });
      const listDir = (session as unknown as Required<Pick<SandboxSessionLike, "listDir">>).listDir;
      await expect(listDir({ path: join(root, ".agents/skills") })).resolves.toEqual([]);
      await expect(listDir({ path: join(tmpdir(), "outside-workspace") })).rejects.toThrow(
        "outside the workspace root",
      );
      await expect(
        discoverWorkspaceSkills(session as unknown as SandboxSessionLike, searchPaths),
      ).resolves.toEqual([]);

      await mkdir(join(root, ".agents/skills/release"), { recursive: true });
      await writeFile(
        join(root, ".agents/skills/release/SKILL.md"),
        "---\nname: release\ndescription: Prepare a safe release.\n---\n",
      );
      await expect(
        discoverWorkspaceSkills(session as unknown as SandboxSessionLike, searchPaths),
      ).resolves.toEqual([
        expect.objectContaining({
          name: "release",
          description: "Prepare a safe release.",
          path: ".agents/skills/release/SKILL.md",
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves a provider-native listDir implementation", () => {
    const listDir = mock(async () => []);
    const session = Object.assign(fakeSession("tar"), { listDir });

    installOpenGeniModalSnapshotPolicy(session);

    expect(session.listDir).toBe(listDir);
  });

  test("turns Modal's exact completed-exec stdin race into an ordinary terminal poll", async () => {
    const terminal = [
      "Chunk ID: terminal",
      "Wall time: 0.001 seconds",
      "Process exited with code 0",
      "Output:",
      "done",
    ].join("\n");
    const writeStdin = mock(async (args: { sessionId: number; chars?: string }) => {
      if (args.chars) {
        throw Object.assign(new Error("typed Modal completion"), {
          name: "ClientError",
          path: "/modal.task_command_router.TaskCommandRouter/TaskExecStdinWrite",
          code: 9,
          details:
            "Exec has already completed; stdin is no longer accepting writes (Error code: 55IXOOXA)",
        });
      }
      return terminal;
    });
    const session = Object.assign(fakeSession("tar"), { writeStdin });

    installOpenGeniModalSnapshotPolicy(session);

    await expect(session.writeStdin({ sessionId: 7, chars: "input" })).resolves.toBe(terminal);
    expect(writeStdin.mock.calls).toEqual([
      [{ sessionId: 7, chars: "input" }],
      [{ sessionId: 7, chars: "" }],
    ]);
  });

  test("rotates only the stuck turn exec-start transport", async () => {
    const originalDetach = mock(() => {});
    let rejectExec!: (error: Error) => void;
    let markExecStarted!: () => void;
    const execStarted = new Promise<void>((resolve) => {
      markExecStarted = resolve;
    });
    const execResult = new Promise<string>((_resolve, reject) => {
      rejectExec = reject;
    });
    const execCommand = mock(async () => {
      markExecStarted();
      return await execResult;
    });
    const dedicatedDetach = mock(() => {
      rejectExec(new Error("command-router closed"));
    });
    const dedicated = { detach: dedicatedDetach };
    const replacementDetach = mock(() => {});
    const replacement = { detach: replacementDetach };
    let attaches = 0;
    const fromId = mock(async (_sandboxId: string) => {
      attaches += 1;
      return attaches === 1 ? dedicated : replacement;
    });
    const session = Object.assign(fakeSession("tar", { detach: originalDetach }), {
      modal: {
        version: () => "0.9.0",
        sandboxes: { fromId },
      },
      state: {
        ...fakeSession("tar").state,
        sandboxId: "sb-exact",
      },
      execCommand,
    });

    installOpenGeniModalSnapshotPolicy(session);
    const invocation = session
      .execCommand({ cmd: "sleep 60 # /tmp/opengeni-turn-shell/exact-token" })
      .catch((error) => error);
    await execStarted;
    const cancelPending = (
      session as typeof session & {
        cancelPendingExecCommand(): Promise<void>;
      }
    ).cancelPendingExecCommand;
    const first = cancelPending();
    const second = cancelPending();
    await Promise.all([first, second]);

    expect(await invocation).toBeInstanceOf(Error);
    expect(fromId).toHaveBeenCalledTimes(2);
    expect(fromId.mock.calls).toEqual([["sb-exact"], ["sb-exact"]]);
    expect(originalDetach).not.toHaveBeenCalled();
    expect(dedicatedDetach).toHaveBeenCalledTimes(1);
    expect(session.sandbox).toBe(replacement);
    expect(replacementDetach).not.toHaveBeenCalled();
  });

  test("falls back to the exact lost-session result after typed completion cleanup fails", async () => {
    let call = 0;
    const writeStdin = mock(async () => {
      call += 1;
      if (call === 1) {
        throw Object.assign(new Error("typed Modal completion"), {
          name: "ClientError",
          path: "/modal.task_command_router.TaskCommandRouter/TaskExecStdinWrite",
          code: 9,
          details: "Exec has already completed; stdin is no longer accepting writes",
        });
      }
      throw new Error("cleanup transport failed");
    });
    const session = Object.assign(fakeSession("tar"), { writeStdin });

    installOpenGeniModalSnapshotPolicy(session);

    await expect(session.writeStdin({ sessionId: 11, chars: "input" })).resolves.toBe(
      "write_stdin failed: session not found: 11",
    );
  });

  test("does not reinterpret other Modal or untyped stdin failures as terminal proof", async () => {
    const exact = {
      name: "ClientError",
      path: "/modal.task_command_router.TaskCommandRouter/TaskExecStdinWrite",
      code: 9,
      details: "Exec has already completed; stdin is no longer accepting writes",
    };
    expect(isModalExecAlreadyCompletedError(exact)).toBe(true);
    expect(isModalExecAlreadyCompletedError({ ...exact, code: 14 })).toBe(false);
    expect(isModalExecAlreadyCompletedError({ ...exact, path: "/other/TaskExecStdinWrite" })).toBe(
      false,
    );
    expect(isModalExecAlreadyCompletedError({ ...exact, details: "Sandbox is paused" })).toBe(
      false,
    );
    expect(isModalExecAlreadyCompletedError(new Error(exact.details))).toBe(false);

    const failure = Object.assign(new Error("wrong Modal precondition"), {
      ...exact,
      details: "The exec does not expose stdin",
    });
    const writeStdin = mock(async () => {
      throw failure;
    });
    const session = Object.assign(fakeSession("tar"), { writeStdin });
    installOpenGeniModalSnapshotPolicy(session);

    await expect(session.writeStdin({ sessionId: 13, chars: "input" })).rejects.toBe(failure);
    expect(writeStdin).toHaveBeenCalledTimes(1);
  });

  test("fails closed on an unsupported SDK or native session shape", () => {
    expect(() =>
      installOpenGeniModalSnapshotPolicy(
        fakeSession("snapshot_filesystem", { snapshotFilesystem: async () => undefined }, "0.7.6"),
      ),
    ).toThrow("requires modal@0.9.0");
    expect(() =>
      installOpenGeniModalSnapshotPolicy(fakeSession("snapshot_filesystem", {})),
    ).toThrow("snapshot_filesystem persistence is unavailable");
  });
});
