/**
 * This fabric through its host agent's own client protocol: one JSON line
 * per request on the agent's socket, one JSON line back; a `connect` turns
 * the connection into a byte stream to a guest port. Commands run through
 * the lab image's exec service, framed as `compute-host bench` frames them.
 */
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { CreateKind, RunResult, Sandbox, System } from "./system.ts";

export type Address = { path: string } | { host: string; port: number };

/** `unix:/run/compute-host.sock`, a bare path, or `tcp:HOST:PORT`. */
export function parseAddress(text: string): Address {
  if (text.startsWith("tcp:")) {
    const rest = text.slice(4);
    const colon = rest.lastIndexOf(":");
    const port = Number(rest.slice(colon + 1));
    if (colon <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`bad tcp address: ${text}`);
    }
    return { host: rest.slice(0, colon), port };
  }
  return { path: text.startsWith("unix:") ? text.slice(5) : text };
}

/** A failure the host agent reported, with its error code. */
export class HostError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(`${code}: ${message}`);
  }
}

interface Reply {
  result: string;
  [field: string]: unknown;
}

function check(reply: Reply, expected: string): Reply {
  if (reply.result === expected) return reply;
  if (reply.result === "error")
    throw new HostError(String(reply.message), String(reply.code ?? "internal"));
  throw new Error(`expected ${expected}, got ${JSON.stringify(reply)}`);
}

/**
 * Sends one request and reads the reply line. Returns the socket with any
 * bytes that followed the reply, for a `connect` stream.
 */
export function open(
  address: Address,
  request: object,
  timeoutMs = 120_000,
): Promise<{ reply: Reply; socket: Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = connect(address);
    if ("host" in address) socket.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error(`no reply within ${timeoutMs} ms`)), timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(10);
      if (newline < 0) return;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", onClose);
      socket.pause();
      try {
        resolve({
          reply: JSON.parse(buffered.subarray(0, newline).toString()),
          socket,
          rest: buffered.subarray(newline + 1),
        });
      } catch (error) {
        fail(error as Error);
      }
    };
    const onClose = () => fail(new Error("the host agent closed the connection without replying"));
    socket.on("data", onData);
    socket.on("error", fail);
    socket.on("close", onClose);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

export async function call(address: Address, request: object, timeoutMs?: number): Promise<Reply> {
  const { reply, socket } = await open(address, request, timeoutMs);
  socket.destroy();
  return reply;
}

const RECORD_START = Buffer.from("\x1ecompute-bench-done ");
const RECORD_END = 0x1e;

/**
 * What the guest shell receives for `script`: the script in a bash of its
 * own without stdin, then a completion record with its exit status.
 */
export function framed(script: string): string {
  const quoted = script.replaceAll("'", `'\\''`);
  return `bash -c '${quoted}' </dev/null\nprintf '\\036compute-bench-done %d\\036' "$?"\nexit\n`;
}

/** How far a framed script's output has been read. */
export type Scan = { done: false; output: number } | { done: true; output: number; status: number };

/**
 * Finds the completion record. While running, `output` counts the bytes
 * known to be output: a tail that could still begin the record is held back.
 */
export function scan(buffer: Buffer): Scan {
  const start = buffer.indexOf(RECORD_START);
  if (start >= 0) {
    const end = buffer.indexOf(RECORD_END, start + RECORD_START.length);
    if (end < 0) return { done: false, output: start };
    const status = Number(buffer.subarray(start + RECORD_START.length, end).toString());
    if (!Number.isInteger(status)) throw new Error("malformed completion record");
    return { done: true, output: start, status };
  }
  for (let keep = Math.min(RECORD_START.length - 1, buffer.length); keep > 0; keep--) {
    if (buffer.subarray(buffer.length - keep).equals(RECORD_START.subarray(0, keep))) {
      return { done: false, output: buffer.length - keep };
    }
  }
  return { done: false, output: buffer.length };
}

/** Runs a framed script over a connected stream, timed from `started`. */
export function runOnStream(
  socket: Socket,
  rest: Buffer,
  script: string,
  started: number,
  timeoutMs: number,
): Promise<RunResult & { output: string }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let firstByteMs: number | undefined;
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`the script did not finish within ${timeoutMs} ms`)),
      timeoutMs,
    );
    const finish = (error?: Error, result?: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      // Let the guest close its side outside the timing; drop the
      // connection if it does not, so nothing keeps the sandbox awake.
      socket.resume();
      socket.end();
      const drop = setTimeout(() => socket.destroy(), 5000);
      socket.once("close", () => clearTimeout(drop));
      resolve(result as RunResult);
    };
    const onData = (chunk: Buffer) => {
      const now = performance.now();
      buffer = Buffer.concat([buffer, chunk]);
      let state: Scan;
      try {
        state = scan(buffer);
      } catch (error) {
        finish(error as Error);
        return;
      }
      if (firstByteMs === undefined && state.output > 0) firstByteMs = now - started;
      if (state.done) {
        const doneMs = now - started;
        finish(undefined, {
          firstByteMs: firstByteMs ?? doneMs,
          doneMs,
          output: buffer.subarray(0, state.output).toString(),
          status: state.status,
          phases: {},
        });
      }
    };
    socket.on("data", onData);
    socket.once("error", (error) => finish(error));
    socket.once("close", () =>
      finish(new Error("the guest closed the stream before the script ended")),
    );
    socket.write(framed(script));
    if (rest.length > 0) onData(rest);
    socket.resume();
  });
}

interface SandboxStatus {
  id: string;
  level: string;
  step: string | null;
  holds: number;
  broken: boolean;
  failed_step?: { step: string; error: string };
}

interface HostStatus {
  sandboxes: SandboxStatus[];
  [field: string]: unknown;
}

/**
 * One `status` poll shared by every waiter, so a thousand sandboxes going to
 * sleep cost one request per interval rather than one each.
 */
export class StatusPoller {
  private readonly waiters = new Set<{
    satisfied: (status: HostStatus) => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    deadline: number;
    what: string;
  }>();
  private running = false;

  constructor(
    private readonly address: Address,
    private readonly intervalMs = 25,
  ) {}

  wait(what: string, satisfied: (status: HostStatus) => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiters.add({
        satisfied,
        resolve,
        reject,
        deadline: performance.now() + timeoutMs,
        what,
      });
      if (!this.running) void this.loop();
    });
  }

  private async loop() {
    this.running = true;
    try {
      while (this.waiters.size > 0) {
        let status: HostStatus;
        try {
          const reply = check(await call(this.address, { op: "status" }), "status");
          status = reply as unknown as HostStatus;
        } catch (error) {
          for (const waiter of this.waiters) waiter.reject(error as Error);
          this.waiters.clear();
          return;
        }
        const now = performance.now();
        for (const waiter of [...this.waiters]) {
          let done = false;
          try {
            done = waiter.satisfied(status);
          } catch (error) {
            this.waiters.delete(waiter);
            waiter.reject(error as Error);
            continue;
          }
          if (done) {
            this.waiters.delete(waiter);
            waiter.resolve();
          } else if (now > waiter.deadline) {
            this.waiters.delete(waiter);
            waiter.reject(new Error(`timed out waiting for ${waiter.what}`));
          }
        }
        if (this.waiters.size > 0) await Bun.sleep(this.intervalMs);
      }
    } finally {
      this.running = false;
    }
  }
}

export interface OursOptions {
  address: string;
  vcpus?: number;
  memoryMib?: number;
  memoryRequestMib?: number;
  cpuRequestMillis?: number;
  port?: number;
  timeoutMs?: number;
}

export interface OursSandbox extends Sandbox {
  readonly id: string;
}

export class Ours implements System<OursSandbox> {
  readonly name = "ours-host-agent";
  readonly restLevels = ["running", "paused", "saved", "archived", "remote"] as const;
  private readonly address: Address;
  private readonly poller: StatusPoller;
  private readonly config: object;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(options: OursOptions) {
    this.address = parseAddress(options.address);
    this.poller = new StatusPoller(this.address);
    this.port = options.port ?? 52;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.config = {
      vcpus: options.vcpus ?? 2,
      memory_mib: options.memoryMib ?? 1024,
      memory_request_mib: options.memoryRequestMib ?? 512,
      cpu_request_millis: options.cpuRequestMillis ?? 250,
      // No sleep rules: the benchmark decides when each sandbox rests.
      sleep: {},
    };
  }

  /** The kind of create depends on how the agent was started, not on the request. */
  async create(_kind: CreateKind, script: string, started: number) {
    const id = randomBytes(16).toString("hex");
    check(await call(this.address, { op: "create", id, config: this.config }), "done");
    const createdMs = performance.now() - started;
    try {
      const run = await this.run({ id }, script, started);
      run.phases.create_ms = createdMs;
      return { sandbox: { id }, run };
    } catch (error) {
      // The caller never learns the id, so it cannot remove the sandbox.
      await this.remove({ id }).catch(() => undefined);
      throw error;
    }
  }

  async run(sandbox: OursSandbox, script: string, started: number): Promise<RunResult> {
    const sentMs = performance.now() - started;
    const { reply, socket, rest } = await open(
      this.address,
      { op: "connect", id: sandbox.id, port: this.port, priority: "interactive" },
      this.timeoutMs,
    );
    try {
      check(reply, "connected");
    } catch (error) {
      socket.destroy();
      throw error;
    }
    const connectedMs = performance.now() - started;
    const run = await runOnStream(socket, rest, script, started, this.timeoutMs);
    run.phases = {
      ...run.phases,
      sent_ms: sentMs,
      connected_ms: connectedMs,
      host_wake_ms: Number(reply.waited_us) / 1000,
      host_connect_ms: Number(reply.connect_us) / 1000,
    };
    return run;
  }

  async rest(sandbox: OursSandbox, level: string): Promise<void> {
    // The last command's stream holds the sandbox awake until the guest
    // closes it; a sleep asked for before that would be cancelled.
    await this.poller.wait(
      `${sandbox.id} released`,
      (status) => this.find(status, sandbox.id).holds === 0,
      this.timeoutMs,
    );
    if (level === "running") return;
    check(await call(this.address, { op: "sleep", id: sandbox.id, level }), "done");
    await this.poller.wait(
      `${sandbox.id} at ${level}`,
      (status) => {
        const found = this.find(status, sandbox.id);
        if (found.broken) throw new Error(`${sandbox.id} is broken`);
        if (found.failed_step)
          throw new Error(
            `${sandbox.id}: ${found.failed_step.step} failed: ${found.failed_step.error}`,
          );
        return found.level === level && !found.step;
      },
      this.timeoutMs,
    );
  }

  private find(status: HostStatus, id: string): SandboxStatus {
    const found = status.sandboxes.find((sandbox) => sandbox.id === id);
    if (!found) throw new Error(`the host does not know ${id}`);
    return found;
  }

  async remove(sandbox: OursSandbox): Promise<void> {
    check(await call(this.address, { op: "remove", id: sandbox.id }), "done");
  }

  async list(): Promise<string[]> {
    const status = check(
      await call(this.address, { op: "status" }),
      "status",
    ) as unknown as HostStatus;
    return status.sandboxes.map((sandbox) => sandbox.id);
  }

  async describe(): Promise<Record<string, unknown>> {
    const status = check(
      await call(this.address, { op: "status" }),
      "status",
    ) as unknown as HostStatus;
    const { sandboxes, steps: _steps, ...rest } = status;
    return { system: this.name, config: this.config, sandboxes: sandboxes.length, ...rest };
  }

  async close(): Promise<void> {}
}
