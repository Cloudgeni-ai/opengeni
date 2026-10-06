import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  JournalBindingError,
  JournalUnavailableError,
  MachineJournalClient,
  type JournalAuthority,
  type MachineExecTransport,
} from "../src/sandbox/v2/journal-client";
import {
  JournalCapabilities,
  JournalCommand,
  JournalInputAction,
  JournalObservation,
  JournalStartRequest,
  journalSpecificationDigest,
} from "../src/sandbox/v2/journal-protocol";

const machineId = randomUUID();
const instance = { id: "synthetic-instance", bootId: "a".repeat(64), diskLineage: randomUUID() };
const request = (): JournalStartRequest => ({
  operationId: randomUUID(),
  bootId: instance.bootId,
  diskLineage: instance.diskLineage,
  program: "/bin/sh",
  args: ["-c", "printf synthetic"],
  cwd: "/tmp",
  environment: { PATH: "/usr/bin:/bin" },
  stdin: false,
  pty: null,
});
function descriptor(spec: JournalStartRequest) {
  return JournalCommand.parse({
    kind: "machine-journal-v1",
    machineId,
    operationId: spec.operationId,
    bootId: spec.bootId,
    diskLineage: spec.diskLineage,
    specificationDigest: journalSpecificationDigest(spec),
    stdin: spec.stdin,
    pty: spec.pty !== null,
  });
}
function observation(spec: JournalStartRequest, state: "running" | "unknown" = "running") {
  return {
    operationId: spec.operationId,
    state,
    specificationDigest: journalSpecificationDigest(spec),
    receipt: null,
    stdout: { offset: 0, nextOffset: 0, data: "", eof: false },
    stderr: { offset: 0, nextOffset: 0, data: "", eof: false },
  };
}
const reply = (value: unknown) => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify(value)) });
const authority = (): JournalAuthority => ({
  reserve: async (command) => command,
  assert: async () => {},
});

describe("sandbox v2 journal transport authority", () => {
  test("retain before dispatch; a lost reply repeats the same immutable body", async () => {
    const spec = request();
    const events: string[] = [];
    const bodies: string[] = [];
    const client = new MachineJournalClient(
      { machineId, instance },
      {
        exec: async (call) => {
          events.push("dispatch");
          bodies.push(Buffer.from(call.stdin!).toString());
          if (bodies.length === 1) throw new Error("synthetic lost reply");
          return reply(observation(spec));
        },
      },
      {
        reserve: async (command) => {
          events.push("retained");
          return command;
        },
        assert: async () => {
          events.push("authorized");
        },
      },
    );
    const result = await client.start(spec);
    expect(events).toEqual(["retained", "authorized", "dispatch", "authorized", "dispatch"]);
    expect(bodies[0]).toBe(bodies[1]);
    expect(result.command.specificationDigest).toBe(journalSpecificationDigest(spec));
  });
  test("revocation between replies prevents another dispatch", async () => {
    const spec = request();
    let calls = 0;
    let checks = 0;
    const client = new MachineJournalClient(
      { machineId, instance },
      {
        exec: async () => {
          calls++;
          throw new Error("synthetic lost reply");
        },
      },
      {
        reserve: async (command) => command,
        assert: async () => {
          if (++checks === 2) throw new Error("revoked");
        },
      },
    );
    await expect(client.start(spec)).rejects.toThrow("revoked");
    expect(calls).toBe(1);
  });
  test("replacement boot and reused specification never reach the provider", async () => {
    const spec = request();
    let calls = 0;
    const transport = {
      exec: async () => {
        calls++;
        return reply(observation(spec));
      },
    };
    const client = new MachineJournalClient({ machineId, instance }, transport, authority());
    await expect(client.start({ ...spec, bootId: "b".repeat(64) })).rejects.toBeInstanceOf(
      JournalBindingError,
    );
    const conflicting = new MachineJournalClient({ machineId, instance }, transport, {
      reserve: async (command) => ({ ...command, specificationDigest: "c".repeat(64) }),
      assert: async () => {},
    });
    await expect(conflicting.start(spec)).rejects.toBeInstanceOf(JournalBindingError);
    expect(calls).toBe(0);
  });
  test("caller mutation while admission waits cannot replace argv or credentials", async () => {
    const spec = request();
    const original = structuredClone(spec);
    let body = "";
    const client = new MachineJournalClient(
      { machineId, instance },
      {
        exec: async (call) => {
          body = Buffer.from(call.stdin!).toString();
          return reply(observation(original));
        },
      },
      {
        reserve: async (command) => {
          spec.args = ["-c", "printf changed"];
          spec.environment.PATH = "/different";
          return command;
        },
        assert: async () => {},
      },
    );
    await client.start(spec);
    expect(JSON.parse(body)).toEqual(original);
  });
  test("invalid replies remain unavailable without inventing rejection or exit", async () => {
    const spec = request();
    let calls = 0;
    const client = new MachineJournalClient(
      { machineId, instance },
      {
        exec: async () => {
          calls++;
          return reply({ ...observation(spec), state: "exited" });
        },
      },
      authority(),
    );
    await expect(client.start(spec)).rejects.toBeInstanceOf(JournalUnavailableError);
    expect(calls).toBe(2);
  });
  test("reserved JS environment names remain exact data keys", () => {
    const spec = {
      ...request(),
      environment: JSON.parse(
        '{"__proto__":"synthetic-proto","constructor":"synthetic-constructor","prototype":"synthetic-prototype"}',
      ),
    };
    const parsed = JournalStartRequest.parse(spec);
    expect(Object.hasOwn(parsed.environment, "__proto__")).toBe(true);
    expect(JSON.stringify(parsed.environment)).toBe(JSON.stringify(spec.environment));
    expect(journalSpecificationDigest(spec)).not.toBe(
      journalSpecificationDigest({
        ...spec,
        environment: { constructor: "synthetic-constructor", prototype: "synthetic-prototype" },
      }),
    );
    expect(
      JournalStartRequest.safeParse({ ...spec, environment: { "bad=name": "value" } }).success,
    ).toBe(false);
    expect(
      JournalStartRequest.safeParse({
        ...spec,
        environment: {
          get PATH() {
            return "value";
          },
        },
      }).success,
    ).toBe(false);
  });
  test("terminal proof binds the specification and exact input mode", async () => {
    const spec = request();
    const final = {
      ...observation(spec),
      state: "exited",
      receipt: {
        protocol: "native-subreaper-v1",
        invocationId: spec.operationId,
        receiptId: randomUUID(),
        leaderExitCode: 0,
      },
    };
    for (const state of ["prepared", "running", "exited", "lost"])
      expect(
        JournalObservation.safeParse({
          ...final,
          state,
          specificationDigest: null,
          receipt: state === "exited" ? final.receipt : null,
        }).success,
      ).toBe(false);
    const client = new MachineJournalClient(
      { machineId, instance },
      {
        exec: async () =>
          reply({ ...final, receipt: { ...final.receipt, acceptedInputSequence: 1 } }),
      },
      authority(),
    );
    await expect(client.start(spec)).rejects.toBeInstanceOf(JournalBindingError);
    const inputSpec = { ...spec, stdin: true };
    const missing = new MachineJournalClient(
      { machineId, instance },
      {
        exec: async () =>
          reply({ ...final, specificationDigest: journalSpecificationDigest(inputSpec) }),
      },
      authority(),
    );
    await expect(missing.start(inputSpec)).rejects.toBeInstanceOf(JournalBindingError);
    const partial = new MachineJournalClient(
      { machineId, instance },
      {
        exec: async () =>
          reply({
            ...final,
            specificationDigest: journalSpecificationDigest(inputSpec),
            receipt: { ...final.receipt, acceptedInputSequence: 1, incompleteInputSequence: 2 },
          }),
      },
      authority(),
    );
    await expect(partial.start(inputSpec)).rejects.toBeInstanceOf(JournalBindingError);
  });
  test("byte offsets, operation identity and input modes are checked", async () => {
    const spec = request();
    const client = new MachineJournalClient(
      { machineId, instance },
      {
        exec: async () => reply(observation(spec)),
      },
      authority(),
    );
    await expect(client.read(descriptor(spec), { stdout: 1, stderr: 0 })).rejects.toBeInstanceOf(
      JournalBindingError,
    );
    await expect(client.input(descriptor(spec), 1, { kind: "close" })).rejects.toBeInstanceOf(
      JournalBindingError,
    );
    expect(JournalInputAction.safeParse({ kind: "data", base64: "YQ==\n" }).success).toBe(false);
    expect(
      JournalInputAction.safeParse({ kind: "data", base64: Buffer.alloc(4097).toString("base64") })
        .success,
    ).toBe(false);
    expect(
      JournalObservation.safeParse({
        ...observation(spec),
        stdout: { offset: 0, nextOffset: 3, data: "YQ==", eof: false },
      }).success,
    ).toBe(false);
    const oversized = new MachineJournalClient(
      { machineId, instance },
      {
        exec: async () =>
          reply({
            ...observation(spec),
            stdout: { offset: 0, nextOffset: 2, data: "YWI=", eof: false },
          }),
      },
      authority(),
    );
    await expect(
      oversized.read(descriptor(spec), { stdout: 0, stderr: 0, bytes: 1 }),
    ).rejects.toBeInstanceOf(JournalBindingError);
  });
  test("pre-launch cancellation is final only in the original incarnation", async () => {
    const spec = request();
    const cancelled = {
      ...observation(spec),
      state: "cancelled",
      specificationDigest: null,
      stdout: { offset: 0, nextOffset: 0, data: "", eof: true },
      stderr: { offset: 0, nextOffset: 0, data: "", eof: true },
    };
    const transport = { exec: async () => reply(cancelled) };
    const client = new MachineJournalClient({ machineId, instance }, transport, authority());
    expect((await client.cancel(descriptor(spec))).state).toBe("cancelled");
    const replacement = new MachineJournalClient(
      { machineId, instance: { ...instance, bootId: "b".repeat(64), diskLineage: randomUUID() } },
      transport,
      authority(),
    );
    const result = await replacement.cancel(descriptor(spec));
    expect(result.state).toBe("unknown");
    expect(result.stdout.eof || result.stderr.eof).toBe(false);
  });
});

// Optional real Linux path. The image is built by the journal's documented
// Docker suite; no provider account, network or secrets are needed.
const image = process.env["JOURNAL_CONFORMANCE_IMAGE"];
const linux = image ? test : test.skip;
async function docker(
  args: string[],
  input?: Uint8Array,
): Promise<{ exitCode: number; stdout: Uint8Array }> {
  const child = Bun.spawn(["docker", ...args], {
    stdin: input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
  try {
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
      child.exited,
    ]);
    return { stdout: new Uint8Array(stdout), exitCode };
  } finally {
    clearTimeout(timeout);
  }
}
async function withLinux(
  fn: (fixture: {
    transport: MachineExecTransport;
    current: typeof instance;
    retained: Map<string, JournalCommand>;
    dropped: Set<string>;
    container: string;
  }) => Promise<void>,
) {
  const created = await docker([
    "create",
    "--network",
    "none",
    "--memory",
    "256m",
    "--cpus",
    "0.5",
    "--label",
    "opengeni.test=journal-client-v1",
    image!,
    "/bin/sleep",
    "120",
  ]);
  expect(created.exitCode).toBe(0);
  const container = Buffer.from(created.stdout).toString().trim();
  expect(container).toMatch(/^[a-f0-9]{64}$/u);
  try {
    expect((await docker(["start", container])).exitCode).toBe(0);
    const retained = new Map<string, JournalCommand>();
    const dropped = new Set<string>();
    const transport: MachineExecTransport = {
      exec: async (call) => {
        expect(call.instanceId).toBe(container);
        const result = await docker(["exec", "-i", container, ...call.argv], call.stdin);
        const action = call.argv.at(-1)!;
        if (dropped.delete(action)) throw new Error("synthetic lost reply after native execution");
        return result;
      },
    };
    const capabilityResult = await transport.exec({
      instanceId: container,
      argv: ["/usr/local/bin/opengeni-run", "capabilities"],
    });
    expect(capabilityResult.exitCode).toBe(0);
    const capabilities = JournalCapabilities.parse(
      JSON.parse(Buffer.from(capabilityResult.stdout).toString()),
    );
    expect(capabilities.stdin && capabilities.pty).toBe(true);
    await fn({
      transport,
      current: { id: container, bootId: capabilities.bootId, diskLineage: randomUUID() },
      retained,
      dropped,
      container,
    });
  } finally {
    expect((await docker(["rm", "--force", container])).exitCode).toBe(0);
  }
}
function retainedAuthority(retained: Map<string, JournalCommand>): JournalAuthority {
  return {
    reserve: async (command) => {
      const original = retained.get(command.operationId);
      if (original) return original;
      retained.set(command.operationId, structuredClone(command));
      return command;
    },
    assert: async (command) => {
      expect(retained.get(command.operationId)).toEqual(command);
    },
  };
}
async function terminal(client: MachineJournalClient, command: JournalCommand) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await client.read(command, { stdout: 0, stderr: 0 });
    if (result.state === "exited") return result;
    await Bun.sleep(20);
  }
  throw new Error("Missing exact native terminal receipt");
}
linux(
  "real Linux: lost Start reply, native digest and byte replay",
  async () => {
    await withLinux(async ({ transport, current, retained, dropped, container }) => {
      const client = new MachineJournalClient(
        { machineId, instance: current },
        transport,
        retainedAuthority(retained),
      );
      const spec = {
        ...request(),
        bootId: current.bootId,
        diskLineage: current.diskLineage,
        args: [
          "-c",
          "printf x >> /tmp/client-effect; printf 'first😀'; printf second >/dev/stdout; exit 7",
        ],
        environment: {
          PATH: "/usr/bin:/bin",
          "11": "eleven",
          "2": "two",
          "\ue000": "bmp",
          𐀀: "astral",
        },
      };
      dropped.add("start");
      const started = await client.start(spec);
      const final = await terminal(client, started.command);
      expect(final.receipt?.leaderExitCode).toBe(7);
      expect(Buffer.from(final.stdout.data, "base64").toString()).toBe("first😀second");
      const tail = await client.read(started.command, { stdout: 9, stderr: 0 });
      expect(Buffer.from(tail.stdout.data, "base64").toString()).toBe("second");
      const effect = await docker(["exec", container, "cat", "/tmp/client-effect"]);
      expect(Buffer.from(effect.stdout).toString()).toBe("x");
      await expect(
        client.start({ ...spec, environment: { PATH: "/changed" } }),
      ).rejects.toBeInstanceOf(JournalBindingError);
      const cancelledSpec = {
        ...spec,
        operationId: randomUUID(),
        args: ["-c", "printf forbidden > /tmp/cancelled-effect"],
      };
      const cancelledCommand = {
        ...descriptor(cancelledSpec),
        bootId: current.bootId,
        diskLineage: current.diskLineage,
      };
      await retainedAuthority(retained).reserve(cancelledCommand);
      expect((await client.cancel(cancelledCommand)).state).toBe("cancelled");
      expect((await client.start(cancelledSpec)).observation.state).toBe("cancelled");
      expect(
        (await docker(["exec", container, "test", "-f", "/tmp/cancelled-effect"])).exitCode,
      ).toBe(1);
      const environmentSpec = {
        ...spec,
        operationId: randomUUID(),
        program: "/usr/bin/env",
        args: [],
        environment: Object.fromEntries([
          ["__proto__", "synthetic-proto"],
          ["constructor", "synthetic-constructor"],
          ["prototype", "synthetic-prototype"],
        ]),
      };
      const environmentCommand = await client.start(environmentSpec);
      const environmentResult = await terminal(client, environmentCommand.command);
      expect(environmentResult.specificationDigest).toBe(
        journalSpecificationDigest(environmentSpec),
      );
      expect(
        Buffer.from(environmentResult.stdout.data, "base64").toString().trim().split("\n").sort(),
      ).toEqual([
        "__proto__=synthetic-proto",
        "constructor=synthetic-constructor",
        "prototype=synthetic-prototype",
      ]);
    });
  },
  90_000,
);
linux(
  "real Linux: reboot and missing disk history cannot manufacture cancellation proof",
  async () => {
    await withLinux(async ({ transport, current, retained, container }) => {
      const client = new MachineJournalClient(
        { machineId, instance: current },
        transport,
        retainedAuthority(retained),
      );
      const spec = {
        ...request(),
        bootId: current.bootId,
        diskLineage: current.diskLineage,
        args: ["-c", "printf x >> /tmp/reboot-effect; sleep 60"],
      };
      const started = await client.start(spec);
      for (let i = 0; i < 50; i++) {
        const page = await client.read(started.command, { stdout: 0, stderr: 0 });
        if (page.state === "running") break;
        await Bun.sleep(20);
      }
      expect((await docker(["restart", container])).exitCode).toBe(0);
      const capabilities = await transport.exec({
        instanceId: container,
        argv: ["/usr/local/bin/opengeni-run", "capabilities"],
      });
      expect(capabilities.exitCode).toBe(0);
      const actual = JournalCapabilities.parse(
        JSON.parse(Buffer.from(capabilities.stdout).toString()),
      );
      expect(actual.bootId).not.toBe(current.bootId);
      expect((await client.read(started.command, { stdout: 0, stderr: 0 })).state).toBe("lost");
      // Erase only this generated operation to simulate a missing claim after
      // disk-history rollback. The old retained locator still grants no relaunch.
      expect(
        (
          await docker([
            "exec",
            container,
            "rm",
            "-rf",
            "--",
            `/var/lib/opengeni-run/${started.command.operationId}`,
          ])
        ).exitCode,
      ).toBe(0);
      await expect(client.cancel(started.command)).rejects.toBeInstanceOf(JournalUnavailableError);
      const missing = await client.read(started.command, { stdout: 0, stderr: 0 });
      expect(missing.state).toBe("unknown");
      expect(missing.receipt).toBeNull();
      expect(missing.stdout.eof || missing.stderr.eof).toBe(false);
      expect(
        (
          await docker([
            "exec",
            container,
            "test",
            "-d",
            `/var/lib/opengeni-run/${started.command.operationId}`,
          ])
        ).exitCode,
      ).toBe(1);
      expect(retained.size).toBe(1);
    });
  },
  90_000,
);
linux(
  "real Linux: dropped input acknowledgement and binary pipe EOF",
  async () => {
    await withLinux(async ({ transport, current, retained, dropped, container }) => {
      const client = new MachineJournalClient(
        { machineId, instance: current },
        transport,
        retainedAuthority(retained),
      );
      const spec = {
        ...request(),
        bootId: current.bootId,
        diskLineage: current.diskLineage,
        stdin: true,
        args: ["-c", "cat > /tmp/client-input; cat /tmp/client-input"],
      };
      const started = await client.start(spec);
      const bytes = Buffer.from([0, 255, 240, 159, 152, 128]);
      dropped.add("input");
      expect(
        (await client.input(started.command, 1, { kind: "data", base64: bytes.toString("base64") }))
          .status,
      ).toBe("accepted");
      expect((await client.input(started.command, 2, { kind: "close" })).status).toBe("accepted");
      const final = await terminal(client, started.command);
      expect(final.receipt?.acceptedInputSequence).toBe(2);
      expect(Buffer.from(final.stdout.data, "base64")).toEqual(bytes);
      expect(
        (await client.input(started.command, 1, { kind: "data", base64: bytes.toString("base64") }))
          .status,
      ).toBe("accepted");
      const effect = await docker(["exec", container, "cat", "/tmp/client-input"]);
      expect(Buffer.from(effect.stdout)).toEqual(bytes);
    });
  },
  90_000,
);
