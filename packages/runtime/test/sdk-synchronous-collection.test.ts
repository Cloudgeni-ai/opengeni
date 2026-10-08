import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Manifest } from "@openai/agents/sandbox";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { E2BSandboxSession } from "@openai/agents-extensions/sandbox/e2b";
import { BlaxelSandboxSession } from "@openai/agents-extensions/sandbox/blaxel";
import { VercelSandboxSession } from "@openai/agents-extensions/sandbox/vercel";
import { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { CloudflareSandboxSession } from "@openai/agents-extensions/sandbox/cloudflare";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { parseExecBannerSessionId } from "../src/sandbox/exec-banner";
import { installOpenGeniModalSnapshotPolicy } from "../src/sandbox/providers/modal";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import { executeSynchronousCommand } from "../src/sandbox/synchronous-command";
import { withNativeSynchronousCommandCollection } from "../src/sandbox/native-synchronous-collection";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each([
  [false, 1, 0],
  [false, 10_000, 7],
  [true, 1, 0],
  [true, 10_000, 7],
] as const)(
  "the actual Modal SDK read-only command preserves streams at yield %s, tokens %s and exit %s",
  async (yielded, maxOutputTokens, exitCode) => {
    const release = deferred();
    const started = deferred();
    const stdout = `prefix${"x".repeat(2_000)}\n`;
    const stderr = `  ${"y".repeat(2_000)}\n`;
    let starts = 0;
    let waits = 0;
    let reads = 0;
    let admission = 0;
    let firstReceipt = "";
    const sdk = installOpenGeniModalSnapshotPolicy(
      new ModalSandboxSession({
        state: {
          sandboxId: "sb-stream",
          manifest: new Manifest({ root: "/workspace" }),
          environment: { MODE: "fixture" },
          workspacePersistence: "tar",
        },
        ownsSandbox: false,
        sandbox: {
          terminate: async () => 0,
          poll: async () => 0,
          exec: async () => {
            starts++;
            return {
              stdout: new ReadableStream<string>({
                start(controller) {
                  controller.enqueue("prefix");
                  void release.promise.then(() => {
                    controller.enqueue(`${"x".repeat(2_000)}\n`);
                    controller.close();
                  });
                },
              }),
              stderr: new ReadableStream<string>({
                start(controller) {
                  void release.promise.then(() => {
                    controller.enqueue(stderr);
                    controller.close();
                  });
                },
              }),
              wait: async () => {
                waits++;
                await release.promise;
                return exitCode;
              },
            };
          },
        },
        modal: { version: () => "0.9.0" },
        app: {},
      } as never),
    );
    const session = sdk as ChannelASession;
    const forbidden = async () => {
      throw new Error("read-only SDK execution must not use retained command control");
    };
    installModalCommandSession(session, {
      start: forbidden,
      read: forbidden,
      readProbe: forbidden,
      write: forbidden,
    });
    const exec = session.execCommand!.bind(session);
    const write = session.writeStdin!.bind(session);
    session.execCommand = async (args) => {
      const receipt = await exec(args);
      firstReceipt = receipt;
      started.resolve();
      return receipt;
    };
    session.writeStdin = async (args) => {
      reads++;
      expect(args.sessionId).toBe(parseExecBannerSessionId(firstReceipt)!);
      return await write(args);
    };
    const backend = { session, sandboxId: "sb-stream", kind: "modal", activeEpoch: 0 };
    const route = new RoutingSandboxSession({
      defaultResolved: backend,
      readPointer: async () => ({ activeSandboxId: "sb-stream", activeEpoch: 0 }),
      resolveActiveBackend: async () => backend,
      beforeMutation: async () => {
        admission++;
        return "must not admit";
      },
    });
    try {
      if (!yielded) release.resolve();
      const completion = route
        .execReadOnly({
          cmd: "original command",
          yieldTimeMs: yielded ? 1 : 1_000,
          maxOutputTokens,
        })
        .catch((error: unknown) => error);
      await started.promise;
      if (yielded) expect(parseExecBannerSessionId(firstReceipt)).toBeGreaterThan(2_147_483_647);
      release.resolve();
      const result = await completion;
      expect(result).not.toBeInstanceOf(Error);
      expect(result).toMatchObject({ stdout, stderr, exitCode });
      expect(starts).toBe(1);
      expect(waits).toBe(1);
      expect(reads).toBe(yielded ? 1 : 0);
      expect(admission).toBe(0);
    } finally {
      release.resolve();
      await sdk.close();
    }
  },
);

function e2bSdk(
  run: ConstructorParameters<typeof E2BSandboxSession>[0]["sandbox"]["commands"]["run"],
) {
  const native = {
    sandboxId: "sb-stream",
    files: { write: async () => {} },
    commands: { run },
    kill: async () => {},
  };
  const session = new E2BSandboxSession({
    state: {
      sandboxId: "sb-stream",
      manifest: new Manifest({ root: "/workspace" }),
      sandboxType: "e2b",
      pauseOnExit: false,
      environment: {},
    },
    sandbox: native,
  });
  return { session, native };
}

test("the actual E2B SDK preserves structured native command-exit errors without diagnostic fabrication", async () => {
  let starts = 0;
  const fixture = e2bSdk(async () => {
    starts++;
    throw Object.assign(new Error("provider diagnostic, not command stderr"), {
      stdout: "out\n",
      stderr: "  err\n",
      exitCode: 7,
    });
  });
  try {
    expect(
      await executeSynchronousCommand(fixture.session, { cmd: "original", maxOutputTokens: 1 }),
    ).toMatchObject({ stdout: "out\n", stderr: "  err\n", exitCode: 7 });
    expect(starts).toBe(1);
  } finally {
    await fixture.session.close();
  }
});

test("the actual Modal SDK listing facade retains its native collection owner and bound command pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdk-listing-streams-"));
  let starts = 0;
  const session = installOpenGeniModalSnapshotPolicy(
    new ModalSandboxSession({
      state: {
        sandboxId: "sb-stream",
        manifest: new Manifest({ root }),
        environment: {},
        workspacePersistence: "tar",
      },
      ownsSandbox: false,
      sandbox: {
        terminate: async () => 0,
        poll: async () => 0,
        exec: async (command: string[], options: { workdir: string }) => {
          starts++;
          const child = Bun.spawn(command, {
            cwd: options.workdir,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
          return {
            stdout: child.stdout.pipeThrough(new TextDecoderStream()),
            stderr: child.stderr.pipeThrough(new TextDecoderStream()),
            wait: () => child.exited,
          };
        },
      },
      modal: { version: () => "0.9.0" },
      app: {},
    } as never),
  ) as ChannelASession & { close(): Promise<void> };
  try {
    session.execCommand = async () => {
      throw new Error("later decoration must not replace the listing source");
    };
    session.writeStdin = async () => {
      throw new Error("later decoration must not replace the listing observer");
    };
    expect(await session.listDir!({ path: "." }, executeSynchronousCommand)).toEqual([]);
    expect(starts).toBeGreaterThan(0);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the actual E2B SDK observes public transport methods on native class prototypes", async () => {
  let starts = 0;
  class Commands {
    async run() {
      starts++;
      return { stdout: "out\n", stderr: "err\n", exitCode: 0 };
    }
  }
  const commands = new Commands();
  const fixture = e2bSdk(async () => {
    throw new Error("old binding must not execute");
  });
  Object.defineProperty(fixture.session, "sandbox", {
    value: {
      ...fixture.native,
      get commands() {
        return commands;
      },
    },
  });
  try {
    expect(
      await executeSynchronousCommand(fixture.session, { cmd: "original", maxOutputTokens: 1 }),
    ).toMatchObject({ stdout: "out\n", stderr: "err\n", exitCode: 0 });
    expect(starts).toBe(1);
  } finally {
    await fixture.session.close();
  }
});

test.each(["missing-exit", "fractional-exit", "accessor-stream", "metadata-only-error"] as const)(
  "the actual E2B SDK rejects %s native proof without replay",
  async (mode) => {
    let starts = 0;
    const fixture = e2bSdk(async () => {
      starts++;
      if (mode === "metadata-only-error")
        throw Object.assign(new Error("diagnostic"), { exitCode: 7 });
      if (mode === "missing-exit") return { stdout: "out", stderr: "err" };
      if (mode === "fractional-exit") return { stdout: "out", stderr: "err", exitCode: 0.5 };
      return {
        get stdout() {
          return "untrusted";
        },
        stderr: "err",
        exitCode: 0,
      };
    });
    try {
      await expect(
        executeSynchronousCommand(fixture.session, { cmd: "original", maxOutputTokens: 1 }),
      ).rejects.toMatchObject({ name: "SynchronousCommandOutcomeUnknownError" });
      expect(starts).toBe(1);
    } finally {
      await fixture.session.close();
    }
  },
);

test("the actual E2B SDK optional empty streams and refreshed constructor binding retain their native contract", async () => {
  let first = 0;
  let second = 0;
  let receipt = "";
  const fixture = e2bSdk(async () => {
    first++;
    return { exitCode: 0 };
  });
  try {
    expect(
      await executeSynchronousCommand(fixture.session, { cmd: "first", maxOutputTokens: 1 }),
    ).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
    const replacement = {
      ...fixture.native,
      commands: {
        run: async () => {
          second++;
          return { stdout: "updated\n", stderr: "  err\n", exitCode: 7 };
        },
      },
    };
    // This is the exact constructor-binding refresh seam used after native
    // snapshot hydration, not a claim that this test provisions a snapshot.
    Object.defineProperty(fixture.session, "sandbox", { value: replacement });
    const exec = fixture.session.execCommand.bind(fixture.session);
    fixture.session.execCommand = async (args) => {
      receipt = await exec(args);
      return receipt;
    };
    expect(
      await executeSynchronousCommand(fixture.session, { cmd: "second", maxOutputTokens: 1 }),
    ).toMatchObject({ stdout: "updated\n", stderr: "  err\n", exitCode: 7 });
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect((fixture.session as ChannelASession).getSynchronousCommandOutput!(receipt)).toBeNull();
  } finally {
    await fixture.session.close();
  }
});

test("the actual Modal SDK waits for both native stream EOFs and clears terminal receipts only after success", async () => {
  const eof = deferred();
  const started = deferred();
  let starts = 0;
  let waits = 0;
  let raw = "";
  let nativeCommand: unknown;
  const session = installOpenGeniModalSnapshotPolicy(
    new ModalSandboxSession({
      state: {
        sandboxId: "sb-stream",
        manifest: new Manifest({ root: "/workspace" }),
        environment: {},
        workspacePersistence: "tar",
      },
      ownsSandbox: false,
      sandbox: {
        terminate: async () => 0,
        poll: async () => 0,
        exec: async (command) => {
          starts++;
          nativeCommand = command;
          started.resolve();
          return {
            stdout: new ReadableStream<string>({
              start(controller) {
                controller.enqueue("prefix");
                void eof.promise.then(() => {
                  controller.enqueue("tail");
                  controller.close();
                });
              },
            }),
            stderr: new ReadableStream<string>({
              start(controller) {
                controller.enqueue("diagnostic");
                controller.close();
              },
            }),
            wait: async () => {
              waits++;
              return 0;
            },
          };
        },
      },
      modal: { version: () => "0.9.0" },
      app: {},
    } as never),
  ) as ChannelASession & { close(): Promise<void> };
  try {
    let finished = false;
    const result = withNativeSynchronousCommandCollection(session, async () => {
      const exec = session.execCommand!.bind(session);
      session.execCommand = async (args) => {
        raw = await exec(args);
        return raw;
      };
      return await executeSynchronousCommand(session, {
        cmd: "original",
        yieldTimeMs: 1,
        maxOutputTokens: 1,
      });
    }).finally(() => {
      finished = true;
    });
    await started.promise;
    await Bun.sleep(10);
    expect(finished).toBe(false);
    eof.resolve();
    expect(await result).toMatchObject({ stdout: "prefixtail", stderr: "diagnostic", exitCode: 0 });
    expect(session.getSynchronousCommandOutput!(raw)).toBeNull();
    expect(starts).toBe(1);
    expect(waits).toBe(1);
    expect(nativeCommand).not.toContain("__OPENGENI_FS_COMPLETION__");
  } finally {
    eof.resolve();
    await session.close();
  }
});

test("closing a borrowed Modal SDK session cancels both tees without terminating the original process", async () => {
  const release = deferred();
  let cancelled = 0;
  let terminated = 0;
  const session = installOpenGeniModalSnapshotPolicy(
    new ModalSandboxSession({
      state: {
        sandboxId: "sb-stream",
        manifest: new Manifest({ root: "/workspace" }),
        environment: {},
        workspacePersistence: "tar",
      },
      ownsSandbox: false,
      sandbox: {
        terminate: async () => {
          terminated++;
        },
        poll: async () => 0,
        exec: async () => ({
          stdout: new ReadableStream<string>({
            start(controller) {
              controller.enqueue("prefix");
            },
            cancel() {
              cancelled++;
            },
          }),
          stderr: new ReadableStream<string>({
            cancel() {
              cancelled++;
            },
          }),
          wait: async () => {
            await release.promise;
            return 0;
          },
        }),
      },
      modal: { version: () => "0.9.0" },
      app: {},
    } as never),
  ) as ChannelASession & { close(): Promise<void> };
  try {
    const receipt = await withNativeSynchronousCommandCollection(session, () =>
      session.execCommand!({ cmd: "original", yieldTimeMs: 1, maxOutputTokens: 1 }),
    );
    expect(session.getSynchronousCommandOutput!(receipt)).toMatchObject({
      sessionId: 1,
      stdout: "prefix",
      exitCode: null,
    });
    await Promise.race([
      session.close(),
      Bun.sleep(200).then(() => {
        throw new Error("SDK close did not join both output tees");
      }),
    ]);
    expect(cancelled).toBe(2);
    expect(terminated).toBe(0);
    expect(session.getSynchronousCommandOutput!(receipt)).toBeNull();
  } finally {
    release.resolve();
    await session.close();
  }
});

async function workerSdk(
  exitReceipt: "valid" | "missing" | "fractional" | "duplicate" = "valid",
  holdEof = false,
) {
  const exitSent = deferred();
  const eof = deferred();
  if (!holdEof) eof.resolve();
  let starts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (!new URL(request.url).pathname.endsWith("/exec"))
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      expect(request.method).toBe("POST");
      const body = (await request.json()) as { argv: string[] };
      expect(body.argv.slice(0, 2)).toEqual(["/bin/sh", "-lc"]);
      starts++;
      const result = await localCommand(body.argv[2]!);
      const encoder = new TextEncoder();
      const frames = (stream: "stdout" | "stderr", output: string) => {
        // Byte-sized native events deliberately split multi-byte codepoints.
        const bytes = Buffer.from(output);
        const cut = bytes.indexOf(Buffer.from("🙂")) + 1;
        return [bytes.subarray(0, cut), bytes.subarray(cut)]
          .map((part) => `event: ${stream}\ndata: ${part.toString("base64")}\n\n`)
          .join("");
      };
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(frames("stdout", result.stdout)));
            controller.enqueue(encoder.encode(frames("stderr", result.stderr)));
            if (exitReceipt !== "missing") {
              const event = `event: exit\ndata: ${JSON.stringify({ exit_code: exitReceipt === "fractional" ? 0.5 : result.exitCode })}\n\n`;
              controller.enqueue(
                encoder.encode(exitReceipt === "duplicate" ? event + event : event),
              );
            }
            exitSent.resolve();
            void eof.promise.then(() => controller.close());
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const session = new CloudflareSandboxSession({
    state: {
      sandboxId: "sb-stream",
      workerUrl: server.url.origin,
      manifest: new Manifest({ root: "/workspace" }),
      environment: { CAPTURE_MODE: "original" },
    },
  });
  return {
    session,
    starts: () => starts,
    exitSent,
    eof,
    close: async () => {
      eof.resolve();
      await session.close();
      server.stop(true);
    },
  };
}

test.each([
  [1, 0],
  [10_000, 0],
  [1, 7],
  [10_000, 7],
] as const)(
  "the actual Cloudflare SDK collects native SSE streams at %s tokens and exit %s",
  async (maxOutputTokens, exitCode) => {
    const fixture = await workerSdk();
    const stdout = `original\n🙂${"x".repeat(2_000)}\n`;
    const stderr = `  🙂${"y".repeat(2_000)}\n`;
    try {
      const result = await executeSynchronousCommand(fixture.session, {
        cmd: `printf '%s\\n' "$CAPTURE_MODE"; printf '🙂%02000d\\n' 0 | tr 0 x; printf '  🙂%02000d\\n' 0 | tr 0 y >&2; exit ${exitCode}`,
        maxOutputTokens,
      });
      expect(result).toMatchObject({ stdout, stderr, exitCode });
      expect(fixture.starts()).toBe(1);
      const ordinary = await fixture.session.execCommand({
        cmd: "printf ordinary",
        maxOutputTokens: 1,
      });
      expect(ordinary).not.toStartWith("Native output receipt:");
      expect(
        (fixture.session as ChannelASession).getSynchronousCommandOutput!(ordinary),
      ).toBeNull();
      expect(fixture.starts()).toBe(2);
    } finally {
      await fixture.close();
    }
  },
);

test("the actual Cloudflare SDK waits for response EOF after its native exit event", async () => {
  const fixture = await workerSdk("valid", true);
  let finished = false;
  try {
    const result = executeSynchronousCommand(fixture.session, {
      cmd: "printf original; printf diagnostic >&2",
      maxOutputTokens: 1,
    }).finally(() => {
      finished = true;
    });
    await fixture.exitSent.promise;
    await Bun.sleep(10);
    expect(finished).toBe(false);
    fixture.eof.resolve();
    expect(await result).toMatchObject({ stdout: "original", stderr: "diagnostic", exitCode: 0 });
    expect(fixture.starts()).toBe(1);
  } finally {
    await fixture.close();
  }
});

test.each(["missing", "fractional", "duplicate"] as const)(
  "the actual Cloudflare SDK rejects a %s exit event without replay",
  async (mode) => {
    const fixture = await workerSdk(mode);
    try {
      await expect(
        executeSynchronousCommand(fixture.session, {
          cmd: "printf original; printf diagnostic >&2",
          maxOutputTokens: 1,
        }),
      ).rejects.toMatchObject({ name: "SynchronousCommandOutcomeUnknownError" });
      expect(fixture.starts()).toBe(1);
    } finally {
      await fixture.close();
    }
  },
);

async function localCommand(command: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    env: { ...process.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function daytonaSdk(corrupt?: (text: string) => string) {
  let starts = 0;
  let lastCommand = "";
  const manifest = new Manifest({ root: "/workspace" });
  const environment = { CAPTURE_MODE: "original" };
  const run = async (command: string, env?: Record<string, string>) => {
    starts++;
    lastCommand = command;
    const result = await localCommand(command, env);
    return { ...result, stdout: corrupt ? corrupt(result.stdout) : result.stdout };
  };
  const session = new DaytonaSandboxSession({
    state: { sandboxId: "sb-stream", manifest, pauseOnExit: false, environment },
    sandbox: {
      id: "sb-stream",
      start: async () => {},
      stop: async () => {},
      delete: async () => {},
      fs: {
        createFolder: async () => {},
        uploadFile: async () => {},
        downloadFile: async () => Buffer.alloc(0),
        deleteFile: async () => {},
      },
      process: {
        executeCommand: async (command, cwd, env) => {
          expect(cwd).toBe("/workspace");
          expect(env).toEqual(environment);
          const result = await run(command, env);
          // Daytona's actual public response has no separate stderr field.
          return {
            exitCode: result.exitCode,
            result: result.stdout + result.stderr,
            artifacts: { stdout: result.stdout },
          };
        },
      },
    },
  });
  return { session, starts: () => starts, command: () => lastCommand };
}

test.each([
  [1, 0],
  [10_000, 0],
  [1, 7],
  [10_000, 7],
] as const)(
  "the actual Daytona SDK proves complete multi-line streams at %s tokens and exit %s",
  async (maxOutputTokens, exitCode) => {
    const fixture = daytonaSdk();
    const stdout = `original\n${"out\n".repeat(6_000)}`;
    const stderr = `  err\n${"err\n".repeat(6_000)}`;
    const command = `printf '%s\\n' "$CAPTURE_MODE"; i=0; while [ "$i" -lt 6000 ]; do printf 'out\\n'; i=$((i+1)); done; printf '  err\\n' >&2; i=0; while [ "$i" -lt 6000 ]; do printf 'err\\n' >&2; i=$((i+1)); done; exit ${exitCode}`;
    try {
      const result = await executeSynchronousCommand(fixture.session, {
        cmd: command,
        maxOutputTokens,
      });
      expect(result).toMatchObject({ stdout, stderr, exitCode });
      expect(fixture.starts()).toBe(1);
      expect(fixture.command()).toContain("__OPENGENI_FS_COMPLETION_");
      const ordinary = await fixture.session.execCommand({
        cmd: "printf ordinary; printf diagnostic >&2",
        maxOutputTokens: 1,
      });
      expect(ordinary).not.toStartWith("Native output receipt:");
      expect(fixture.command()).not.toContain("__OPENGENI_FS_COMPLETION_");
      expect(fixture.starts()).toBe(2);
    } finally {
      await fixture.session.close();
    }
  },
);

test("the actual Daytona SDK rejects a byte-truncated completion without replay", async () => {
  const fixture = daytonaSdk((text) => text.slice(0, -30));
  try {
    await expect(
      executeSynchronousCommand(fixture.session, {
        cmd: "printf original; printf diagnostic >&2",
        maxOutputTokens: 1,
      }),
    ).rejects.toMatchObject({ name: "SynchronousCommandOutcomeUnknownError" });
    expect(fixture.starts()).toBe(1);
  } finally {
    await fixture.session.close();
  }
});

test.each([
  ["blaxel", 1, 0],
  ["blaxel", 10_000, 0],
  ["blaxel", 1, 7],
  ["blaxel", 10_000, 7],
  ["vercel", 1, 0],
  ["vercel", 10_000, 0],
  ["vercel", 1, 7],
  ["vercel", 10_000, 7],
] as const)(
  "the actual %s SDK preserves native streams at token limit %s and exit %s",
  async (provider, maxOutputTokens, exitCode) => {
    const stdout = `prefix${"x".repeat(2_000)}\n`;
    const stderr = `  ${"y".repeat(2_000)}\n`;
    let starts = 0;
    const projections: string[] = [];
    const manifest = new Manifest({ root: "/workspace" });
    const session =
      provider === "blaxel"
        ? new BlaxelSandboxSession({
            state: {
              sandboxName: "sb-stream",
              manifest,
              pauseOnExit: false,
              ownsSandbox: false,
              environment: {},
            },
            ownsSandbox: false,
            sandbox: {
              process: {
                exec: async (args) => {
                  expect(args.waitForCompletion).toBe(true);
                  expect(args.workingDir).toBe("/workspace");
                  starts++;
                  return { stdout, stderr, exitCode };
                },
              },
              fs: {
                mkdir: async () => {},
                write: async () => {},
                writeBinary: async () => {},
                read: async () => "",
                readBinary: async () => new Uint8Array(),
                rm: async () => {},
              },
              delete: async () => {},
            },
          })
        : new VercelSandboxSession({
            state: {
              sandboxId: "sb-stream",
              manifest,
              workspacePersistence: "tar",
              environment: {},
            },
            sandbox: {
              sandboxId: "sb-stream",
              runCommand: async (args) => {
                expect(args.cwd).toBe("/workspace");
                expect(args.cmd).toBe("/bin/sh");
                starts++;
                return {
                  exitCode,
                  output: async (stream = "both") => {
                    projections.push(stream);
                    return stream === "stdout"
                      ? stdout
                      : stream === "stderr"
                        ? stderr
                        : stdout + stderr;
                  },
                };
              },
              runDetachedCommand: async () => {
                throw new Error("must not detach");
              },
              mkDir: async () => {},
              readFileToBuffer: async () => null,
              writeFiles: async () => {},
              stop: async () => {},
            },
          });
    try {
      const result = await executeSynchronousCommand(session, {
        cmd: "original command",
        maxOutputTokens,
      });
      expect(result).toMatchObject({ stdout, stderr, exitCode });
      expect(starts).toBe(1);
      if (provider === "vercel") expect(projections).toEqual(["stdout", "stderr", "both"]);
      const ordinary = await session.execCommand({ cmd: "ordinary command", maxOutputTokens: 1 });
      expect(ordinary).not.toStartWith("Native output receipt:");
      expect(ordinary).not.toContain(stdout);
      expect((session as ChannelASession).getSynchronousCommandOutput!(ordinary)).toBeNull();
      expect(starts).toBe(2);
      if (provider === "vercel") expect(projections).toEqual(["stdout", "stderr", "both", "both"]);
    } finally {
      await session.close();
    }
  },
);

test.each([
  [1, 0],
  [10_000, 0],
  [1, 7],
  [10_000, 7],
] as const)(
  "the actual E2B SDK collects exact native streams at token limit %s and exit %s",
  async (maxOutputTokens, exitCode) => {
    const stdout = `prefix${"x".repeat(2_000)}\n`;
    const stderr = exitCode === 0 ? " \n\t" : `diagnostic${"y".repeat(2_000)}\n`;
    let starts = 0;
    const session = new E2BSandboxSession({
      state: {
        sandboxId: "sb-stream",
        manifest: new Manifest({ root: "/workspace" }),
        sandboxType: "e2b",
        pauseOnExit: false,
        environment: {},
      },
      sandbox: {
        sandboxId: "sb-stream",
        files: { write: async () => {} },
        commands: {
          run: async () => {
            starts++;
            return { stdout, stderr, exitCode };
          },
        },
        kill: async () => {},
      },
    });
    try {
      const result = await executeSynchronousCommand(session, {
        cmd: "original command",
        maxOutputTokens,
      }).catch((error: unknown) => error);
      expect(result).not.toBeInstanceOf(Error);
      expect(result).toMatchObject({ stdout, stderr, exitCode });
      expect(starts).toBe(1);
    } finally {
      await session.close();
    }
  },
);
