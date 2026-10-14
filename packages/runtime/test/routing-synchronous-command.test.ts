import { expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { SandboxChannelAService, type ChannelASession } from "../src/sandbox/channel-a";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nativeModalControl(
  starts: Array<{ cmd: string; id: string }>,
  entered: ReturnType<typeof deferred>,
  available: ReturnType<typeof deferred>,
  exitCode: number,
) {
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: { sandboxGetTaskId: async () => ({ taskId: "task-original" }) },
    } as never,
    "sb-original",
    "/workspace",
  );
  const reads = { stdout: 0, stderr: 0, poll: 0 };
  // Replace only the authenticated transport entry. The native control's Start,
  // raw byte reduction, SDK adapter formatting/capture, and routing are real.
  const router = {
    start: async (args: { execId: string; commandArgs: string[] }) => {
      starts.push({ id: args.execId, cmd: args.commandArgs.join(" ") });
    },
    read: async (identity: { execId: string }, stream: "stdout" | "stderr", offset: number) => {
      expect(identity.execId).toBe(starts[0]!.id);
      const terminal = reads[stream]++ > 0;
      expect(offset).toBe(terminal && stream === "stdout" ? 6 : 0);
      if (terminal) {
        entered.resolve();
        await available.promise;
      }
      return {
        bytes: Buffer.from(
          terminal
            ? (stream === "stdout" ? "x" : "y").repeat(2_000)
            : stream === "stdout"
              ? "prefix"
              : "",
        ),
        eof: terminal,
      };
    },
    poll: async () => {
      if (reads.poll++ === 0) return null;
      await available.promise;
      return exitCode;
    },
    close: () => {},
  };
  const cache = control as unknown as {
    routers: Map<string, Promise<{ router: typeof router; users: number; refreshAt: number }>>;
  };
  cache.routers.set(
    "task-original",
    Promise.resolve({ router, users: 0, refreshAt: Date.now() + 60_000 }),
  );
  return control;
}

function fixture(exitCode = 0, sharedTerminal = false) {
  const session: ChannelASession = {
    // Unadmitted read/private work stays on this exact SDK setup observer.
    exec: async (args) => {
      const marker = args.cmd.match(/__OPENGENI_FS_CONFINED_OK__/u)?.[0] ?? "";
      return { stdout: marker, stderr: "", exitCode: 0 };
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
  const enclosingPurposes: Array<string | undefined> = [];
  const retainedPromotions: Array<{
    op: string;
    processId: string;
    purpose: string | undefined;
  }> = [];
  const adoptedBackground: Array<{ processId: string; command: string | undefined }> = [];
  let failObservation = false;
  let failSettlement = false;
  let activeSandboxId: string | null = null;
  let generation = 0;
  const terminalEntered = deferred();
  const terminalAvailable = deferred();
  const native = sharedTerminal
    ? nativeModalControl(starts, terminalEntered, terminalAvailable, exitCode)
    : null;
  installModalCommandSession(
    session,
    native ?? {
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
        if (failObservation && index > 0)
          throw new Error("same invocation temporarily unobservable");
        readIndexes.set(value.execId, index + 1);
        if (sharedTerminal && index === 1) {
          terminalEntered.resolve();
          await terminalAvailable.promise;
        }
        const invocation = starts.find((item) => item.id === value.execId)!;
        const importMarker = invocation.cmd.match(
          /__OPENGENI_WORKSPACE_IMPORT_[0-9a-f]+_OK__/u,
        )?.[0];
        const output = importMarker
          ? `${importMarker}\tcreated`
          : "__OGF_W__0____OPENGENI_FS_BATCH_OK__ €";
        const stdout = sharedTerminal
          ? index === 0
            ? "prefix"
            : "x".repeat(2_000)
          : index === 0
            ? output
            : "";
        const stderr = sharedTerminal
          ? index === 0
            ? ""
            : "y".repeat(2_000)
          : index === 0 && !importMarker
            ? "diagnostic"
            : "";
        const command = structuredClone(value);
        const terminal = index >= (sharedTerminal ? 1 : 2);
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
    },
  );
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
    afterMutation: async ({ op, retainedProcess, retainedProcessPurpose }) => {
      if (!retainedProcess) {
        enclosingSettled.push(op);
        enclosingPurposes.push(retainedProcessPurpose);
      } else {
        retainedPromotions.push({
          op,
          processId: retainedProcess.id,
          purpose: retainedProcessPurpose,
        });
      }
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
      if (failSettlement) {
        failSettlement = false;
        throw new Error("terminal settlement temporarily unavailable");
      }
      settled.push(process.providerSessionId);
    },
    adoptProcessAsBackgroundCommand: async ({ process, command }) => {
      adoptedBackground.push({ processId: process.id, command });
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
    enclosingPurposes,
    retainedPromotions,
    adoptedBackground,
    terminalEntered: terminalEntered.promise,
    releaseTerminal: terminalAvailable.resolve,
    close: async () => {
      await native?.close();
    },
    failSettlementOnce: () => {
      failSettlement = true;
    },
    failObservation: () => {
      failObservation = true;
    },
    swap: () => {
      activeSandboxId = "different-backend";
    },
  };
}

test.each([false, true])(
  "concurrent terminal readers preserve the Modal adapter page across settlement retry %s",
  async (retrySettlement) => {
    const f = fixture(0, true);
    if (retrySettlement) f.failSettlementOnce();
    const initialCaptured = deferred();
    const beginSynchronousRead = deferred();
    const synchronousReadEntered = deferred();
    const completion = f.route
      .execSynchronous({ cmd: "filesystem once", maxOutputTokens: 1 }, async (session, args) => {
        const exec = session.exec!.bind(session);
        session.exec = async (input) => {
          const result = await exec(input);
          initialCaptured.resolve();
          await beginSynchronousRead.promise;
          return result;
        };
        const read = session.writeStdinForProcessControl!.bind(session);
        session.writeStdinForProcessControl = (input) => {
          const pending = read(input);
          synchronousReadEntered.resolve();
          return pending;
        };
        return await executeSynchronousCommand(session, args);
      })
      .finally(() => f.close());
    await initialCaptured.promise;
    const external = f.route.writeStdinForProcessControl({ sessionId: 1, maxOutputTokens: 1 });
    const externalResult = external.catch((error: unknown) => error);
    await f.terminalEntered;
    beginSynchronousRead.resolve();
    // The synchronous collector is now waiting on the same in-flight provider read.
    await synchronousReadEntered.promise;
    f.releaseTerminal();
    const banner = await externalResult;
    if (retrySettlement) expect(banner).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
    else {
      expect(banner).toBeString();
      expect(banner as string).not.toContain("x".repeat(2_000));
    }
    const result = await completion;
    expect(result).toMatchObject({
      stdout: `prefix${"x".repeat(2_000)}`,
      stderr: "y".repeat(2_000),
      exitCode: 0,
    });
    expect(f.starts).toHaveLength(1);
    expect(f.settled).toEqual([1]);
    const command = [...f.commands.values()][0]!;
    expect(command.streams.stdout.byteOffset).toBe(2_006);
    expect(command.streams.stderr.byteOffset).toBe(2_000);
    expect(f.captured.map((page) => page.stdout).join("")).toBe(result.stdout);
    expect(f.captured.map((page) => page.stderr).join("")).toBe(result.stderr);
    expect(f.route.hasRetainedProcess(1)).toBe(false);
  },
);

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
    expect(f.retainedPromotions).toHaveLength(1);
    expect(f.retainedPromotions[0]!.purpose).toBe("synchronous_filesystem");
    expect(f.adoptedBackground).toEqual([]);
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
  expect(f.retainedPromotions[0]!.purpose).toBe("synchronous_filesystem");
  expect(f.adoptedBackground).toEqual([]);
});

test("ordinary yielded exec remains eligible for model-visible background adoption", async () => {
  const promotions: Array<{
    processId: string;
    purpose: string | undefined;
  }> = [];
  const adoptions: Array<{ processId: string; command: string | undefined }> = [];
  const backend = {
    exec: async () => ({ stdout: "started", sessionId: 51, exitCode: null }),
  };
  const route = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
    beforeMutation: async () => "admission",
    afterMutation: async ({ retainedProcess, retainedProcessPurpose }) => {
      if (retainedProcess)
        promotions.push({ processId: retainedProcess.id, purpose: retainedProcessPurpose });
    },
    captureProcessOutput: async () => {},
    adoptProcessAsBackgroundCommand: async ({ process, command }) => {
      adoptions.push({ processId: process.id, command });
    },
  });

  const result = await route.exec({ cmd: "visible command" });
  expect(result).toMatchObject({ sessionId: 51 });
  expect(promotions).toHaveLength(1);
  expect(promotions[0]!.purpose).toBeUndefined();
  expect(route.canAdoptRetainedProcessAsBackgroundCommand(51)).toBe(true);

  await route.adoptRetainedProcessAsBackgroundCommand(51, "visible command");
  expect(adoptions).toEqual([{ processId: promotions[0]!.processId, command: "visible command" }]);
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
  expect(f.retainedPromotions.map((promotion) => promotion.purpose)).toEqual([
    "synchronous_filesystem",
    "synchronous_filesystem",
  ]);
  expect(f.adoptedBackground).toEqual([]);
});

test("read-only yielded handles fail closed without consuming an untrusted banner-only reader", async () => {
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
  await expect(route.execReadOnly({ cmd: "read" })).rejects.toMatchObject({
    code: "synchronous_command_outcome_unknown",
    sessionId: 2_147_483_648,
    output: { stdout: "prefix", stderr: "" },
  });
  expect(starts).toBe(1);
  expect(reads).toBe(0);
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
  expect(f.enclosingPurposes).toEqual(["synchronous_filesystem"]);
  expect(f.retainedPromotions[0]!.purpose).toBe("synchronous_filesystem");
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
