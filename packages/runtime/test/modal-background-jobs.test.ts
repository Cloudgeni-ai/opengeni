import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSettings } from "@opengeni/testing";
import {
  BackgroundJobProviderLostError,
  createModalBackgroundJobProvider,
  type ModalModuleLoader,
} from "../src/sandbox/providers/modal";

const STATE_DIR = "/tmp/.opengeni-background-job";
const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];

type FakeModalWorld = {
  files: Map<string, Uint8Array>;
  createdOptions: Record<string, unknown> | null;
  missing: boolean;
  readError: Error | null;
  pollResult: number | null;
  terminated: number;
  closed: number;
};

function modalFileNotFound(path: string): Error {
  const error = new Error(`file not found: ${path}`);
  error.name = "SandboxFilesystemNotFoundError";
  return error;
}

function modalSandboxNotFound(): Error {
  const error = new Error("sandbox not found");
  error.name = "NotFoundError";
  return error;
}

function fakeModal(world: FakeModalWorld): ModalModuleLoader {
  return (async () => ({
    ModalClient: class {
      apps = { fromName: async () => ({ appId: "ap-1" }) };
      images = { fromRegistry: () => ({ imageId: "im-1" }) };
      secrets = { fromName: async () => ({ secretId: "sec-1" }) };
      sandboxes = {
        create: async (_app: unknown, _image: unknown, options: Record<string, unknown>) => {
          world.createdOptions = options;
          return this.sandbox();
        },
        fromId: async () => {
          if (world.missing) throw modalSandboxNotFound();
          return this.sandbox();
        },
      };

      private sandbox() {
        return {
          sandboxId: "sb-0000000000000000000000",
          filesystem: {
            readBytes: async (path: string) => {
              if (world.missing) throw modalSandboxNotFound();
              if (world.readError) throw world.readError;
              const bytes = world.files.get(path);
              if (!bytes) throw modalFileNotFound(path);
              return bytes.slice();
            },
          },
          exec: async (command: string[]) => {
            if (world.missing) throw modalSandboxNotFound();
            if (world.readError) throw world.readError;
            const path = command[4] ?? "";
            const offset = Math.max(0, Number(command[5] ?? "1") - 1);
            const bytes = world.files.get(path)?.subarray(offset).slice() ?? new Uint8Array();
            return {
              wait: async () => 0,
              stdout: { readBytes: async () => bytes },
              stderr: { readBytes: async () => new Uint8Array() },
            };
          },
          poll: async () => world.pollResult,
          terminate: async () => {
            world.terminated += 1;
          },
        };
      }

      close() {
        world.closed += 1;
      }
    },
  })) as unknown as ModalModuleLoader;
}

function createWorld(overrides: Partial<FakeModalWorld> = {}): FakeModalWorld {
  return {
    files: new Map(),
    createdOptions: null,
    missing: false,
    readError: null,
    pollResult: null,
    terminated: 0,
    closed: 0,
    ...overrides,
  };
}

function spec(overrides: Record<string, unknown> = {}) {
  return {
    command: "/bin/sh",
    args: ["-c", "printf done"],
    artifactPaths: [],
    metadata: {},
    ...overrides,
  };
}

function provider(fakeWorld: FakeModalWorld) {
  return createModalBackgroundJobProvider(
    testSettings({
      sandboxBackend: "modal",
      modalAppName: "opengeni-test",
      modalImageRef: undefined,
      modalTimeoutSeconds: 60,
    }),
    { loadModal: fakeModal(fakeWorld) },
  );
}

function observationHooks(input: {
  logs?: Array<{ stream: string; providerOffset: number; text: string }>;
  shouldCancel?: () => boolean;
  sleep?: () => void;
}) {
  return {
    heartbeat: () => {},
    shouldCancel: async () => input.shouldCancel?.() ?? false,
    onLog: async (log: { stream: "stdout" | "stderr"; providerOffset: number; text: string }) => {
      input.logs?.push(log);
    },
    sleep: async () => input.sleep?.(),
  };
}

async function waitForFile(path: string, timeoutMs = 8_000): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path);
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Modal durable background-job provider", () => {
  test("starts a supervisor with command timeout plus terminal collection grace", async () => {
    const fakeWorld = createWorld();
    const started = await provider(fakeWorld).start({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      jobId: "22222222-2222-4222-8222-222222222222",
      spec: spec({ timeoutSeconds: 30 }),
    });

    expect(started).toEqual({
      providerRef: "modal:sandbox:sb-0000000000000000000000",
      providerInstanceId: "sb-0000000000000000000000",
    });
    const options = fakeWorld.createdOptions!;
    const command = options.command as string[];
    expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(command.slice(3, 7)).toEqual([
      "opengeni-background-job-supervisor",
      STATE_DIR,
      "30",
      "/bin/sh",
    ]);
    expect(options.timeoutMs).toBe(630_000);
    expect(options.idleTimeoutMs).toBe(630_000);
    expect(String(command[2])).toContain("while :; do sleep 60; done");
    expect(fakeWorld.closed).toBe(1);
  });

  test("streams deterministic offsets while running, then recovers artifacts after terminal", async () => {
    const fakeWorld = createWorld({
      files: new Map([
        [`${STATE_DIR}/stdout`, encoder.encode("first\npartial")],
        [`${STATE_DIR}/stderr`, new Uint8Array()],
      ]),
    });
    const logs: Array<{ stream: string; providerOffset: number; text: string }> = [];
    let sleeps = 0;
    const terminal = await provider(fakeWorld).observe({
      providerInstanceId: "sb-0000000000000000000000",
      spec: spec({ cwd: "/workspace", artifactPaths: ["result.txt"] }),
      deadlineAt: null,
      hooks: observationHooks({
        logs,
        sleep: () => {
          sleeps += 1;
          fakeWorld.files.set(`${STATE_DIR}/stdout`, encoder.encode("first\npartial done\n"));
          fakeWorld.files.set(`${STATE_DIR}/stderr`, encoder.encode("warning\n"));
          fakeWorld.files.set(`${STATE_DIR}/result`, encoder.encode("0 0\n"));
          fakeWorld.files.set("/workspace/result.txt", encoder.encode("artifact bytes"));
        },
      }),
    });

    expect(sleeps).toBe(1);
    expect(logs).toEqual([
      { stream: "stdout", providerOffset: 0, text: "first\n" },
      { stream: "stdout", providerOffset: 6, text: "partial done\n" },
      { stream: "stderr", providerOffset: 0, text: "warning\n" },
    ]);
    expect(terminal).toEqual({
      status: "completed",
      exitCode: 0,
      artifacts: [{ path: "result.txt", bytes: encoder.encode("artifact bytes") }],
    });
    // Collection deliberately does not terminate before DB/object-storage commit.
    expect(fakeWorld.terminated).toBe(0);
  });

  test("a replacement observer replays identical chunks after command completion", async () => {
    const fakeWorld = createWorld({
      files: new Map([
        [`${STATE_DIR}/stdout`, encoder.encode("first\nsecond without newline")],
        [`${STATE_DIR}/stderr`, encoder.encode("warning\n")],
        [`${STATE_DIR}/result`, encoder.encode("7 0\n")],
      ]),
    });
    const observations: Array<Array<{ stream: string; providerOffset: number; text: string }>> = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const logs: Array<{ stream: string; providerOffset: number; text: string }> = [];
      const terminal = await provider(fakeWorld).observe({
        providerInstanceId: "sb-0000000000000000000000",
        spec: spec(),
        deadlineAt: null,
        hooks: observationHooks({ logs }),
      });
      expect(terminal).toEqual({
        status: "failed",
        exitCode: 7,
        error: "background job exited with code 7",
        artifacts: [],
      });
      observations.push(logs);
    }
    expect(observations[1]).toEqual(observations[0]);
    expect(
      observations[0]?.sort((left, right) =>
        `${left.stream}:${left.providerOffset}`.localeCompare(
          `${right.stream}:${right.providerOffset}`,
        ),
      ),
    ).toEqual([
      { stream: "stderr", providerOffset: 0, text: "warning\n" },
      { stream: "stdout", providerOffset: 0, text: "first\n" },
      { stream: "stdout", providerOffset: 6, text: "second without newline" },
    ]);
  });

  test("terminal timeout, observer deadline, and cancellation are typed and terminate once", async () => {
    const timedOutWorld = createWorld({
      files: new Map([
        [`${STATE_DIR}/stdout`, encoder.encode("partial output")],
        [`${STATE_DIR}/stderr`, new Uint8Array()],
        [`${STATE_DIR}/result`, encoder.encode("143 1\n")],
      ]),
    });
    expect(
      await provider(timedOutWorld).observe({
        providerInstanceId: "sb-0000000000000000000000",
        spec: spec(),
        deadlineAt: null,
        hooks: observationHooks({}),
      }),
    ).toEqual({
      status: "failed",
      exitCode: null,
      error: "background job timed out",
      artifacts: [],
    });

    for (const mode of ["deadline", "cancel"] as const) {
      const fakeWorld = createWorld();
      const result = await provider(fakeWorld).observe({
        providerInstanceId: "sb-0000000000000000000000",
        spec: spec(),
        deadlineAt: mode === "deadline" ? new Date(0) : null,
        hooks: observationHooks({ shouldCancel: () => mode === "cancel" }),
      });
      expect(result.status).toBe(mode === "cancel" ? "cancelled" : "failed");
      expect(fakeWorld.terminated).toBe(1);
    }
  });

  test("provider disappearance and a supervisor exit before manifest become lost", async () => {
    const missingProvider = provider(createWorld({ missing: true }));
    await expect(
      missingProvider.observe({
        providerInstanceId: "sb-0000000000000000000000",
        spec: spec(),
        deadlineAt: null,
        hooks: observationHooks({}),
      }),
    ).rejects.toBeInstanceOf(BackgroundJobProviderLostError);

    const exitedProvider = provider(createWorld({ pollResult: 137 }));
    await expect(
      exitedProvider.observe({
        providerInstanceId: "sb-0000000000000000000000",
        spec: spec(),
        deadlineAt: null,
        hooks: observationHooks({}),
      }),
    ).rejects.toBeInstanceOf(BackgroundJobProviderLostError);

    const completedProvider = provider(
      createWorld({
        readError: new Error("Sandbox sb-0000000000000000000000 has already completed"),
      }),
    );
    await expect(
      completedProvider.observe({
        providerInstanceId: "sb-0000000000000000000000",
        spec: spec(),
        deadlineAt: null,
        hooks: observationHooks({}),
      }),
    ).rejects.toBeInstanceOf(BackgroundJobProviderLostError);
  });

  test("the exact supervisor script captures output/artifacts and enforces timeout", async () => {
    for (const timeoutCase of [false, true]) {
      const fakeWorld = createWorld();
      const directory = await mkdtemp(join(tmpdir(), "opengeni-modal-job-"));
      temporaryDirectories.push(directory);
      await provider(fakeWorld).start({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        jobId: "22222222-2222-4222-8222-222222222222",
        spec: spec({
          cwd: directory,
          timeoutSeconds: 1,
          args: [
            "-c",
            timeoutCase
              ? "printf before-timeout; sleep 30"
              : "printf stdout-line; printf stderr-line >&2; printf artifact > result.txt",
          ],
        }),
      });
      const command = [...(fakeWorld.createdOptions!.command as string[])];
      const stateDirectory = join(directory, "state");
      command[4] = stateDirectory;
      const child = Bun.spawn(command, { cwd: directory, stdout: "ignore", stderr: "ignore" });
      try {
        const result = await waitForFile(join(stateDirectory, "result"));
        expect(result.toString()).toMatch(timeoutCase ? /^\d+ 1\n$/ : /^0 0\n$/);
        expect((await readFile(join(stateDirectory, "stdout"))).toString()).toBe(
          timeoutCase ? "before-timeout" : "stdout-line",
        );
        if (!timeoutCase) {
          expect((await readFile(join(stateDirectory, "stderr"))).toString()).toBe("stderr-line");
          expect((await readFile(join(directory, "result.txt"))).toString()).toBe("artifact");
        }
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  }, 15_000);

  test("cleanup is idempotent when the provider has already disappeared", async () => {
    const fakeWorld = createWorld();
    const executionProvider = provider(fakeWorld);
    await executionProvider.terminate("sb-0000000000000000000000");
    expect(fakeWorld.terminated).toBe(1);
    fakeWorld.missing = true;
    await expect(executionProvider.terminate("sb-0000000000000000000000")).resolves.toBeUndefined();
  });
});
