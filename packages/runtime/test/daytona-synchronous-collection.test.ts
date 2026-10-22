import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeSynchronousCommand,
  synchronousCommandPage,
  observeSynchronousCommand,
} from "../src/sandbox/synchronous-command";
import {
  withNativeSynchronousCommandCollection,
  releaseNativeSynchronousCommandOutput,
} from "../src/sandbox/native-synchronous-collection";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import { withDaytonaNativeCommand } from "./fixtures/daytona-native-command";
import {
  cancellableSynchronousShellCommand,
  createTurnToolCancellationController,
} from "../src/sandbox/turn-tool-cancellation";

test("registered Daytona read-only collection remains functional without a mutation admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytona-native-readonly-"));
  try {
    await withDaytonaNativeCommand(root, {}, async (fixture) => {
      const backend = {
        session: fixture.session,
        sandboxId: "sb-original-native",
        kind: "daytona",
        activeEpoch: 0,
      };
      const route = new RoutingSandboxSession({
        defaultResolved: backend,
        readPointer: async () => ({ activeSandboxId: backend.sandboxId, activeEpoch: 0 }),
        resolveActiveBackend: async () => backend,
        beforeMutation: async () => {
          throw new Error("No mutation admission for this read");
        },
      });
      expect(
        await route.execReadOnly({
          cmd: "printf original; printf diagnostic >&2; exit 7",
          yieldTimeMs: 1,
          maxOutputTokens: 1,
        }),
      ).toMatchObject({ stdout: "original", stderr: "diagnostic", exitCode: 7 });
      expect(fixture.commands).toHaveLength(1);
      expect(fixture.deleted).toEqual([fixture.commands[0]!.sessionId]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the worker uses the registered Daytona native collection scope without another Start or merged streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytona-native-worker-"));
  try {
    await withDaytonaNativeCommand(root, {}, async (fixture) => {
      const controller = createTurnToolCancellationController();
      try {
        const result = await withNativeSynchronousCommandCollection(fixture.session, () =>
          controller.runSandboxCommandSynchronous(fixture.session, {
            cmd: "printf prefix; printf '%02000d' 0; printf '%02000d' 0 >&2; exit 7",
            yieldTimeMs: 1,
            maxOutputTokens: 1,
          }),
        );
        expect(result).toMatchObject({
          stdout: "prefix" + "0".repeat(2_000),
          stderr: "0".repeat(2_000),
          exitCode: 7,
        });
        expect(fixture.commands).toHaveLength(1);
        const original = fixture.commands[0]!;
        expect(
          fixture.reads.every(
            (read) => read.sessionId === original.sessionId && read.commandId === original.id,
          ),
        ).toBe(true);
        expect(fixture.deleted).toEqual([original.sessionId]);
      } finally {
        controller.cancel();
        await controller.waitForQuiescence();
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([1, 10_000])(
  "registered Daytona separates original multiline marker/NUL/UTF8 bytes at %s tokens",
  async (maxOutputTokens) => {
    const root = await mkdtemp(join(tmpdir(), "daytona-native-bytes-"));
    try {
      await withDaytonaNativeCommand(root, {}, async ({ session, commands }) => {
        const result = await executeSynchronousCommand(session, {
          cmd: "printf '雪\\000\\001\\001\\001'; i=0; while [ \"$i\" -lt 6000 ]; do printf 'out\\n'; printf 'é\\002\\002\\002err\\n' >&2; i=$((i+1)); done; printf '\\n' >&2; exit 7",
          maxOutputTokens,
        });
        expect(result).toMatchObject({
          stdout: "雪\0\x01\x01\x01" + "out\n".repeat(6_000),
          stderr: "é\x02\x02\x02err\n".repeat(6_000) + "\n",
          exitCode: 7,
        });
        expect(commands).toHaveLength(1);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  [false, 1, 0],
  [false, 10_000, 0],
  [false, 1, 7],
  [false, 10_000, 7],
  [true, 1, 0],
  [true, 10_000, 0],
  [true, 1, 7],
  [true, 10_000, 7],
] as const)(
  "registered native Daytona preserves separate bytes through exact resume %s, tokens %s and exit %s",
  async (resume, maxOutputTokens, exitCode) => {
    const root = await mkdtemp(join(tmpdir(), "daytona-native-collection-"));
    try {
      await withDaytonaNativeCommand(root, { ORIGINAL_ENV: "same" }, async (fixture) => {
        const session = resume
          ? await fixture.client.resumeExact(fixture.session.state)
          : fixture.session;
        const stdout = `prefix${"x".repeat(2_000)}`;
        const stderr = "y".repeat(2_000);
        const source = `printf prefix; printf '%s' '${"x".repeat(2_000)}'; printf '%s' '${stderr}' >&2; exit ${exitCode}`;
        const result = await executeSynchronousCommand(session, {
          cmd: source,
          yieldTimeMs: 1,
          maxOutputTokens,
        });
        expect(result).toMatchObject({ stdout, stderr, exitCode });
        expect(fixture.commands).toHaveLength(1);
        const original = fixture.commands[0]!;
        expect(original.source.split(source)).toHaveLength(2);
        expect(original.source).not.toContain("python3");
        expect(fixture.deleted).toEqual([original.sessionId]);
        expect(
          fixture.reads.every(
            (read) => read.sessionId === original.sessionId && read.commandId === original.id,
          ),
        ).toBe(true);
        expect(fixture.creates()).toBe(1);
        expect(fixture.gets()).toBe(1);
        const ordinary = await session.execCommand({
          cmd: "printf ordinary; printf diagnostic >&2",
          maxOutputTokens: 1,
        });
        expect(ordinary).not.toStartWith("Native output receipt:");
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.ordinary.at(-1)).not.toContain("OGF1");
        if (resume) await session.close();
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  [undefined, false],
  [undefined, true],
  [String(process.getuid!()), false],
  [String(process.getuid!()), true],
] as const)(
  "registered native Daytona retains compiled cwd, environment, runAs %s and login %s",
  async (runAs, login) => {
    const root = await mkdtemp(join(tmpdir(), "daytona-native-context-"));
    await mkdir(join(root, "child"));
    try {
      await withDaytonaNativeCommand(
        root,
        { ORIGINAL_ENV: "same" },
        async ({ session, commands }) => {
          const result = await executeSynchronousCommand(session, {
            cmd: "printf '%s\n%s' \"$PWD\" \"$ORIGINAL_ENV\"; printf '  diagnostic\n' >&2",
            workdir: "child",
            ...(runAs ? { runAs } : {}),
            login,
            maxOutputTokens: 1,
          });
          expect(result).toMatchObject({
            stdout: `${join(root, "child")}\nsame`,
            stderr: "  diagnostic\n",
            exitCode: 0,
          });
          expect(commands).toHaveLength(1);
          if (runAs) expect(commands[0]!.source).toContain(`target_user='${runAs}'`);
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("registered default-compatible Daytona filesystem commands need no Python executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytona-native-no-python-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink("/usr/bin/base64", join(bin, "base64"));
  try {
    await withDaytonaNativeCommand(root, { PATH: bin }, async ({ session, commands }) => {
      const result = await executeSynchronousCommand(session, {
        cmd: "printf original; printf diagnostic >&2",
        maxOutputTokens: 1,
      });
      expect(result).toMatchObject({ stdout: "original", stderr: "diagnostic", exitCode: 0 });
      expect(commands).toHaveLength(1);
      expect(commands[0]!.source).not.toContain("python3");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a registered native Daytona yielded read keeps its original trusted alias and native identities after SDK state changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytona-native-identity-"));
  try {
    await withDaytonaNativeCommand(root, {}, async (fixture) => {
      await withNativeSynchronousCommandCollection(fixture.session, async () => {
        const initial = synchronousCommandPage(
          fixture.session,
          await fixture.session.execCommand({
            cmd: "sleep 0.05; printf original; printf diagnostic >&2",
            yieldTimeMs: 1,
            maxOutputTokens: 1,
          }),
        );
        const handle = initial.sessionId;
        expect(Number.isSafeInteger(handle)).toBe(true);
        expect(handle!).toBeGreaterThanOrEqual(2 ** 30);
        expect(handle!).toBeLessThan(2 ** 31);
        fixture.session.state.sandboxId = "sb-not-original";
        const result = await observeSynchronousCommand(initial, async (id) => {
          expect(id).toBe(handle!);
          return synchronousCommandPage(
            fixture.session,
            await fixture.session.writeStdin({
              sessionId: id,
              chars: "",
              yieldTimeMs: 1,
              maxOutputTokens: 1,
            }),
            id,
          );
        });
        expect(result).toMatchObject({ stdout: "original", stderr: "diagnostic", exitCode: 0 });
        expect(fixture.commands).toHaveLength(1);
        const original = fixture.commands[0]!;
        expect(
          fixture.reads.every(
            (read) => read.sessionId === original.sessionId && read.commandId === original.id,
          ),
        ).toBe(true);
        expect(fixture.gets()).toBe(1);
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["capture", "settlement", "cleanup", "lost cleanup reply"] as const)(
  "routed native Daytona keeps complete output and exact custody across %s retry",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "daytona-native-custody-"));
    try {
      await withDaytonaNativeCommand(root, {}, async (fixture) => {
        const backend = {
          session: fixture.session,
          sandboxId: "sb-original-native",
          kind: "daytona",
          activeEpoch: 0,
        };
        let alias: number | undefined;
        let failed = false;
        let settled = 0;
        const durable = new Map<string, { stream: "stdout" | "stderr"; chunk: string }>();
        fixture.fault.cleanup = () => {
          if (failure === "cleanup" && !failed) {
            failed = true;
            throw new Error("native cleanup unavailable");
          }
        };
        fixture.fault.afterCleanup = () => {
          if (failure === "lost cleanup reply" && !failed) {
            failed = true;
            throw new Error("native delete response lost");
          }
        };
        const route = new RoutingSandboxSession({
          defaultResolved: backend,
          readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
          resolveActiveBackend: async () => backend,
          beforeMutation: async () => "admitted",
          afterMutation: async ({ retainedProcess }) => {
            alias = retainedProcess?.providerSessionId;
          },
          captureProcessOutput: async (page) => {
            expect(page.streamFidelity).toBe("separate");
            durable.set(page.chunkId, page);
            if (failure === "capture" && !failed) {
              failed = true;
              throw new Error("output capture unavailable");
            }
          },
          settleProcess: async () => {
            if (failure === "settlement" && !failed) {
              failed = true;
              throw new Error("settlement unavailable");
            }
            settled++;
          },
        });
        await expect(
          route.execSynchronous({
            cmd: "sleep 0.05; printf original; printf diagnostic >&2; exit 7",
            yieldTimeMs: 1,
            maxOutputTokens: 1,
          }),
        ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
        expect(alias).toBeDefined();
        expect(route.hasRetainedProcess(alias!)).toBe(true);
        expect(route.supportsCommandInput(alias!)).toBe(false);
        expect(route.canAdoptRetainedProcessAsBackgroundCommand(alias!)).toBe(false);
        expect(fixture.deleted).toHaveLength(failure === "lost cleanup reply" ? 1 : 0);
        expect(fixture.commands).toHaveLength(1);
        const recovered = await route.writeStdinForProcessControl({
          sessionId: alias!,
          chars: "",
          yieldTimeMs: 1,
          maxOutputTokens: 1,
        });
        expect(recovered).toContain("Process exited with code 7");
        expect(route.hasRetainedProcess(alias!)).toBe(false);
        expect(fixture.deleted).toEqual([fixture.commands[0]!.sessionId]);
        expect(fixture.commands).toHaveLength(1);
        expect(settled).toBeGreaterThan(0);
        for (const stream of ["stdout", "stderr"] as const)
          expect(
            [...durable.values()]
              .filter((page) => page.stream === stream)
              .map((page) => page.chunk)
              .join(""),
          ).toBe(stream === "stdout" ? "original" : "diagnostic");
        expect(synchronousCommandPage(fixture.session, recovered).collectionUnavailable).toBe(true);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  "identity",
  "exit",
  "UTF8",
  "payload",
  "missing EOF",
  "duplicate",
  "logs lost",
] as const)(
  "registered Daytona rejects %s proof without replay and recovers only the original command",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "daytona-native-invalid-"));
    try {
      await withDaytonaNativeCommand(root, {}, async (fixture) => {
        // Hold the native read until the genuine original bytes are available,
        // then corrupt only the stubbed provider receipt, never the real child.
        fixture.fault.read = async () => {
          await fixture.commands[0]!.done;
        };
        if (mode === "identity")
          fixture.fault.status = (status) => ({ ...status, id: "not-original" });
        if (mode === "exit") fixture.fault.status = (status) => ({ ...status, exitCode: 1.5 });
        if (mode === "logs lost")
          fixture.fault.logs = () => {
            throw new Error("log response lost");
          };
        if (mode === "payload")
          fixture.fault.logs = (raw) =>
            raw.replace(/( DATA stdout \d+ \d+ )[^\n]+/u, "$1%%%INVALID");
        if (mode === "missing EOF")
          fixture.fault.logs = (raw) => raw.replace(/^.* EOF stdout.*\n/mu, "");
        if (mode === "duplicate") fixture.fault.logs = (raw) => raw + raw;
        let alias: number | undefined;
        await expect(
          withNativeSynchronousCommandCollection(fixture.session, async () => {
            const raw = await fixture.session.execCommand({
              cmd: mode === "UTF8" ? "printf '\\377'" : "printf original; printf diagnostic >&2",
              maxOutputTokens: 1,
            });
            const page = synchronousCommandPage(fixture.session, raw);
            alias = page.sessionId;
            expect(page.collectionUnavailable).toBe(true);
            await observeSynchronousCommand(page, async () => {
              throw new Error("Unproven receipt must not trigger another Start");
            });
          }),
        ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
        expect(alias).toBeDefined();
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.deleted).toHaveLength(0);
        delete fixture.fault.status;
        delete fixture.fault.logs;
        if (mode !== "UTF8")
          await withNativeSynchronousCommandCollection(fixture.session, async () => {
            const receipt = await fixture.session.writeStdin({
              sessionId: alias!,
              chars: "",
              maxOutputTokens: 1,
            });
            const result = await observeSynchronousCommand(
              synchronousCommandPage(fixture.session, receipt, alias),
              async () => {
                throw new Error("Recovered terminal proof is already complete");
              },
            );
            expect(result).toMatchObject({ stdout: "original", stderr: "diagnostic", exitCode: 0 });
            await releaseNativeSynchronousCommandOutput(fixture.session, receipt);
          });
        // Recovery outside the originating scope is settled explicitly below;
        // malformed UTF8 remains honestly unknown with exact control retained.
        expect(fixture.commands).toHaveLength(1);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("registered Daytona isolates simultaneous native collections from ordinary and PTY SDK execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytona-native-parallel-"));
  try {
    await withDaytonaNativeCommand(root, {}, async (fixture) => {
      const pending = ["one", "two"].map((name) =>
        executeSynchronousCommand(fixture.session, {
          cmd: `sleep 0.05; printf ${name}; printf ${name}-err >&2`,
          yieldTimeMs: 1,
          maxOutputTokens: 1,
        }),
      );
      const [ordinary, pty] = await Promise.all([
        fixture.session.execCommand({
          cmd: "printf ordinary; printf diagnostic >&2",
          maxOutputTokens: 1,
        }),
        fixture.session.execCommand({
          cmd: "printf pty",
          tty: true,
          yieldTimeMs: 1,
          maxOutputTokens: 100,
        }),
      ]);
      expect(ordinary).not.toStartWith("Native output receipt:");
      expect(pty).toContain("ordinary-pty");
      expect(pty).not.toStartWith("Native output receipt:");
      expect(fixture.pty).toHaveLength(1);
      expect(fixture.pty[0]).not.toContain("OGF1");
      const results = await Promise.all(pending);
      expect(results.map(({ stdout, stderr, exitCode }) => ({ stdout, stderr, exitCode }))).toEqual(
        [
          { stdout: "one", stderr: "one-err", exitCode: 0 },
          { stdout: "two", stderr: "two-err", exitCode: 0 },
        ],
      );
      expect(fixture.commands).toHaveLength(2);
      expect(new Set(fixture.commands.map(({ sessionId }) => sessionId)).size).toBe(2);
      expect(fixture.deleted.sort()).toEqual(
        fixture.commands.map(({ sessionId }) => sessionId).sort(),
      );
      for (const command of fixture.commands)
        expect(
          fixture.reads
            .filter((read) => read.sessionId === command.sessionId)
            .every((read) => read.commandId === command.id),
        ).toBe(true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registered Daytona keeps descendant output open after leader exit and settles only both framed EOFs", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytona-native-descendant-"));
  const gate = join(root, "release");
  try {
    await withDaytonaNativeCommand(root, {}, async (fixture) => {
      let complete = false;
      const pending = executeSynchronousCommand(fixture.session, {
        cmd: `printf prefix; (while [ ! -e '${gate}' ]; do sleep 0.01; done; printf tail; printf diagnostic >&2) & exit 7`,
        yieldTimeMs: 1,
        maxOutputTokens: 1,
      }).finally(() => {
        complete = true;
      });
      try {
        await Bun.sleep(100);
        expect(complete).toBe(false);
        expect(fixture.deleted).toHaveLength(0);
        await writeFile(gate, "release");
        expect(await pending).toMatchObject({
          stdout: "prefixtail",
          stderr: "diagnostic",
          exitCode: 7,
        });
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.deleted).toEqual([fixture.commands[0]!.sessionId]);
      } finally {
        await writeFile(gate, "release");
        await pending;
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routed Daytona control helpers keep the original PGID route during collection and a failed signal reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytona-native-control-"));
  const marker = join(root, crypto.randomUUID());
  const started = join(root, "started");
  let group: number | undefined;
  try {
    await withDaytonaNativeCommand(root, {}, async (fixture) => {
      fixture.fault.ordinary = true;
      const backend = {
        session: fixture.session,
        sandboxId: "sb-original-native",
        kind: "daytona",
        activeEpoch: 0,
      };
      const route = new RoutingSandboxSession({
        defaultResolved: backend,
        readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
        resolveActiveBackend: async () => backend,
        beforeMutation: async () => "admitted",
        afterMutation: async () => {},
        captureProcessOutput: async () => {},
        settleProcess: async () => {},
      });
      const source = cancellableSynchronousShellCommand(
        `printf prefix; printf started > '${started}'; sleep 30`,
        marker,
      );
      const result = await route.execSynchronous(
        { cmd: source, yieldTimeMs: 1, maxOutputTokens: 1 },
        async (adapter, args) => {
          const page = synchronousCommandPage(adapter, await adapter.exec!(args));
          expect(page.sessionId).toBeDefined();
          for (let i = 0; i < 100; i++) {
            const record = await readFile(marker, "utf8").catch(() => "");
            if (record && (await readFile(started, "utf8").catch(() => "")) === "started") {
              const fields = record.trim().split(" ").map(Number);
              expect(fields).toHaveLength(2);
              expect(fields[0]).toBe(fields[1]);
              expect(Number.isSafeInteger(fields[1]) && fields[1]! > 1).toBe(true);
              group = fields[1];
              break;
            }
            await Bun.sleep(10);
          }
          expect(group).toBeDefined();
          fixture.fault.execute = () => {
            throw new Error("exact control transport unavailable");
          };
          await expect(
            route.execCommandForProcessControl(page.sessionId!, { cmd: "false" }),
          ).rejects.toThrow();
          expect(route.hasRetainedProcess(page.sessionId!)).toBe(true);
          expect(fixture.deleted).toHaveLength(0);
          delete fixture.fault.execute;
          const control = await route.execCommandForProcessControl(page.sessionId!, {
            cmd: `/bin/kill -TERM -- -${group}`,
          });
          expect(control).toContain("Process exited with code 0");
          expect(control).not.toStartWith("Native output receipt:");
          const completed = await observeSynchronousCommand(page, async (id) =>
            synchronousCommandPage(
              adapter,
              await adapter.writeStdin!({
                sessionId: id,
                chars: "",
                yieldTimeMs: 1,
                maxOutputTokens: 1,
              }),
              id,
            ),
          );
          group = undefined;
          return completed;
        },
      );
      expect(result).toMatchObject({ stdout: "prefix", stderr: "", exitCode: 143 });
      expect(fixture.commands).toHaveLength(1);
      expect(fixture.commands[0]!.source.split(source)).toHaveLength(2);
      expect(fixture.ordinary.at(-1)).not.toContain("OGF1");
      expect(fixture.deleted).toEqual([fixture.commands[0]!.sessionId]);
    });
  } finally {
    if (group) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});
