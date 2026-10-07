import { expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { SandboxChannelAService, type ChannelASession } from "../src/sandbox/channel-a";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import {
  RoutingSandboxSession,
  RoutingMutationOutcomeUnknownError,
  RoutingMutationOutputRejectedError,
  type RoutingRetainedProcess,
} from "../src/sandbox/routing/routing-session";
import {
  executeSynchronousCommand,
  SynchronousCommandOutcomeUnknownError,
} from "../src/sandbox/synchronous-command";

function fixture(exitCode = 0) {
  const session: ChannelASession = {
    // Unadmitted read/private work stays on this exact SDK setup observer.
    execCommand: async (args) => {
      const marker = args.cmd.match(/__OPENGENI_FS_CONFINED_OK__/u)?.[0] ?? "";
      return `Process exited with code 0\n\nOutput:\n${marker}`;
    },
    writePlacementPrivate: async () => {},
    deletePlacementPrivate: async () => {},
  };
  const starts: Array<{ cmd: string; id: string }> = [];
  const commands = new Map<string, ModalRouterProviderCommand>();
  const readIndexes = new Map<string, number>();
  const admissions: string[] = [];
  const settled: number[] = [];
  const captured: Array<{ id: string; stdout: string; stderr: string }> = [];
  const enclosingSettled: string[] = [];
  let failObservation = false;
  let activeSandboxId: string | null = null;
  let generation = 0;
  installModalCommandSession(session, {
    start: async (args) => {
      const command: ModalRouterProviderCommand = {
        kind: "modal-router-v1",
        sandboxId: "sb-original",
        taskId: "task-original",
        execId: crypto.randomUUID(),
        streams: {
          stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
          stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        },
      };
      starts.push({ cmd: args.cmd, id: command.execId });
      return command;
    },
    read: async (value) => {
      if (value.kind !== "modal-router-v1") throw new Error("unexpected legacy command");
      const index = readIndexes.get(value.execId) ?? 0;
      if (failObservation && index > 0) throw new Error("same invocation temporarily unobservable");
      readIndexes.set(value.execId, index + 1);
      const invocation = starts.find((item) => item.id === value.execId)!;
      const importMarker = invocation.cmd.match(/__OPENGENI_WORKSPACE_IMPORT_[0-9a-f]+_OK__/u)?.[0];
      const output = importMarker
        ? `${importMarker}\tcreated`
        : "__OGF_W__0____OPENGENI_FS_BATCH_OK__ €";
      const stdout = index === 0 ? output : index === 1 ? "" : "";
      const stderr = index === 0 && !importMarker ? "diagnostic" : "";
      const command = structuredClone(value);
      const terminal = index >= 2;
      // EOF is available one page before authenticated exit evidence.
      for (const stream of ["stdout", "stderr"] as const) {
        command.streams[stream].byteOffset += Buffer.byteLength(
          stream === "stdout" ? stdout : stderr,
        );
        command.streams[stream].eof = index >= 1;
        command.streams[stream].exitCode = terminal ? exitCode : null;
      }
      return {
        command,
        expected: value,
        exitCode: terminal ? exitCode : null,
        chunks: [
          ...(stdout
            ? [
                {
                  stream: "stdout" as const,
                  chunkId: `${value.execId}:${index}:stdout`,
                  text: stdout,
                },
              ]
            : []),
          ...(stderr
            ? [
                {
                  stream: "stderr" as const,
                  chunkId: `${value.execId}:${index}:stderr`,
                  text: stderr,
                },
              ]
            : []),
        ],
      };
    },
    write: async () => {
      throw new Error("synchronous observation must not send input");
    },
    readProbe: async () => {
      throw new Error("not a materialization test");
    },
  });
  const backend = { session, sandboxId: null, kind: "modal", activeEpoch: 0 };
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId, activeEpoch: activeSandboxId ? 1 : 0 }),
    resolveActiveBackend: async () => backend,
    beforeMutation: async ({ op }) => {
      admissions.push(op);
      return { handle: ++generation };
    },
    providerCommandHandle: (admission) => (admission as { handle: number }).handle,
    afterMutation: async ({ op, retainedProcess }) => {
      if (!retainedProcess) enclosingSettled.push(op);
      if (retainedProcess?.providerCommand?.kind === "modal-router-v1") {
        commands.set(retainedProcess.id, structuredClone(retainedProcess.providerCommand));
      }
    },
    providerCommandPersistence: (process: RoutingRetainedProcess) => ({
      load: async () => commands.get(process.id) ?? null,
      acknowledge: async () => {
        throw new Error("byte cursors require atomic capture");
      },
      reserveInput: async () => {
        throw new Error("observation must not reserve stdin");
      },
      captureRouterPage: async (page) => {
        expect(commands.get(process.id)).toEqual(page.expected);
        commands.set(process.id, structuredClone(page.command));
        captured.push({ id: process.id, stdout: page.stdout, stderr: page.stderr });
        return { command: page.command, captured: true };
      },
    }),
    captureProcessOutput: async () => {
      throw new Error("atomic provider capture must precede legacy output");
    },
    settleProcess: async ({ process, proof }) => {
      const command = commands.get(process.id)!;
      expect(command.streams.stdout.eof && command.streams.stderr.eof).toBe(true);
      expect(command.streams.stdout.exitCode).toBe(exitCode);
      expect(proof.exitCode).toBe(exitCode);
      settled.push(process.providerSessionId);
    },
    adoptProcessAsBackgroundCommand: async () => {
      throw new Error("internal execution cannot adopt background lifetime");
    },
    observeProcessTerminal: async () => {
      throw new Error("internal execution cannot acknowledge model command completion");
    },
  });
  return {
    route,
    starts,
    settled,
    captured,
    commands,
    admissions,
    enclosingSettled,
    failObservation: () => {
      failObservation = true;
    },
    swap: () => {
      activeSandboxId = "different-backend";
    },
  };
}

test.each([0, 7])(
  "raw Modal receipt is retained/captured before observing the original terminal exit %s",
  async (exitCode) => {
    const f = fixture(exitCode);
    const result = await f.route.execSynchronous({ cmd: "filesystem once", maxOutputTokens: 1 });
    expect(result).toMatchObject({
      stdout: "__OGF_W__0____OPENGENI_FS_BATCH_OK__ €",
      stderr: "diagnostic",
      exitCode,
    });
    expect(f.starts).toHaveLength(1);
    expect(f.settled).toEqual([1]);
    expect(f.captured.map((page) => page.stdout).join("")).toBe(result.stdout);
    expect([...f.commands.values()][0]!.streams.stdout.byteOffset).toBe(
      Buffer.byteLength(result.stdout),
    );
    expect(f.route.hasRetainedProcess(1)).toBe(false);
  },
);

test("observation loss keeps the exact retained writer and committed initial cursor without replay", async () => {
  const f = fixture();
  f.failObservation();
  await expect(f.route.execSynchronous({ cmd: "mutation" })).rejects.toBeInstanceOf(
    SynchronousCommandOutcomeUnknownError,
  );
  expect(f.starts).toHaveLength(1);
  expect(f.settled).toEqual([]);
  expect(f.route.hasRetainedProcess(1)).toBe(true);
  expect([...f.commands.values()][0]!.streams.stdout.byteOffset).toBeGreaterThan(0);
});

test("multi-file composite imports keep outer confinement with fresh exact retained subcommands", async () => {
  const f = fixture();
  const channel = new SandboxChannelAService({ session: f.route, workspaceRoot: "/workspace" });
  const requests = ["one", "two"].map((name) => ({
    operationId: crypto.randomUUID(),
    destinationPath: `attachments/${name}.bin`,
    overwrite: false,
    mayReplaceExisting: false,
    createParents: true,
    sizeBytes: 3,
    sha256: "a".repeat(64),
    source: {
      url: `https://example.test/${name}?signature=private`,
      expiresAt: "2030-01-01T00:00:00Z",
    },
  }));
  const receipts = await channel.importWorkspaceFiles(requests);
  expect(receipts.map((receipt) => receipt.destinationPath)).toEqual(
    requests.map((request) => request.destinationPath),
  );
  expect(f.admissions).toEqual(["importWorkspaceFiles", "exec", "exec"]);
  expect(f.starts).toHaveLength(2);
  expect(f.starts[0]!.id).not.toBe(f.starts[1]!.id);
  expect(f.settled).toEqual([2, 3]);
});

test("read-only SDK handles are observed on the resolved backend before route validation", async () => {
  let swapped = false;
  let starts = 0;
  let reads = 0;
  const original = {
    exec: async () => {
      starts++;
      return { stdout: "prefix", sessionId: 2_147_483_648, exitCode: null };
    },
    writeStdin: async (input: unknown) => {
      expect((input as { sessionId: number }).sessionId).toBe(2_147_483_648);
      swapped = true;
      reads++;
      return "Process exited with code 0\n\nOutput:\ntail";
    },
  };
  const route = new RoutingSandboxSession({
    readPointer: async () => ({
      activeSandboxId: swapped ? "new" : null,
      activeEpoch: swapped ? 1 : 0,
    }),
    resolveActiveBackend: async () => ({ session: original, sandboxId: null, kind: "modal" }),
    beforeMutation: async () => {
      throw new Error("read cannot admit a mutation");
    },
    maxFenceRetries: 0,
  });
  await expect(route.execReadOnly({ cmd: "read" })).rejects.toThrow("route changed");
  expect(starts).toBe(1);
  expect(reads).toBe(1);
});

test("composite observation loss closes only its enclosing callback and leaves the exact child writer retained", async () => {
  const f = fixture();
  f.failObservation();
  const channel = new SandboxChannelAService({ session: f.route, workspaceRoot: "/workspace" });
  const error = await channel
    .importWorkspaceFiles([
      {
        operationId: crypto.randomUUID(),
        destinationPath: "attachments/one.bin",
        overwrite: false,
        mayReplaceExisting: false,
        createParents: true,
        sizeBytes: 3,
        sha256: "a".repeat(64),
        source: {
          url: "https://example.test/one?signature=private",
          expiresAt: "2030-01-01T00:00:00Z",
        },
      },
    ])
    .catch((caught) => caught);
  expect(error).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
  expect(error.retainedProcess.providerSessionId).toBe(2);
  expect(f.enclosingSettled).toEqual(["importWorkspaceFiles"]);
  expect(f.starts).toHaveLength(1);
  expect(f.settled).toEqual([]);
  expect(f.route.hasRetainedProcess(2)).toBe(true);
});

test("transport choice, pending-start cancellation, and launch stay on the original backend after a pointer move", async () => {
  const calls: string[] = [];
  let moved = false;
  const original = {
    supportsPty: () => true,
    commandCancellationTransport: async () => {
      calls.push("transport-original");
      return "shell_session" as const;
    },
    cancelPendingExecCommand: async () => {
      calls.push("cancel-original");
    },
    execCommand: async () => {
      calls.push("start-original");
      return "Process exited with code 0\n\nOutput:\ndata";
    },
  };
  const wrong = {
    commandCancellationTransport: async () => {
      throw new Error("wrong cancellation transport");
    },
    cancelPendingExecCommand: async () => {
      throw new Error("wrong pending launch");
    },
    execCommand: async () => {
      throw new Error("wrong start");
    },
  };
  const route = new RoutingSandboxSession({
    readPointer: async () => ({
      activeSandboxId: moved ? "new" : null,
      activeEpoch: moved ? 1 : 0,
    }),
    resolveActiveBackend: async () =>
      moved
        ? { session: wrong, sandboxId: "new", kind: "selfhosted", activeEpoch: 1 }
        : { session: original, sandboxId: null, kind: "modal", activeEpoch: 0 },
  });
  await expect(
    route.execSynchronous({ cmd: "read once" }, async (session, args) => {
      expect(await session.commandCancellationTransport!()).toBe("shell_session");
      moved = true;
      await session.cancelPendingExecCommand!();
      return await executeSynchronousCommand(session, args);
    }),
  ).rejects.toBeInstanceOf(RoutingMutationOutcomeUnknownError);
  expect(calls).toEqual(["transport-original", "cancel-original", "start-original"]);
});

test("Channel-A preserves a settled authority rejection instead of retrying confinement or falling back", async () => {
  const rejection = new RoutingMutationOutputRejectedError("exec", "holder_fenced");
  let starts = 0;
  const channel = new SandboxChannelAService({
    workspaceRoot: "/workspace",
    session: {
      execReadOnly: async () => {
        starts++;
        throw rejection;
      },
    },
  });
  const error = await channel
    .fsList({ path: "", depth: 2, maxEntries: 10, includeHidden: true })
    .catch((caught) => caught);
  expect(error).toBe(rejection);
  expect(starts).toBe(1);
});
