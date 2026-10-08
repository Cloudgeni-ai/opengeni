import { expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";
import {
  RoutingSandboxSession,
  RoutingMutationOutcomeUnknownError,
} from "../src/sandbox/routing/routing-session";
import { withNativeSynchronousCommandCollection } from "../src/sandbox/native-synchronous-collection";
import {
  executeSynchronousCommand,
  observeSynchronousCommand,
  synchronousCommandPage,
} from "../src/sandbox/synchronous-command";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("an established output cursor cannot disappear on a terminal page", async () => {
  await expect(
    observeSynchronousCommand(
      {
        stdout: "prefix",
        stderr: "",
        sessionId: 1,
        exitCode: null,
        wallTimeSeconds: 0,
        outputCursor: {
          identity: "original command",
          expected: { stdout: 0, stderr: 0 },
          next: { stdout: 6, stderr: 0 },
        },
      },
      async () => ({ stdout: "tail", stderr: "", exitCode: 0, wallTimeSeconds: 0 }),
    ),
  ).rejects.toMatchObject({
    code: "synchronous_command_outcome_unknown",
    sessionId: 1,
    output: { stdout: "prefix", stderr: "" },
  });
});

test("a real local SDK terminal structured result preserves separate streams despite presentation truncation", async () => {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  const stdout = `prefix${"x".repeat(2_000)}`;
  const stderr = "y".repeat(2_000);
  try {
    const result = await executeSynchronousCommand(session, {
      cmd: `printf %s '${stdout}'; printf %s '${stderr}' >&2; exit 7`,
      yieldTimeMs: 1_000,
      maxOutputTokens: 1,
    });
    expect(result).toMatchObject({ stdout, stderr, exitCode: 7 });
  } finally {
    await session.close();
  }
});

test("a routed local SDK yielded command captures both streams before exact terminal settlement", async () => {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  const backend = { session, sandboxId: null, kind: "local", activeEpoch: 0 };
  let promotions = 0;
  let reads = 0;
  let settlements = 0;
  const captured: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const write = session.writeStdin.bind(session);
  session.writeStdin = async (args) => {
    reads++;
    return await write(args);
  };
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
    beforeMutation: async () => "admitted",
    afterMutation: async ({ retainedProcess, retainedProcessPurpose }) => {
      expect(retainedProcess?.providerSessionId).toBe(1);
      expect(retainedProcessPurpose).toBe("synchronous_filesystem");
      promotions++;
    },
    captureProcessOutput: async (page) => {
      expect(page.streamFidelity).toBe("separate");
      captured.push(page);
    },
    settleProcess: async () => {
      settlements++;
    },
  });
  try {
    const result = await route.execSynchronous({
      cmd: "sleep 0.15; printf late; printf diagnostic >&2",
      yieldTimeMs: 1,
      maxOutputTokens: 1,
    });
    expect(result).toMatchObject({ stdout: "late", stderr: "diagnostic", exitCode: 0 });
    expect(promotions).toBe(1);
    expect(reads).toBe(1);
    expect(settlements).toBe(1);
    expect(route.hasRetainedProcess(1)).toBe(false);
    expect(
      captured
        .filter((page) => page.stream === "stdout")
        .map((page) => page.chunk)
        .join(""),
    ).toBe("late");
    expect(
      captured
        .filter((page) => page.stream === "stderr")
        .map((page) => page.chunk)
        .join(""),
    ).toBe("diagnostic");
  } finally {
    await session.close();
  }
});

test.each(["none", "capture", "settlement"] as const)(
  "concurrent native readers retain separate output across %s retry",
  async (failure) => {
    const session = await new UnixLocalSandboxClient().create(new Manifest());
    const backend = { session, sandboxId: null, kind: "local", activeEpoch: 0 };
    const initialCaptured = deferred();
    const beginSynchronousRead = deferred();
    const synchronousReadEntered = deferred();
    const externalReadEntered = deferred();
    const releaseExternalRead = deferred();
    const durable = new Map<string, { stream: "stdout" | "stderr"; chunk: string }>();
    const write = session.writeStdin.bind(session);
    let reads = 0;
    let failed = false;
    let settlements = 0;
    session.writeStdin = async (args) => {
      reads++;
      externalReadEntered.resolve();
      await releaseExternalRead.promise;
      return await write(args);
    };
    const route = new RoutingSandboxSession({
      defaultResolved: backend,
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => backend,
      beforeMutation: async () => "admitted",
      afterMutation: async () => {},
      captureProcessOutput: async (page) => {
        expect(page.streamFidelity).toBe("separate");
        durable.set(page.chunkId, page);
        // A lost reply after capture must retry this exact chunk, not replay Start.
        if (failure === "capture" && !failed && page.chunk !== "prefix") {
          failed = true;
          throw new Error("capture reply unavailable");
        }
      },
      settleProcess: async () => {
        if (failure === "settlement" && !failed) {
          failed = true;
          throw new Error("settlement unavailable");
        }
        settlements++;
      },
    });
    const completion = route.execSynchronous(
      {
        cmd: `printf prefix; sleep 0.15; printf %s '${"x".repeat(2_000)}'; printf %s '${"y".repeat(2_000)}' >&2`,
        yieldTimeMs: 50,
        maxOutputTokens: 1,
        login: false,
      },
      async (adapter, args) => {
        const exec = adapter.exec!.bind(adapter);
        adapter.exec = async (input) => {
          const raw = await exec(input);
          expect(raw.stdout).toBe("prefix");
          initialCaptured.resolve();
          await beginSynchronousRead.promise;
          return raw;
        };
        const read = adapter.writeStdinForProcessControl!.bind(adapter);
        adapter.writeStdinForProcessControl = (input) => {
          const result = read(input);
          synchronousReadEntered.resolve();
          return result;
        };
        return await executeSynchronousCommand(adapter, args);
      },
    );
    try {
      await initialCaptured.promise;
      const external = route.writeStdinForProcessControl({ sessionId: 1, maxOutputTokens: 1 });
      const externalResult = external.catch((error: unknown) => error);
      await externalReadEntered.promise;
      beginSynchronousRead.resolve();
      await synchronousReadEntered.promise;
      releaseExternalRead.resolve();
      const banner = await externalResult;
      if (failure === "none") {
        expect(banner).toBeString();
        expect(banner as string).not.toContain("x".repeat(2_000));
      } else expect(banner).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
      const result = await completion;
      expect(result).toMatchObject({
        stdout: `prefix${"x".repeat(2_000)}`,
        stderr: "y".repeat(2_000),
        exitCode: 0,
      });
      expect(reads).toBe(1);
      expect(settlements).toBe(1);
      expect(route.hasRetainedProcess(1)).toBe(false);
      for (const stream of ["stdout", "stderr"] as const)
        expect(
          [...durable.values()]
            .filter((page) => page.stream === stream)
            .map((page) => page.chunk)
            .join(""),
        ).toBe(result[stream]);
      expect(durable.size).toBe(3);
    } finally {
      beginSynchronousRead.resolve();
      releaseExternalRead.resolve();
      await session.close();
    }
  },
);

test.each(["capture", "settlement"] as const)(
  "external native terminal recovery releases output custody only after successful %s retry",
  async (failure) => {
    const session = await new UnixLocalSandboxClient().create(new Manifest());
    const backend = { session, sandboxId: null, kind: "local", activeEpoch: 0 };
    const durable = new Map<string, { stream: "stdout" | "stderr"; chunk: string }>();
    const receipts: string[] = [];
    const stdout = "x".repeat(2_000);
    const stderr = "y".repeat(2_000);
    const exec = session.exec.bind(session);
    let starts = 0;
    let reads = 0;
    let failures = 2;
    let settlements = 0;
    session.exec = async (args) => {
      starts++;
      return await exec(args);
    };
    const route = new RoutingSandboxSession({
      defaultResolved: backend,
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => backend,
      beforeMutation: async () => "admitted",
      afterMutation: async () => {
        const write = session.writeStdin.bind(session);
        session.writeStdin = async (args) => {
          reads++;
          const receipt = await write(args);
          receipts.push(receipt);
          return receipt;
        };
      },
      captureProcessOutput: async (page) => {
        expect(page.streamFidelity).toBe("separate");
        durable.set(page.chunkId, page);
        if (failure === "capture" && failures > 0) {
          failures--;
          throw new Error("capture reply unavailable");
        }
      },
      settleProcess: async () => {
        if (failure === "settlement" && failures > 0) {
          failures--;
          throw new Error("settlement reply unavailable");
        }
        settlements++;
      },
    });
    const output = session as typeof session & {
      getSynchronousCommandOutput(
        result: unknown,
      ): ReturnType<typeof synchronousCommandPage> | null;
    };
    try {
      await expect(
        route.execSynchronous({
          cmd: `sleep 0.08; printf %s '${stdout}'; printf %s '${stderr}' >&2`,
          yieldTimeMs: 1,
          maxOutputTokens: 1,
          login: false,
        }),
      ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown", sessionId: 1 });
      expect(route.hasRetainedProcess(1)).toBe(true);
      expect(receipts).toHaveLength(1);
      expect(output.getSynchronousCommandOutput(receipts[0])).toMatchObject({
        stdout,
        stderr,
        exitCode: 0,
      });
      await expect(
        route.writeStdinForProcessControl({ sessionId: 1, chars: "", maxOutputTokens: 1 }),
      ).rejects.toBeInstanceOf(RoutingMutationOutcomeUnknownError);
      expect(route.hasRetainedProcess(1)).toBe(true);
      expect(output.getSynchronousCommandOutput(receipts[0])).not.toBeNull();
      const recovered = await route.writeStdinForProcessControl({
        sessionId: 1,
        chars: "",
        maxOutputTokens: 1,
      });
      expect(recovered).toBe(receipts[0]!);
      expect(route.hasRetainedProcess(1)).toBe(false);
      expect(output.getSynchronousCommandOutput(recovered)).toBeNull();
      expect(starts).toBe(1);
      expect(reads).toBe(1);
      expect(settlements).toBe(1);
      for (const stream of ["stdout", "stderr"] as const)
        expect(
          [...durable.values()]
            .filter((page) => page.stream === stream)
            .map((page) => page.chunk)
            .join(""),
        ).toBe(stream === "stdout" ? stdout : stderr);
      const retired = await session.writeStdin({ sessionId: 1, chars: "", maxOutputTokens: 1 });
      expect(retired).not.toStartWith("Native output receipt:");
      expect(output.getSynchronousCommandOutput(retired)).toBeNull();
      expect(starts).toBe(1);
    } finally {
      await session.close();
    }
  },
);

test("banner-only terminal output cannot masquerade as separated streams through routing", async () => {
  const backend = {
    session: { execCommand: async () => "Process exited with code 0\n\nOutput:\nmerged" },
    sandboxId: null,
    kind: "local",
  };
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
  });
  await expect(route.execSynchronous({ cmd: "read" })).rejects.toMatchObject({
    code: "synchronous_command_outcome_unknown",
    output: { stdout: "", stderr: "" },
  });
});

test.each([1, 20_000])(
  "the real local SDK yielded command preserves complete separate output at token limit %s",
  async (maxOutputTokens) => {
    const session = await new UnixLocalSandboxClient().create(new Manifest());
    const stdout = `prefix${"x".repeat(2_000)}`;
    const stderr = "y".repeat(2_000);
    const command = `printf prefix; sleep 0.15; printf %s '${"x".repeat(2_000)}'; printf %s '${stderr}' >&2`;
    let starts = 0;
    let reads = 0;
    let originalHandle: number | undefined;
    const exec = session.exec.bind(session);
    const write = session.writeStdin.bind(session);
    session.exec = async (args) => {
      expect(args.cmd).toBe(command);
      expect(args.tty).toBeUndefined();
      starts++;
      const page = await exec(args);
      expect(page.stdout).toBe("prefix");
      originalHandle = page.sessionId;
      return page;
    };
    session.writeStdin = async (args) => {
      reads++;
      expect(args.sessionId).toBe(originalHandle);
      expect(args.chars).toBe("");
      expect(args.maxOutputTokens).toBe(maxOutputTokens);
      return await write(args);
    };
    try {
      const result = await executeSynchronousCommand(session, {
        cmd: command,
        yieldTimeMs: 50,
        maxOutputTokens,
      });
      expect(originalHandle).toBeNumber();
      expect(result).toMatchObject({ stdout, stderr, exitCode: 0 });
      expect(starts).toBe(1);
      expect(reads).toBe(1);
    } finally {
      await session.close();
    }
  },
);

test("the worker collects a real local SDK yielded command through the native collection scope", async () => {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  const controller = createTurnToolCancellationController();
  const command = `sleep 0.15; printf %s '${"x".repeat(2_000)}'; printf %s '${"y".repeat(2_000)}' >&2`;
  const exec = session.execCommand.bind(session);
  const write = session.writeStdin.bind(session);
  let starts = 0;
  let reads = 0;
  session.execCommand = async (args) => {
    if (args.cmd.includes(command)) {
      expect(args.tty).toBe(false);
      starts++;
    }
    return await exec(args);
  };
  session.writeStdin = async (args) => {
    reads++;
    return await write(args);
  };
  try {
    const result = await withNativeSynchronousCommandCollection(session, () =>
      controller.runSandboxCommandSynchronous(session, {
        cmd: command,
        yieldTimeMs: 1,
        maxOutputTokens: 1,
      }),
    );
    expect(result).toMatchObject({
      stdout: "x".repeat(2_000),
      stderr: "y".repeat(2_000),
      exitCode: 0,
    });
    expect(starts).toBe(1);
    expect(reads).toBe(1);
  } finally {
    controller.cancel();
    await controller.waitForQuiescence();
    await session.close();
  }
}, 30_000);

test.each([1, 1_000])(
  "native stream capture preserves output beyond the SDK presentation buffer at yield %s",
  async (yieldTimeMs) => {
    const session = await new UnixLocalSandboxClient().create(new Manifest());
    try {
      const result = await executeSynchronousCommand(session, {
        cmd: "sleep 0.05; printf '%02000000d' 0; printf '%02000000d' 0 >&2; exit 7",
        yieldTimeMs,
        maxOutputTokens: 1,
        login: false,
      });
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toBe("0".repeat(2_000_000));
      expect(result.stderr).toBe("0".repeat(2_000_000));
    } finally {
      await session.close();
    }
  },
  30_000,
);

test("an installed native adapter leaves ordinary yielded banner formatting unchanged", async () => {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  try {
    await executeSynchronousCommand(session, { cmd: "printf setup", maxOutputTokens: 1 });
    const initial = await session.exec({
      cmd: "sleep 0.1; printf data; printf diagnostic >&2",
      yieldTimeMs: 1,
    });
    expect(initial.sessionId).toBeNumber();
    const terminal = await session.writeStdin({
      sessionId: initial.sessionId!,
      chars: "",
      yieldTimeMs: 1_000,
      maxOutputTokens: 1,
    });
    expect(terminal).not.toContain("Native output receipt:");
    expect(terminal).not.toContain("diagnostic");
    expect(terminal).toContain("Process exited with code 0");
  } finally {
    await session.close();
  }
});

test("real native completion waits for descendant-held stderr EOF after leader exit", async () => {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  let complete = false;
  try {
    const result = executeSynchronousCommand(session, {
      cmd: "printf prefix; (sleep 0.15; printf late >&2)& exit 7",
      yieldTimeMs: 1,
      maxOutputTokens: 1,
      login: false,
    }).then((value) => {
      complete = true;
      return value;
    });
    await Bun.sleep(25);
    expect(complete).toBe(false);
    expect(await result).toMatchObject({ stdout: "prefix", stderr: "late", exitCode: 7 });
  } finally {
    await session.close();
  }
});

test("real native UTF-8 split across yields is decoded independently in both streams", async () => {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  try {
    const result = await executeSynchronousCommand(session, {
      cmd: "printf '\\342\\202'; printf '\\360\\237' >&2; sleep 0.1; printf '\\254'; printf '\\230\\200' >&2",
      yieldTimeMs: 1,
      maxOutputTokens: 1,
      login: false,
    });
    expect(result).toMatchObject({ stdout: "€", stderr: "😀", exitCode: 0 });
  } finally {
    await session.close();
  }
});

test("native close after a running receipt still consumes the exact SDK terminal handle", async () => {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  const write = session.writeStdin.bind(session);
  let reads = 0;
  session.writeStdin = async (args) => {
    reads++;
    const raw = await write(args);
    if (reads === 1) {
      expect(raw).toContain("Process running with session ID 1");
      // The actual child closes while this genuinely running SDK receipt is
      // in transit. Its map entry still needs the final exact-handle read.
      await Bun.sleep(250);
    }
    return raw;
  };
  try {
    const result = await withNativeSynchronousCommandCollection(session, async () => {
      const raw = await session.exec({
        cmd: "sleep 0.15; printf complete; printf diagnostic >&2",
        yieldTimeMs: 1,
        login: false,
      });
      return await observeSynchronousCommand(
        synchronousCommandPage(session, raw),
        async (sessionId) =>
          synchronousCommandPage(
            session,
            await session.writeStdin({
              sessionId,
              chars: "",
              yieldTimeMs: 1,
              maxOutputTokens: 1,
            }),
            sessionId,
          ),
      );
    });
    expect(result).toMatchObject({ stdout: "complete", stderr: "diagnostic", exitCode: 0 });
    expect(reads).toBe(2);
  } finally {
    await session.close();
  }
});

test("malformed native read metadata fails closed on the original handle without replay", async () => {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  const exec = session.exec.bind(session);
  const write = session.writeStdin.bind(session);
  let starts = 0;
  session.exec = async (args) => {
    starts++;
    return await exec(args);
  };
  session.writeStdin = async (args) => {
    await write(args);
    return "Unprovable provider metadata\nOutput:\nnot a receipt";
  };
  try {
    await expect(
      executeSynchronousCommand(session, {
        cmd: "printf prefix; sleep 0.1; printf late; printf diagnostic >&2",
        yieldTimeMs: 25,
        maxOutputTokens: 1,
        login: false,
      }),
    ).rejects.toMatchObject({
      code: "synchronous_command_outcome_unknown",
      sessionId: 1,
      output: { stdout: "prefix", stderr: "" },
    });
    expect(starts).toBe(1);
  } finally {
    await session.close();
  }
});
