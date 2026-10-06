import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseExecResponseBanner } from "../src/sandbox/exec-banner";
import {
  MachineSandboxSession,
  MachineCommandOutcomeError,
  MachineCommandHandleUnavailableError,
  type MachineSessionPersistence,
  type MachineSessionCommand,
} from "../src/sandbox/v2/machine-session";
import { JournalBindingError, type MachineExecTransport } from "../src/sandbox/v2/journal-client";
import {
  journalSpecificationDigest,
  type JournalObservation,
  JournalCapabilities,
  type JournalStartRequest,
} from "../src/sandbox/v2/journal-protocol";

function fixture(output = Buffer.from("😀tail")) {
  const machineId = randomUUID();
  const instance = { id: "synthetic-instance", bootId: "a".repeat(64), diskLineage: randomUUID() };
  const records = new Map<number, MachineSessionCommand>();
  const specs = new Map<string, JournalStartRequest>();
  const captures: string[] = [];
  const inputs: { sequence: number; body: unknown }[] = [];
  const actionOutput = new Map<
    string,
    { stdout: string; stderr: string; observation: JournalObservation | null }
  >();
  const acceptedInputs = new Map<number, unknown>();
  const causalExec = new Map<string, { requestDigest: string; operationId: string }>();
  const abandoned = new Set<string>();
  const causalInputs = new Map<
    string,
    { requestDigest: string; partCount: number; action: unknown; sequence: number }
  >();
  let causalAction: string | null = null;
  let failInputSequence = 0;
  let failInputReplies = 0;
  let handle = 0;
  let nextSequence = 0;
  let dispatches = 0;
  let launches = 0;
  let proofs = 0;
  let revoked = false;
  let lostReply = false;
  let cancelFinished = false;
  let captureFailure = false;
  const persistence: MachineSessionPersistence = {
    allocateOperationId: async (input) => {
      const key = causalAction ?? randomUUID();
      const prior = causalExec.get(key);
      if (prior && prior.requestDigest !== input.requestDigest)
        throw new JournalBindingError("causal exec conflict");
      if (prior && abandoned.has(prior.operationId))
        throw new JournalBindingError("abandoned causal action");
      const retained = prior ?? { ...input, operationId: randomUUID() };
      causalExec.set(key, retained);
      return retained.operationId;
    },
    abandonOperationId: async (id) => {
      if ([...records.values()].some((row) => row.command.operationId === id)) return false;
      abandoned.add(id);
      return true;
    },
    reserve: async (command) => {
      if (abandoned.has(command.operationId)) throw new JournalBindingError("abandoned dispatch");
      const prior = [...records.values()].find(
        (row) => row.command.operationId === command.operationId,
      );
      if (prior) return structuredClone(prior.command);
      records.set(++handle, {
        handle,
        revision: 0,
        command: structuredClone(command),
        stdout: { offset: 0, remainder: "" },
        stderr: { offset: 0, remainder: "" },
      });
      return command;
    },
    assert: async (command) => {
      if (revoked) throw new Error("synthetic authority revoked");
      expect([...records.values()].some((row) => isDeepStrictEqual(row.command, command))).toBe(
        true,
      );
    },
    handleFor: async (command) =>
      [...records.values()].find((row) => row.command.operationId === command.operationId)!.handle,
    load: async (id) => structuredClone(records.get(id) ?? null),
    loadOperation: async (id) =>
      structuredClone([...records.values()].find((row) => row.command.operationId === id) ?? null),
    loadCapturedOutput: async (command) =>
      structuredClone(
        actionOutput.get(`${causalAction}:${command.operationId}`) ?? {
          stdout: "",
          stderr: "",
          observation: null,
        },
      ),
    reserveInput: async (command, input) => {
      const key = `${causalAction ?? randomUUID()}:${command.operationId}:${input.partIndex}`;
      const prior = causalInputs.get(key);
      if (
        prior &&
        (prior.requestDigest !== input.requestDigest ||
          prior.partCount !== input.partCount ||
          !isDeepStrictEqual(prior.action, input.action))
      )
        throw new JournalBindingError("causal input conflict");
      const retained = prior ?? { ...structuredClone(input), sequence: ++nextSequence };
      causalInputs.set(key, retained);
      return retained.sequence;
    },
    capture: async (input) => {
      if (revoked) throw new Error("synthetic authority revoked during capture");
      if (captureFailure) throw new Error("synthetic capture failure");
      if (!isDeepStrictEqual(records.get(input.expected.handle), input.expected)) return false;
      records.set(input.next.handle, structuredClone(input.next));
      {
        const key = `${causalAction}:${input.expected.command.operationId}`;
        const prior = actionOutput.get(key) ?? { stdout: "", stderr: "", observation: null };
        actionOutput.set(key, {
          stdout: prior.stdout + input.stdout,
          stderr: prior.stderr + input.stderr,
          observation: structuredClone(input.observation),
        });
      }
      captures.push(input.stdout + input.stderr);
      return true;
    },
    recordControlProof: async () => {
      if (revoked) throw new Error("synthetic authority revoked during proof");
      if (captureFailure) throw new Error("synthetic proof failure");
      proofs++;
    },
  };
  const bytes = Buffer.from(output);
  function page(spec: JournalStartRequest, offset: number, terminal: boolean): JournalObservation {
    const end = terminal ? Math.min(offset + 64 * 1024, bytes.length) : 2;
    return {
      operationId: spec.operationId,
      specificationDigest: journalSpecificationDigest(spec),
      state: terminal ? "exited" : "running",
      receipt: terminal
        ? {
            protocol: "native-subreaper-v1",
            invocationId: spec.operationId,
            receiptId: randomUUID(),
            leaderExitCode: 7,
            acceptedInputSequence: nextSequence,
          }
        : null,
      stdout: {
        offset,
        nextOffset: end,
        data: bytes.subarray(offset, end).toString("base64"),
        eof: terminal && end === bytes.length,
      },
      stderr: { offset: 0, nextOffset: 0, data: "", eof: terminal },
    };
  }
  const transport: MachineExecTransport = {
    exec: async (call) => {
      dispatches++;
      expect(call.instanceId).toBe(instance.id);
      let body: unknown;
      if (call.argv.includes("start")) {
        const spec = JSON.parse(Buffer.from(call.stdin!).toString()) as JournalStartRequest;
        if (!specs.has(spec.operationId)) {
          specs.set(spec.operationId, spec);
          launches++;
        }
        if (lostReply) {
          lostReply = false;
          throw new Error("synthetic lost Start reply");
        }
        body = page(spec, 0, false);
      } else if (call.argv.includes("input")) {
        const input = JSON.parse(Buffer.from(call.stdin!).toString());
        inputs.push({ sequence: input.sequence, body: input.input });
        const prior = acceptedInputs.get(input.sequence);
        if (prior && !isDeepStrictEqual(prior, input.input))
          throw new Error("native input conflict");
        if (!prior && input.sequence !== acceptedInputs.size + 1)
          throw new Error("native input sequence gap");
        acceptedInputs.set(input.sequence, input.input);
        if (input.sequence === failInputSequence && failInputReplies-- > 0)
          throw new Error("lost input ACK");
        body = {
          operationId: input.operationId,
          sequence: input.sequence,
          status: "accepted",
          acceptedThrough: input.sequence,
          reason: "synthetic",
        };
      } else {
        const operationId = call.argv[call.argv.indexOf("--operation") + 1]!;
        const spec = specs.get(operationId)!;
        const offset = call.argv.includes("read")
          ? Number(call.argv[call.argv.indexOf("--stdout") + 1])
          : 0;
        body = page(spec, offset, call.argv.includes("read") || cancelFinished);
      }
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify(body)) };
    },
  };
  function session(override: Partial<ConstructorParameters<typeof MachineSandboxSession>[0]> = {}) {
    return new MachineSandboxSession({
      provider: "synthetic",
      machineId,
      instance,
      transport,
      persistence,
      environment: async () => ({ PATH: "/usr/bin:/bin" }),
      capabilities: { stdin: true, pty: true },
      ...override,
    });
  }
  return {
    session,
    persistence,
    transport,
    records,
    specs,
    captures,
    inputs,
    acceptedInputs,
    counts: () => ({ dispatches, launches, proofs }),
    instance,
    useAction: (id: string | null) => {
      causalAction = id;
    },
    loseInputReplies: (sequence: number, replies: number) => {
      failInputSequence = sequence;
      failInputReplies = replies;
    },
    revoke: () => {
      revoked = true;
    },
    drop: () => {
      lostReply = true;
    },
    finishCancel: () => {
      cancelFinished = true;
    },
    failCapture: () => {
      captureFailure = true;
    },
  };
}

describe("unified machine sandbox command session", () => {
  test("one setup action continues past its output observation window without another Start", async () => {
    const text = "😀".repeat(150_000) + "finished";
    const f = fixture(Buffer.from(text));
    f.useAction("large-setup-action");
    let result = await f.session().exec({ cmd: "synthetic large output", yieldTimeMs: 30_000 });
    expect(result.sessionId).toBe(1);
    expect(result.exitCode).toBeUndefined();
    const firstOffset = f.records.get(1)!.stdout.offset;
    result = await f.session().pollCommand({ sessionId: 1, yieldTimeMs: 30_000 });
    expect(f.records.get(1)!.stdout.offset).toBeGreaterThan(firstOffset);
    while (result.sessionId !== undefined)
      result = await f.session().pollCommand({ sessionId: 1, yieldTimeMs: 30_000 });
    expect(result.exitCode).toBe(7);
    expect(f.captures.join("")).toBe(text);
    expect(f.counts().launches).toBe(1);
  });
  test("fresh session resumes durable alias and split UTF-8 byte cursor", async () => {
    const f = fixture();
    f.drop();
    const first = await f.session().exec({ cmd: "synthetic-command", yieldTimeMs: 0 });
    expect(first.sessionId).toBe(1);
    expect(first.stdout).toBe("");
    expect(f.counts().launches).toBe(1);
    expect(f.records.get(1)?.stdout).toEqual({ offset: 2, remainder: "8J8=" });
    const completed = await f.session().writeStdin({ sessionId: 1, yieldTimeMs: 0 });
    expect(parseExecResponseBanner(completed)).toEqual({ kind: "exited", exitCode: 7 });
    expect(completed).toContain("😀tail");
    expect(f.captures.join("")).toBe("😀tail");
    expect(f.counts().launches).toBe(1);
  });
  test("revocation stops an adopted input before provider dispatch", async () => {
    const f = fixture();
    await f.session().exec({ cmd: "synthetic-command", yieldTimeMs: 0 });
    const before = f.counts().dispatches;
    f.revoke();
    await expect(f.session().writeStdin({ sessionId: 1, chars: "input" })).rejects.toThrow(
      "revoked",
    );
    expect(f.counts().dispatches).toBe(before);
  });
  test("input is byte-chunked and close/resize use monotonic durable sequence allocation", async () => {
    const f = fixture();
    const session = f.session();
    await session.exec({ cmd: "synthetic-command", yieldTimeMs: 0 });
    await session.writeStdin({ sessionId: 1, chars: "x".repeat(4095) + "😀", yieldTimeMs: 0 });
    await session.closeStdin(1);
    expect(f.inputs.map((value) => value.sequence)).toEqual([1, 2, 3]);
    const data = f.inputs
      .slice(0, 2)
      .map((value) => Buffer.from((value.body as { base64: string }).base64, "base64"));
    expect(Buffer.concat(data).toString()).toBe("x".repeat(4095) + "😀");
    expect(data[0]?.length).toBe(4096);
    expect(data[1]?.length).toBe(3);
    expect(f.inputs[2]?.body).toEqual({ kind: "close" });
    await expect(session.resizePty(1, 100, 40)).rejects.toBeInstanceOf(JournalBindingError);
    await session.writeStdin({ sessionId: 1, chars: "after-invalid", yieldTimeMs: 0 });
    expect(f.inputs.at(-1)?.sequence).toBe(4);
  });
  test("invalid PTY sizes and pipe close on PTY reserve no input sequence", async () => {
    const f = fixture();
    const session = f.session();
    await session.exec({ cmd: "synthetic", tty: true, yieldTimeMs: 0 });
    await expect(session.resizePty(1, 0, 40)).rejects.toThrow();
    await expect(session.closeStdin(1)).rejects.toBeInstanceOf(JournalBindingError);
    await session.resizePty(1, 100, 40);
    expect(f.inputs.map((input) => input.sequence)).toEqual([1]);
  });
  test("equal chunks and whole-action replacement replay preserve distinct native effects", async () => {
    const f = fixture();
    await f.session().exec({ cmd: "synthetic", yieldTimeMs: 0 });
    f.useAction("accepted-input");
    f.loseInputReplies(2, 2);
    const chars = "x".repeat(8192);
    await expect(f.session().writeStdin({ sessionId: 1, chars, yieldTimeMs: 0 })).rejects.toThrow();
    expect(f.acceptedInputs.size).toBe(2);
    await f.session().writeStdin({ sessionId: 1, chars, yieldTimeMs: 0 });
    expect(f.inputs.map((input) => input.sequence)).toEqual([1, 2, 2, 1, 2]);
    expect(f.acceptedInputs.size).toBe(2);
    expect(
      Buffer.concat(
        [...f.acceptedInputs.values()].map((input) =>
          Buffer.from((input as { base64: string }).base64, "base64"),
        ),
      ).toString(),
    ).toBe(chars);
    const before = f.counts().dispatches;
    await expect(
      f.session().writeStdin({ sessionId: 1, chars: "different", yieldTimeMs: 0 }),
    ).rejects.toThrow("causal input conflict");
    expect(f.counts().dispatches).toBe(before);
  });
  test("causal exec replay reads its retained operation without refreshed credentials or Start", async () => {
    const f = fixture();
    f.useAction("accepted-exec");
    let environments = 0;
    const environment = async () => ({ TOKEN: `temporary-${++environments}` });
    await f.session({ environment }).exec({ cmd: "synthetic", yieldTimeMs: 0 });
    const done = await f.session({ environment }).exec({ cmd: "synthetic", yieldTimeMs: 0 });
    expect(done.exitCode).toBe(7);
    expect(environments).toBe(1);
    expect(f.counts().launches).toBe(1);
    const before = f.counts().dispatches;
    await expect(
      f.session({ environment }).exec({ cmd: "conflicting", yieldTimeMs: 0 }),
    ).rejects.toThrow("causal exec conflict");
    expect(f.counts().dispatches).toBe(before);
  });
  test("an unfinished unknown observation can recover by reading without a new Start", async () => {
    const f = fixture();
    f.useAction("unknown-then-recovered");
    let uncertain = true;
    const transport: MachineExecTransport = {
      exec: async (input) => {
        const reply = await f.transport.exec(input);
        if (!uncertain) return reply;
        uncertain = false;
        const page = JSON.parse(Buffer.from(reply.stdout).toString()) as JournalObservation;
        return {
          ...reply,
          stdout: Buffer.from(
            JSON.stringify({
              ...page,
              state: "unknown",
              receipt: null,
              stdout: { offset: 0, nextOffset: 0, data: "", eof: false },
              stderr: { offset: 0, nextOffset: 0, data: "", eof: false },
            }),
          ),
        };
      },
    };
    await expect(
      f.session({ transport }).exec({ cmd: "synthetic", yieldTimeMs: 0 }),
    ).rejects.toBeInstanceOf(MachineCommandOutcomeError);
    const done = await f.session({ transport }).exec({ cmd: "synthetic", yieldTimeMs: 0 });
    expect(done.exitCode).toBe(7);
    expect(done.stdout).toBe("😀tail");
    expect(f.counts().launches).toBe(1);
  });
  test("large unresolved output never turns a retained unknown into a running reply", async () => {
    const f = fixture();
    f.useAction("large-unknown-then-lost");
    let reads = 0;
    const transport: MachineExecTransport = {
      exec: async (input) => {
        if (input.argv.includes("start")) {
          const reply = await f.transport.exec(input);
          const page = JSON.parse(Buffer.from(reply.stdout).toString()) as JournalObservation;
          const bytes = Buffer.from("x".repeat(300_000));
          return {
            ...reply,
            stdout: Buffer.from(
              JSON.stringify({
                ...page,
                state: "unknown",
                stdout: {
                  offset: 0,
                  nextOffset: bytes.length,
                  data: bytes.toString("base64"),
                  eof: false,
                },
              }),
            ),
          };
        }
        reads++;
        const command = f.records.get(1)!.command;
        return {
          exitCode: 0,
          stdout: Buffer.from(
            JSON.stringify({
              operationId: command.operationId,
              specificationDigest: command.specificationDigest,
              state: "lost",
              receipt: null,
              stdout: { offset: 300_000, nextOffset: 300_000, data: "", eof: false },
              stderr: { offset: 0, nextOffset: 0, data: "", eof: false },
            }),
          ),
        };
      },
    };
    await expect(
      f.session({ transport }).exec({ cmd: "synthetic", yieldTimeMs: 0 }),
    ).rejects.toBeInstanceOf(MachineCommandOutcomeError);
    await expect(
      f.session({ transport }).exec({ cmd: "synthetic", yieldTimeMs: 0 }),
    ).rejects.toBeInstanceOf(MachineCommandOutcomeError);
    expect(reads).toBe(1);
    expect(f.counts().launches).toBe(1);
  });
  test("a concurrent observer cannot omit the same accepted action's committed prefix", async () => {
    const f = fixture();
    f.useAction("concurrent-accepted-exec");
    const args = { cmd: "synthetic", yieldTimeMs: 0 };
    await f.session().exec(args);
    const load = f.persistence.loadCapturedOutput;
    let announce!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    f.persistence.loadCapturedOutput = async (command) => {
      const prior = await load(command);
      if (first) {
        first = false;
        announce();
        await gate;
      }
      return prior;
    };
    const slow = f.session().exec(args);
    try {
      await entered;
      const fast = await f.session().exec(args);
      expect(fast.stdout).toBe("😀tail");
      release();
      const recovered = await slow;
      expect(recovered.stdout).toBe(fast.stdout);
      expect(recovered.exitCode).toBe(7);
      expect(f.counts().launches).toBe(1);
    } finally {
      release();
      await slow;
    }
  });
  test("numeric alias allocation failure cannot cross the Start boundary", async () => {
    const f = fixture();
    f.persistence.handleFor = async () => {
      throw new Error("alias persistence failed");
    };
    await expect(f.session().exec({ cmd: "synthetic", yieldTimeMs: 0 })).rejects.toThrow(
      "alias persistence failed",
    );
    expect(f.counts().dispatches).toBe(0);
  });
  test("revocation during transport cannot commit output cursors or a positive cancellation proof", async () => {
    const f = fixture();
    await f.session().exec({ cmd: "synthetic", yieldTimeMs: 0 });
    const transport: MachineExecTransport = {
      exec: async (call) => {
        const response = await f.transport.exec(call);
        f.revoke();
        return response;
      },
    };
    await expect(
      f.session({ transport }).writeStdin({ sessionId: 1, yieldTimeMs: 0 }),
    ).rejects.toThrow("revoked during capture");
    expect(f.records.get(1)?.stdout.offset).toBe(2);
    const g = fixture();
    await g.session().exec({ cmd: "synthetic", yieldTimeMs: 0 });
    g.finishCancel();
    const cancelTransport: MachineExecTransport = {
      exec: async (call) => {
        const response = await g.transport.exec(call);
        g.revoke();
        return response;
      },
    };
    await expect(
      g
        .session({ transport: cancelTransport })
        .cancelExecCommand(g.records.get(1)!.command.operationId),
    ).rejects.toThrow("revoked during proof");
    expect(g.counts().proofs).toBe(0);
  });
  test("public machine state and serialized copies cannot redirect immutable transport binding", () => {
    const f = fixture();
    const session = f.session();
    expect(() => {
      session.state.instance.id = "redirected";
    }).toThrow();
    const copy = session.serialize();
    copy.instance.id = "redirected";
    expect(session.serialize().instance.id).toBe(f.instance.id);
  });
  test("cancel ACK supplies no proof until exact terminal evidence commits", async () => {
    const f = fixture();
    const session = f.session();
    await session.exec({ cmd: "synthetic-command", yieldTimeMs: 0 });
    const operationId = f.records.get(1)!.command.operationId;
    expect(await session.cancelExecCommand(operationId)).toBe(false);
    expect(f.counts().proofs).toBe(0);
    f.finishCancel();
    expect(await session.cancelExecCommand(operationId)).toBe(true);
    expect(f.counts().proofs).toBe(1);
    f.failCapture();
    await expect(session.cancelExecCommand(operationId)).rejects.toThrow("proof failure");
    expect(f.counts().proofs).toBe(1);
  });
  test("capture failure retains unacknowledged bytes for a replacement observer", async () => {
    const f = fixture();
    await f.session().exec({ cmd: "synthetic-command", yieldTimeMs: 0 });
    f.failCapture();
    await expect(f.session().writeStdin({ sessionId: 1 })).rejects.toThrow("capture failure");
    expect(f.records.get(1)?.stdout.offset).toBe(2);
  });
  test("unknown alias, replacement machine and escaping cwd cannot reach provider", async () => {
    const f = fixture();
    const session = f.session();
    await expect(session.writeStdin({ sessionId: 1 })).rejects.toBeInstanceOf(
      MachineCommandHandleUnavailableError,
    );
    await expect(
      session.exec({ cmd: "synthetic", workdir: "../elsewhere" }),
    ).rejects.toBeInstanceOf(JournalBindingError);
    expect(f.counts().dispatches).toBe(0);
    await session.exec({ cmd: "synthetic", yieldTimeMs: 0 });
    const before = f.counts().dispatches;
    await expect(
      f.session({ machineId: randomUUID() }).writeStdin({ sessionId: 1 }),
    ).rejects.toBeInstanceOf(MachineCommandHandleUnavailableError);
    expect(f.counts().dispatches).toBe(before);
  });
  test("retained operation absence stays unknown and never formats exit success", async () => {
    const f = fixture();
    await f.session().exec({ cmd: "synthetic-command", yieldTimeMs: 0 });
    const transport: MachineExecTransport = {
      exec: async () => ({
        exitCode: 0,
        stdout: Buffer.from(
          JSON.stringify({
            operationId: f.records.get(1)!.command.operationId,
            specificationDigest: null,
            receipt: null,
            state: "not_found",
            stdout: { offset: 2, nextOffset: 2, data: "", eof: false },
            stderr: { offset: 0, nextOffset: 0, data: "", eof: false },
          }),
        ),
      }),
    };
    await expect(f.session({ transport }).writeStdin({ sessionId: 1 })).rejects.toBeInstanceOf(
      MachineCommandOutcomeError,
    );
    expect(f.counts().proofs).toBe(0);
  });
});

const image = process.env.JOURNAL_CONFORMANCE_IMAGE;
(image ? test : test.skip)(
  "real Linux: unified session survives lost Start/input replies and adapter replacement",
  async () => {
    async function docker(argv: string[], input?: Uint8Array) {
      const child = Bun.spawn(["docker", ...argv], {
        stdin: input ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
      try {
        const [stdout, , exitCode] = await Promise.all([
          new Response(child.stdout).arrayBuffer(),
          new Response(child.stderr).arrayBuffer(),
          child.exited,
        ]);
        return { exitCode, stdout: new Uint8Array(stdout) };
      } finally {
        clearTimeout(timer);
      }
    }
    const created = await docker([
      "create",
      "--network",
      "none",
      "--memory",
      "256m",
      "--cpus",
      "0.5",
      "--label",
      "opengeni.test=journal-session-v1",
      image!,
      "/bin/sleep",
      "120",
    ]);
    expect(created.exitCode).toBe(0);
    const container = Buffer.from(created.stdout).toString().trim();
    expect(container).toMatch(/^[a-f0-9]{64}$/u);
    try {
      expect((await docker(["start", container])).exitCode).toBe(0);
      expect(
        (await docker(["exec", container, "mkdir", "-p", "/tmp/session-workspace"])).exitCode,
      ).toBe(0);
      const capabilityReply = await docker([
        "exec",
        container,
        "/usr/local/bin/opengeni-run",
        "capabilities",
      ]);
      expect(capabilityReply.exitCode).toBe(0);
      const capabilities = JournalCapabilities.parse(
        JSON.parse(Buffer.from(capabilityReply.stdout).toString()),
      );
      const f = fixture();
      const dropped = new Set(["start", "input"]);
      let starts = 0;
      let writes = 0;
      const transport: MachineExecTransport = {
        exec: async (call) => {
          expect(call.instanceId).toBe(container);
          const action = call.argv.includes("start")
            ? "start"
            : call.argv.includes("input")
              ? "input"
              : "read";
          if (action === "start") starts++;
          if (action === "input") writes++;
          const response = await docker(["exec", "-i", container, ...call.argv], call.stdin);
          if (dropped.delete(action))
            throw new Error("synthetic transport loss after native execution");
          return response;
        },
      };
      const options = {
        transport,
        instance: { id: container, bootId: capabilities.bootId, diskLineage: randomUUID() },
        workspaceRoot: "/tmp/session-workspace",
        capabilities,
      };
      const original = f.session(options);
      const first = await original.exec({
        cmd: "read -r a; printf '%s😀' \"$a\"; read -r b; printf '%s' \"$b\"; exit 7",
        yieldTimeMs: 0,
      });
      expect(first.sessionId).toBe(1);
      const next = await original.writeStdin({ sessionId: 1, chars: "first\n", yieldTimeMs: 100 });
      expect(parseExecResponseBanner(next)).toEqual({ kind: "running", sessionId: 1 });
      const replacement = f.session(options);
      const done = await replacement.writeStdin({
        sessionId: 1,
        chars: "second\n",
        yieldTimeMs: 1000,
      });
      expect(parseExecResponseBanner(done)).toEqual({ kind: "exited", exitCode: 7 });
      expect(f.captures.join("")).toBe("first😀second");
      expect(starts).toBe(2);
      expect(writes).toBe(3);
      const authorityBefore = starts + writes;
      f.revoke();
      await expect(replacement.writeStdin({ sessionId: 1, chars: "revoked\n" })).rejects.toThrow(
        "revoked",
      );
      expect(starts + writes).toBe(authorityBefore);
    } finally {
      expect((await docker(["rm", "--force", container])).exitCode).toBe(0);
    }
  },
  60_000,
);
