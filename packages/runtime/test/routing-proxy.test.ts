// M7 — the RoutingSandboxSession proxy (the hot-swap dispatch core).
//
// The load-bearing SDK finding: the SDK binds to ONE session
// object and calls its methods per tool call WITHOUT re-resolving. So the proxy
// must be ONE stable object that re-reads the active pointer per op and
// dispatches to the currently-active backend. These tests drive that contract
// with in-memory fake backends + a mutable pointer, plus the real selfhosted
// MockAgentResponder for the heterogeneous Modal<->selfhosted path.
//
// Proves:
//   (1) active-epoch fence: a swap mid-turn (bump active_epoch + repoint) makes
//       the NEXT op route to the new backend (per-call re-read + per-epoch cache).
//   (2) stale-epoch in-flight op: a backend that fences a stale epoch → the proxy
//       re-resolves and RETRIES against the new active sandbox (no lost op).
//   (3) heterogeneous swap (>=2 flips): Modal->selfhosted->modal->selfhosted, ops
//       land on the new active box each time.
//   (4) single-active invariant: exactly one backend is ever resolved per op;
//       never two active concurrently.

import { describe, expect, test } from "bun:test";
import {
  RoutingBackendRecoveryRequiredError,
  RoutingMutationOutcomeUnknownError,
  RoutingSandboxSession,
  RoutingUnsupportedError,
  makeActiveBackendResolver,
  ActiveBackendUnresolvableError,
  swapTargetEstablishability,
  MockAgentResponder,
  type ActivePointer,
  type RoutableBackendSession,
  type ResolvedActiveBackend,
  type RoutableSandbox,
} from "../src/sandbox";
// The REAL computer-use discriminator — the proxy's native-surface presence must
// satisfy (and, for Modal, fail) this exact duck-type, not a local reimplementation.
import { isNativeDesktopSession } from "../src/sandbox-computer";

const WS = "11111111-1111-1111-1111-111111111111";
const RELAY = { host: "relay.test", port: 443, tls: true } as const;

/** A trivial in-memory backend whose exec echoes its `tag` so a test can assert
 *  which backend an op landed on. Optionally fences a configured epoch. */
class FakeBackend implements RoutableBackendSession {
  readonly tag: string;
  readonly calls: string[] = [];
  // When set, exec throws a fence error UNTIL the pointer's epoch moves past it.
  fenceUntilEpoch: number | null = null;
  private epochProvider: () => number;
  readonly state: { instanceId: string };

  constructor(tag: string, epochProvider: () => number = () => 0) {
    this.tag = tag;
    this.epochProvider = epochProvider;
    this.state = { instanceId: `box-${tag}` };
  }

  async exec(args: unknown): Promise<{ stdout: string; exitCode: number }> {
    if (this.fenceUntilEpoch !== null && this.epochProvider() <= this.fenceUntilEpoch) {
      const err = new Error("sandbox lease superseded; op fenced by a stale epoch") as Error & {
        fenced: boolean;
      };
      err.fenced = true;
      throw err;
    }
    this.calls.push(String((args as { cmd?: string }).cmd ?? ""));
    return { stdout: this.tag, exitCode: 0 };
  }

  async readFile(): Promise<Uint8Array> {
    if (this.fenceUntilEpoch !== null && this.epochProvider() <= this.fenceUntilEpoch) {
      const err = new Error("sandbox lease superseded; read fenced by a stale epoch") as Error & {
        fenced: boolean;
      };
      err.fenced = true;
      throw err;
    }
    return new TextEncoder().encode(this.tag);
  }
}

/** A backend that ALSO implements the native-desktop control-plane surface
 *  (`desktopInput`/`screenshot`) — the SelfhostedSession shape the computer-use
 *  capability duck-types as native. Records the events it received so a test can
 *  assert the proxy dispatched to it with the right args. */
class NativeFakeBackend extends FakeBackend {
  readonly desktopEvents: unknown[] = [];
  screenshots = 0;
  readonly frame = { png: new Uint8Array([137, 80, 78, 71]), width: 1440, height: 900 };

  async desktopInput(event: unknown): Promise<void> {
    this.desktopEvents.push(event);
  }

  async screenshot(): Promise<{ png: Uint8Array; width: number; height: number }> {
    this.screenshots += 1;
    return this.frame;
  }
}

/** A mutable active pointer + a swap helper (mirrors setActiveSandbox's
 *  epoch-bump). */
function mutablePointer(initial: ActivePointer = { activeSandboxId: null, activeEpoch: 0 }) {
  let pointer = { ...initial };
  return {
    read: async (): Promise<ActivePointer> => ({ ...pointer }),
    swap: (targetSandboxId: string | null): ActivePointer => {
      pointer = { activeSandboxId: targetSandboxId, activeEpoch: pointer.activeEpoch + 1 };
      return { ...pointer };
    },
    current: (): ActivePointer => ({ ...pointer }),
  };
}

describe("RoutingSandboxSession — per-call re-read + per-epoch dispatch", () => {
  test("observes each physical provider attempt without changing provider outcomes", async () => {
    const observations: Array<{
      backend: string;
      op: string;
      outcome: string;
      durationMs: number;
    }> = [];
    const success = new FakeBackend("success");
    const expected = new Error("provider rejected read");
    const failure: RoutableBackendSession = {
      async readFile() {
        throw expected;
      },
    };
    let selected: ResolvedActiveBackend = {
      session: success,
      sandboxId: null,
      kind: "modal",
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({
        activeSandboxId: selected.sandboxId,
        activeEpoch: 0,
      }),
      resolveActiveBackend: async () => selected,
      onOperation: (observation) => observations.push(observation),
    });

    await expect(proxy.exec({ cmd: "true" })).resolves.toEqual({ stdout: "success", exitCode: 0 });
    selected = { session: failure, sandboxId: "failed", kind: "docker" };
    // Force the per-epoch cache to resolve the selected failure backend.
    const failedProxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: "failed", activeEpoch: 1 }),
      resolveActiveBackend: async () => selected,
      onOperation: (observation) => observations.push(observation),
    });
    expect(await failedProxy.readFile({ path: "x" }).catch((error) => error)).toBe(expected);

    expect(observations.map(({ backend, op, outcome }) => ({ backend, op, outcome }))).toEqual([
      { backend: "modal", op: "exec", outcome: "ok" },
      { backend: "docker", op: "readFile", outcome: "failed" },
    ]);
    expect(observations.every(({ durationMs }) => durationMs >= 0)).toBe(true);
  });

  test("an observer failure cannot change a provider result", async () => {
    const backend = new FakeBackend("authoritative");
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
      onOperation: () => {
        throw new Error("metrics registry failed");
      },
    });

    await expect(proxy.exec({ cmd: "go" })).resolves.toEqual({
      stdout: "authoritative",
      exitCode: 0,
    });
  });

  test("a fenced read retry produces one observation per physical attempt", async () => {
    const pointer = mutablePointer({ activeSandboxId: "old", activeEpoch: 1 });
    const observations: Array<{ backend: string; outcome: string }> = [];
    const old: RoutableBackendSession = {
      async readFile() {
        pointer.swap("new");
        const error = Object.assign(new Error("stale route"), { fenced: true });
        throw error;
      },
    };
    const replacement: RoutableBackendSession = {
      async readFile() {
        return "new contents";
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: pointer.read,
      resolveActiveBackend: async (active) =>
        active.activeSandboxId === "old"
          ? { session: old, sandboxId: "old", kind: "modal" }
          : { session: replacement, sandboxId: "new", kind: "docker" },
      onOperation: ({ backend, outcome }) => observations.push({ backend, outcome }),
    });

    await expect(proxy.readFile({ path: "x" })).resolves.toBe("new contents");
    expect(observations).toEqual([
      { backend: "modal", outcome: "failed" },
      { backend: "docker", outcome: "ok" },
    ]);
  });

  test("materializeEntry verifies the destination from inside the provider", async () => {
    const calls: string[] = [];
    const backend: RoutableBackendSession = {
      async materializeEntry() {
        calls.push("materialize");
      },
      async execCommand(args) {
        calls.push("verify");
        return String((args as { cmd?: string }).cmd ?? "");
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({
        session: backend,
        sandboxId: null,
        kind: "docker",
        leaseEpoch: 1,
        providerInstanceId: "container-1",
      }),
    });

    await expect(
      proxy.materializeEntry({ path: ".agents/example", entry: {} }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["materialize", "verify"]);
  });

  test("materializeEntry fails when the provider cannot see the written path", async () => {
    const backend: RoutableBackendSession = {
      async materializeEntry() {},
      async execCommand() {
        return "";
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({
        session: backend,
        sandboxId: null,
        kind: "docker",
        leaseEpoch: 1,
        providerInstanceId: "container-1",
      }),
    });

    await expect(proxy.materializeEntry({ path: ".agents/example", entry: {} })).rejects.toThrow(
      "provider cannot read the destination path",
    );
  });

  test("mutation admission runs after exact route resolution and before the provider", async () => {
    const events: string[] = [];
    const backend: RoutableBackendSession = {
      async writeFile() {
        events.push("provider");
        return "written";
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 4 }),
      resolveActiveBackend: async () => {
        events.push("resolved");
        return {
          session: backend,
          sandboxId: null,
          kind: "modal",
          leaseEpoch: 12,
          providerInstanceId: "sb-current",
        };
      },
      beforeMutation: async ({ op, backend: resolved }) => {
        events.push("admitted");
        expect(op).toBe("writeFile");
        expect(resolved).toMatchObject({
          sandboxId: null,
          activeEpoch: 4,
          leaseEpoch: 12,
          providerInstanceId: "sb-current",
        });
        return 7;
      },
      afterMutation: async ({ admission, outcome }) => {
        events.push("settled");
        expect(admission).toBe(7);
        expect(outcome).toBe("resolved");
      },
    });

    expect(await proxy.writeFile({ path: "/workspace/a", content: "a" })).toBe("written");
    expect(events).toEqual(["resolved", "admitted", "provider", "settled"]);
  });

  test("a rejected provider promise physically settles before its original error propagates", async () => {
    const events: string[] = [];
    const rejected = new Error("provider rejected");
    const backend: RoutableBackendSession = {
      async writeFile() {
        events.push("provider");
        throw rejected;
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
      beforeMutation: async () => {
        events.push("admitted");
        return 11;
      },
      afterMutation: async ({ admission, outcome }) => {
        events.push(`settled:${outcome}`);
        expect(admission).toBe(11);
      },
    });

    expect(await proxy.writeFile({ path: "/workspace/a" }).catch((error) => error)).toBe(rejected);
    expect(events).toEqual(["admitted", "provider", "settled:rejected"]);
  });

  test("a rejected provider promise with failed physical settlement is non-replayable unknown", async () => {
    let providerCalls = 0;
    const backend: RoutableBackendSession = {
      async writeFile() {
        providerCalls += 1;
        throw new Error("provider rejected");
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
      beforeMutation: async () => 12,
      afterMutation: async ({ outcome }) => {
        expect(outcome).toBe("rejected");
        throw new Error("database unavailable");
      },
    });

    const error = await proxy.writeFile({ path: "/workspace/a" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
    expect((error as RoutingMutationOutcomeUnknownError).retryable).toBe(false);
    expect(providerCalls).toBe(1);
  });

  test("read-only operations never invoke mutation admission or settlement", async () => {
    let admissions = 0;
    let settlements = 0;
    const backend = new FakeBackend("read-only");
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
      beforeMutation: async () => {
        admissions += 1;
      },
      afterMutation: async () => {
        settlements += 1;
      },
    });

    expect(new TextDecoder().decode(await proxy.readFile({ path: "/workspace/a" }))).toBe(
      "read-only",
    );
    expect(admissions).toBe(0);
    expect(settlements).toBe(0);
  });

  test("yielded process mutation, polling, and helpers stay on the exact backend after pointer movement", async () => {
    const ptr = mutablePointer();
    let pointerReads = 0;
    const oldExecs: string[] = [];
    const oldWrites: Array<Record<string, unknown>> = [];
    const newCalls: string[] = [];
    const processEvents: string[] = [];
    const operationEvents: string[] = [];
    let retainedId: string | null = null;
    const oldBackend: RoutableBackendSession = {
      async execCommand(args) {
        const cmd = String((args as { cmd?: unknown }).cmd ?? "");
        oldExecs.push(cmd);
        return cmd === "start"
          ? "Process running with session ID 73\n\nOutput:\nstarted"
          : "Process exited with code 0\n\nOutput:\nhelper";
      },
      async writeStdin(args) {
        oldWrites.push(args as Record<string, unknown>);
        return "Process running with session ID 73\n\nOutput:\nstill-running";
      },
    };
    const newBackend: RoutableBackendSession = {
      async execCommand() {
        newCalls.push("exec");
        return "Process exited with code 0\n\nOutput:\nwrong-backend";
      },
      async writeStdin() {
        newCalls.push("stdin");
        return "Process exited with code 0\n\nOutput:\nwrong-backend";
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => {
        pointerReads += 1;
        return await ptr.read();
      },
      resolveActiveBackend: async (pointer) =>
        pointer.activeSandboxId === null
          ? { session: oldBackend, sandboxId: null, kind: "modal" }
          : { session: newBackend, sandboxId: pointer.activeSandboxId, kind: "selfhosted" },
      beforeMutation: async () => "parent-admission",
      afterMutation: async ({ retainedProcess }) => {
        expect(retainedProcess?.providerSessionId).toBe(73);
        retainedId ??= retainedProcess!.id;
        expect(retainedProcess!.id).toBe(retainedId);
        processEvents.push("parent-promoted");
      },
      beforeProcessMutation: async ({ process }) => {
        expect(process.id).toBe(retainedId);
        processEvents.push("stdin-admitted");
        return "stdin-admission";
      },
      afterProcessMutation: async ({ admission, outcome }) => {
        expect(admission).toBe("stdin-admission");
        expect(outcome).toBe("resolved");
        processEvents.push("stdin-settled");
      },
      onOperation: ({ op, outcome }) => operationEvents.push(`${op}:${outcome}`),
    });

    expect(await proxy.execCommand({ cmd: "start" })).toContain("session ID 73");
    expect(proxy.hasRetainedProcess(73)).toBe(true);
    ptr.swap("sbx-new");

    expect(await proxy.writeStdinForProcessMutation({ sessionId: 73, chars: "input" })).toContain(
      "still-running",
    );
    expect(await proxy.writeStdinForProcessControl({ sessionId: 73, chars: "" })).toContain(
      "still-running",
    );
    expect(await proxy.execCommandForProcessControl(73, { cmd: "helper" })).toContain("helper");

    expect(pointerReads).toBe(1);
    expect(oldExecs).toEqual(["start", "helper"]);
    expect(oldWrites).toHaveLength(2);
    expect(newCalls).toEqual([]);
    expect(processEvents).toEqual(["parent-promoted", "stdin-admitted", "stdin-settled"]);
    expect(operationEvents).toEqual([
      "execCommand:ok",
      "writeStdin:ok",
      "writeStdin:ok",
      "execCommand:ok",
    ]);
  });

  test("a process-scoped stdin terminal result settles its mutation and parent exactly once", async () => {
    const events: string[] = [];
    let writes = 0;
    const backend: RoutableBackendSession = {
      async execCommand() {
        return "Process running with session ID 74\n\nOutput:\nstarted";
      },
      async writeStdin() {
        writes += 1;
        return "Process exited with code 23\n\nOutput:\ndone";
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
      beforeMutation: async () => "parent",
      afterMutation: async () => {
        events.push("parent-promoted");
      },
      beforeProcessMutation: async () => {
        events.push("stdin-admitted");
        return "stdin";
      },
      afterProcessMutation: async ({ outcome }) => {
        events.push(`stdin-${outcome}`);
      },
      settleProcess: async ({ proof }) => {
        expect(proof).toEqual({
          outcome: "exited",
          exitCode: 23,
          reason: "provider_exit_banner",
        });
        events.push("parent-settled");
      },
    });

    await proxy.execCommand({ cmd: "start" });
    expect(await proxy.writeStdinForProcessMutation({ sessionId: 74, chars: "finish" })).toContain(
      "code 23",
    );
    expect(writes).toBe(1);
    expect(proxy.hasRetainedProcess(74)).toBe(false);
    expect(events).toEqual([
      "parent-promoted",
      "stdin-admitted",
      "stdin-resolved",
      "parent-settled",
    ]);
  });

  test("failed durable terminal settlement makes a model retry reuse stored proof without another provider call", async () => {
    let writes = 0;
    let settlementAttempts = 0;
    const backend: RoutableBackendSession = {
      async execCommand() {
        return "Process running with session ID 75\n\nOutput:\nstarted";
      },
      async writeStdin() {
        writes += 1;
        return "write_stdin failed: session not found: 75";
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
      beforeMutation: async () => "parent",
      afterMutation: async () => undefined,
      settleProcess: async ({ proof }) => {
        expect(proof).toEqual({
          outcome: "lost",
          exitCode: null,
          reason: "provider_session_lost_banner",
        });
        settlementAttempts += 1;
        if (settlementAttempts === 1) throw new Error("database unavailable");
      },
    });

    await proxy.execCommand({ cmd: "start" });
    await expect(
      proxy.writeStdinForProcessMutation({ sessionId: 75, chars: "finish" }),
    ).rejects.toBeInstanceOf(RoutingMutationOutcomeUnknownError);
    expect(proxy.hasRetainedProcess(75)).toBe(true);

    expect(await proxy.writeStdinForProcessMutation({ sessionId: 75, chars: "finish" })).toBe(
      "write_stdin failed: session not found: 75",
    );
    expect(writes).toBe(1);
    expect(settlementAttempts).toBe(2);
    expect(proxy.hasRetainedProcess(75)).toBe(false);
  });

  test("ambiguous process promotion retries the same UUID and exact route before control proceeds", async () => {
    const ptr = mutablePointer();
    let promotions = 0;
    let oldWrites = 0;
    let newWrites = 0;
    const retainedIds: string[] = [];
    const oldBackend: RoutableBackendSession = {
      async execCommand() {
        return "Process running with session ID 76\n\nOutput:\nstarted";
      },
      async writeStdin() {
        oldWrites += 1;
        return "Process running with session ID 76\n\nOutput:\nrunning";
      },
    };
    const newBackend: RoutableBackendSession = {
      async writeStdin() {
        newWrites += 1;
        return "Process running with session ID 76\n\nOutput:\nwrong";
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer) =>
        pointer.activeSandboxId === null
          ? { session: oldBackend, sandboxId: null, kind: "modal" }
          : { session: newBackend, sandboxId: pointer.activeSandboxId, kind: "selfhosted" },
      beforeMutation: async () => "parent",
      afterMutation: async ({ retainedProcess }) => {
        promotions += 1;
        retainedIds.push(retainedProcess!.id);
        if (promotions === 1) throw new Error("promotion outcome unknown");
      },
    });

    await expect(proxy.execCommand({ cmd: "start" })).rejects.toBeInstanceOf(
      RoutingMutationOutcomeUnknownError,
    );
    expect(proxy.hasRetainedProcess(76)).toBe(true);
    ptr.swap("sbx-new");

    expect(await proxy.writeStdinForProcessControl({ sessionId: 76, chars: "" })).toContain(
      "running",
    );
    expect(promotions).toBe(2);
    expect(new Set(retainedIds).size).toBe(1);
    expect(oldWrites).toBe(1);
    expect(newWrites).toBe(0);
  });

  test("durable stale-authority promotion rejects output but hands off the exact process without retry", async () => {
    let providerCalls = 0;
    let promotions = 0;
    let controlWrites = 0;
    const backend: RoutableBackendSession = {
      async execCommand() {
        providerCalls += 1;
        return "Process running with session ID 77\n\nOutput:\nstarted";
      },
      async writeStdin() {
        controlWrites += 1;
        return "Process exited with code 0\n\nOutput:\ndone";
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
      beforeMutation: async () => "parent",
      afterMutation: async ({ retainedProcess }) => {
        promotions += 1;
        return {
          status: "retained_process_durable_output_rejected",
          retainedProcess: retainedProcess!,
        };
      },
    });

    const error = await proxy.execCommand({ cmd: "start" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
    expect((error as RoutingMutationOutcomeUnknownError).retainedProcess).toEqual({
      id: expect.any(String),
      providerSessionId: 77,
    });
    expect((error as RoutingMutationOutcomeUnknownError).retryable).toBe(false);
    expect(proxy.hasRetainedProcess(77)).toBe(true);

    expect(await proxy.writeStdinForProcessControl({ sessionId: 77, chars: "" })).toContain(
      "Process exited with code 0",
    );
    expect(proxy.hasRetainedProcess(77)).toBe(false);
    expect(providerCalls).toBe(1);
    expect(promotions).toBe(1);
    expect(controlWrites).toBe(1);
  });

  test("an adopted durable process stays on the exact default backend without reading a moved pointer", async () => {
    let pointerReads = 0;
    let oldWrites = 0;
    let newWrites = 0;
    let settled = 0;
    const home: RoutableBackendSession = {
      async writeStdin() {
        oldWrites += 1;
        return "Process exited with code 17\n\nOutput:\ndone";
      },
    };
    const rival: RoutableBackendSession = {
      async writeStdin() {
        newWrites += 1;
        return "Process exited with code 0\n\nOutput:\nwrong";
      },
    };
    const proxy = new RoutingSandboxSession({
      defaultResolved: {
        session: home,
        sandboxId: null,
        kind: "modal",
        leaseEpoch: 9,
        providerInstanceId: "box-home",
      },
      readPointer: async () => {
        pointerReads += 1;
        return { activeSandboxId: "22222222-2222-4222-8222-222222222222", activeEpoch: 12 };
      },
      resolveActiveBackend: async () => ({
        session: rival,
        sandboxId: "22222222-2222-4222-8222-222222222222",
        kind: "selfhosted",
      }),
      settleProcess: async ({ proof }) => {
        expect(proof).toEqual({
          outcome: "exited",
          exitCode: 17,
          reason: "provider_exit_banner",
        });
        settled += 1;
      },
    });

    proxy.adoptRetainedProcess({
      process: {
        id: "33333333-3333-4333-8333-333333333333",
        providerSessionId: 88,
      },
      backend: {
        sandboxId: null,
        leaseEpoch: 9,
        providerInstanceId: "box-home",
        activeEpoch: 4,
      },
    });
    expect(proxy.retainedProcessIdentity(88)).toEqual({
      id: "33333333-3333-4333-8333-333333333333",
      providerSessionId: 88,
    });
    expect(await proxy.writeStdinForProcessControl({ sessionId: 88, chars: "" })).toContain(
      "code 17",
    );
    expect(pointerReads).toBe(0);
    expect(oldWrites).toBe(1);
    expect(newWrites).toBe(0);
    expect(settled).toBe(1);
    expect(proxy.hasRetainedProcess(88)).toBe(false);
  });

  test("retained-process adoption rejects stale provider identity and conflicting duplicates", () => {
    const home: RoutableBackendSession = {
      async writeStdin() {
        return "";
      },
    };
    const proxy = new RoutingSandboxSession({
      defaultResolved: {
        session: home,
        sandboxId: null,
        kind: "modal",
        leaseEpoch: 5,
        providerInstanceId: "box-current",
      },
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({ session: home, sandboxId: null, kind: "modal" }),
    });
    const process = {
      id: "44444444-4444-4444-8444-444444444444",
      providerSessionId: 91,
    };

    expect(() =>
      proxy.adoptRetainedProcess({
        process,
        backend: {
          sandboxId: null,
          leaseEpoch: 4,
          providerInstanceId: "box-old",
          activeEpoch: 3,
        },
      }),
    ).toThrow(RoutingMutationOutcomeUnknownError);

    proxy.adoptRetainedProcess({
      process,
      backend: {
        sandboxId: null,
        leaseEpoch: 5,
        providerInstanceId: "box-current",
        activeEpoch: 3,
      },
    });
    expect(() =>
      proxy.adoptRetainedProcess({
        process: { ...process, id: "55555555-5555-4555-8555-555555555555" },
        backend: {
          sandboxId: null,
          leaseEpoch: 5,
          providerInstanceId: "box-current",
          activeEpoch: 3,
        },
      }),
    ).toThrow(RoutingMutationOutcomeUnknownError);
  });

  test("the eager editor path cannot bypass route resolution or mutation admission", async () => {
    const events: string[] = [];
    const eagerEditor = {
      async createFile() {
        events.push("provider-editor");
        return { ok: true };
      },
    };
    const backend: RoutableBackendSession = {
      createEditor() {
        events.push("create-editor");
        return eagerEditor;
      },
    };
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: backend, sandboxId: null, kind: "modal" },
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 2 }),
      resolveActiveBackend: async () => {
        events.push("resolved");
        return { session: backend, sandboxId: null, kind: "modal" };
      },
      beforeMutation: async ({ op }) => {
        events.push(`admitted:${op}`);
      },
    });

    const editor = proxy.createEditor() as {
      createFile: (operation: unknown) => Promise<unknown>;
    };
    expect(editor).not.toBe(eagerEditor);
    await editor.createFile({ path: "/workspace/new.ts" });
    expect(events).toEqual([
      "resolved",
      "admitted:editor.createFile",
      "create-editor",
      "provider-editor",
    ]);
  });

  test("admission rejection reaches neither provider, provider-loss handling, nor route retry", async () => {
    const rejected = new Error("turn attempt fenced");
    let providerCalls = 0;
    let resolves = 0;
    let lossCallbacks = 0;
    const backend: RoutableBackendSession = {
      async writeFile() {
        providerCalls += 1;
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => {
        resolves += 1;
        return { session: backend, sandboxId: null, kind: "modal" };
      },
      beforeMutation: async () => {
        throw rejected;
      },
      onDefaultBackendError: async () => {
        lossCallbacks += 1;
        return null;
      },
    });

    expect(await proxy.writeFile({ path: "never" }).catch((error) => error)).toBe(rejected);
    expect(providerCalls).toBe(0);
    expect(resolves).toBe(1);
    expect(lossCallbacks).toBe(0);
  });

  test("provider disappearance fences an ambiguous mutation and never replays it", async () => {
    let writes = 0;
    let lossCallbacks = 0;
    const missing = Object.assign(new Error("provider sandbox missing"), { status: 404 });
    const backend: RoutableBackendSession = {
      async writeFile() {
        writes += 1;
        throw missing;
      },
    };
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: backend, sandboxId: null, kind: "modal" },
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
      onDefaultBackendError: async ({ error, op }) => {
        expect(error).toBe(missing);
        expect(op).toBe("writeFile");
        lossCallbacks += 1;
        return { leaseEpoch: 8, recovery: "pending" };
      },
    });

    const error = await proxy.writeFile({ path: "maybe-written" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RoutingBackendRecoveryRequiredError);
    expect((error as RoutingBackendRecoveryRequiredError).leaseEpoch).toBe(8);
    expect((error as RoutingBackendRecoveryRequiredError).retryable).toBe(true);
    expect(writes).toBe(1);
    expect(lossCallbacks).toBe(1);
  });

  test("(1) active-epoch fence: a swap mid-turn routes the NEXT op to the new backend", async () => {
    const modal = new FakeBackend("modal");
    const selfhosted = new FakeBackend("selfhosted");
    const ptr = mutablePointer();
    let resolves = 0;

    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer): Promise<ResolvedActiveBackend> => {
        resolves += 1;
        return pointer.activeSandboxId === null
          ? { session: modal, sandboxId: null, kind: "modal" }
          : { session: selfhosted, sandboxId: pointer.activeSandboxId, kind: "selfhosted" };
      },
    });

    // Op 1 lands on the default (modal) backend.
    const r1 = (await proxy.exec({ cmd: "a" })) as { stdout: string };
    expect(r1.stdout).toBe("modal");

    // A second op at the SAME epoch reuses the cached backend (no re-resolve).
    await proxy.exec({ cmd: "b" });
    expect(resolves).toBe(1);

    // SWAP mid-turn: bump active_epoch + repoint to the selfhosted sandbox.
    ptr.swap("sbx-self");

    // The NEXT op re-reads the pointer, sees the new epoch, re-resolves, and lands
    // on the selfhosted backend.
    const r2 = (await proxy.exec({ cmd: "c" })) as { stdout: string };
    expect(r2.stdout).toBe("selfhosted");
    expect(resolves).toBe(2);

    // The ops landed on the right boxes: modal saw a+b, selfhosted saw c.
    expect(modal.calls).toEqual(["a", "b"]);
    expect(selfhosted.calls).toEqual(["c"]);
  });

  test("(2) stale-epoch in-flight read: the backend fences a stale epoch -> the proxy retries against the new active sandbox", async () => {
    // The default (modal) box fences any op while the pointer is still at epoch 0
    // (simulating an in-flight op the active_epoch bumped under). After a swap to
    // selfhosted (epoch 1), the proxy must re-resolve and land the op on selfhosted.
    const ptr = mutablePointer();
    const modal = new FakeBackend("modal", () => ptr.current().activeEpoch);
    const selfhosted = new FakeBackend("selfhosted", () => ptr.current().activeEpoch);
    modal.fenceUntilEpoch = 0; // modal rejects while epoch <= 0

    let resolveCount = 0;
    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer): Promise<ResolvedActiveBackend> => {
        resolveCount += 1;
        // On the retry the test bumps the pointer (a concurrent swap) so the
        // re-resolve produces the new active backend.
        if (pointer.activeSandboxId === null) {
          return { session: modal, sandboxId: null, kind: "modal" };
        }
        return { session: selfhosted, sandboxId: pointer.activeSandboxId, kind: "selfhosted" };
      },
      onTransition: (e) => {
        // When the first attempt fences, simulate the concurrent swap that
        // re-points the session to selfhosted (epoch 1) BEFORE the retry resolves.
        if (e.type === "fenced-retry" && ptr.current().activeEpoch === 0) {
          ptr.swap("sbx-self");
        }
      },
    });

    const r = await proxy.readFile({ path: "in-flight" });
    // The read safely retried and landed on the NEW active (selfhosted).
    expect(new TextDecoder().decode(r)).toBe("selfhosted");
    // Re-resolved at least twice (initial + post-fence).
    expect(resolveCount).toBeGreaterThanOrEqual(2);
  });

  test("a provider fence after mutation admission never replays the ambiguous write", async () => {
    let calls = 0;
    let resolves = 0;
    const fenced = Object.assign(new Error("provider fenced stale epoch"), { fenced: true });
    const backend: RoutableBackendSession = {
      async writeFile() {
        calls += 1;
        throw fenced;
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => {
        resolves += 1;
        return { session: backend, sandboxId: null, kind: "modal" };
      },
      beforeMutation: async () => 1,
    });

    const error = await proxy.writeFile({ path: "ambiguous" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
    expect((error as RoutingMutationOutcomeUnknownError).retryable).toBe(false);
    expect(calls).toBe(1);
    expect(resolves).toBe(1);
  });

  test("a route change before mutation output settlement rejects the old output without replay", async () => {
    const ptr = mutablePointer();
    let oldCalls = 0;
    let newCalls = 0;
    const oldBackend: RoutableBackendSession = {
      async writeFile() {
        oldCalls += 1;
        ptr.swap("sbx-new");
        return "stale-output";
      },
    };
    const newBackend: RoutableBackendSession = {
      async writeFile() {
        newCalls += 1;
        return "new-output";
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer) =>
        pointer.activeSandboxId === null
          ? { session: oldBackend, sandboxId: null, kind: "modal" }
          : { session: newBackend, sandboxId: pointer.activeSandboxId, kind: "selfhosted" },
      beforeMutation: async () => 1,
    });

    const error = await proxy.writeFile({ path: "ambiguous" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
    expect(oldCalls).toBe(1);
    expect(newCalls).toBe(0);
  });

  test("(3) heterogeneous swap (>=2 flips): ops land on the new active box each flip", async () => {
    const modal = new FakeBackend("modal");
    const selfA = new FakeBackend("self-A");
    const selfB = new FakeBackend("self-B");
    const ptr = mutablePointer();

    const byId: Record<string, FakeBackend> = { "sbx-A": selfA, "sbx-B": selfB };
    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer): Promise<ResolvedActiveBackend> => {
        if (pointer.activeSandboxId === null) {
          return { session: modal, sandboxId: null, kind: "modal" };
        }
        return {
          session: byId[pointer.activeSandboxId]!,
          sandboxId: pointer.activeSandboxId,
          kind: "selfhosted",
        };
      },
    });

    // Flip 0: default modal.
    expect(((await proxy.exec({ cmd: "0" })) as { stdout: string }).stdout).toBe("modal");
    // Flip 1: -> self-A.
    ptr.swap("sbx-A");
    expect(((await proxy.exec({ cmd: "1" })) as { stdout: string }).stdout).toBe("self-A");
    // Flip 2: -> self-B.
    ptr.swap("sbx-B");
    expect(((await proxy.exec({ cmd: "2" })) as { stdout: string }).stdout).toBe("self-B");
    // Flip 3: back to modal (null).
    ptr.swap(null);
    expect(((await proxy.exec({ cmd: "3" })) as { stdout: string }).stdout).toBe("modal");
    // Flip 4: -> self-A again.
    ptr.swap("sbx-A");
    expect(((await proxy.exec({ cmd: "4" })) as { stdout: string }).stdout).toBe("self-A");

    expect(modal.calls).toEqual(["0", "3"]);
    expect(selfA.calls).toEqual(["1", "4"]);
    expect(selfB.calls).toEqual(["2"]);
  });

  test("(4) single-active invariant: exactly one backend resolves per op, never two", async () => {
    const modal = new FakeBackend("modal");
    const selfhosted = new FakeBackend("selfhosted");
    const ptr = mutablePointer();
    let concurrentResolves = 0;
    let maxConcurrent = 0;

    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer): Promise<ResolvedActiveBackend> => {
        concurrentResolves += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentResolves);
        await Promise.resolve();
        concurrentResolves -= 1;
        return pointer.activeSandboxId === null
          ? { session: modal, sandboxId: null, kind: "modal" }
          : { session: selfhosted, sandboxId: pointer.activeSandboxId, kind: "selfhosted" };
      },
    });

    await proxy.exec({ cmd: "x" });
    ptr.swap("sbx-self");
    await proxy.exec({ cmd: "y" });
    // Only ONE backend was ever resolved at a time (single active, not parallel).
    expect(maxConcurrent).toBe(1);
    // After the swap, the modal box is NOT touched again (single-active, the old
    // box is not concurrently driven).
    expect(modal.calls).toEqual(["x"]);
    expect(selfhosted.calls).toEqual(["y"]);
  });

  // REGRESSION (caught live on staging 2026-07-08): the lazy wiring returned the
  // proxy ITSELF as the resolved backend, so every op re-dispatched into resolve()
  // forever — a silent async infinite recursion that HUNG the turn (box created, exec
  // never returned). The guard must fail loud instead of looping.
  test("(5) re-entrancy guard: a resolver returning the proxy itself throws, never hangs", async () => {
    let proxy: RoutingSandboxSession;
    proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 1 }),
      resolveActiveBackend: async (): Promise<ResolvedActiveBackend> => ({
        session: proxy as unknown as RoutableBackendSession,
        sandboxId: null,
        kind: "unprovisioned",
      }),
    });
    await expect(proxy.exec({ cmd: "x" })).rejects.toThrow(/re-entrancy|proxy itself/i);
  });

  // REGRESSION (issue #341 §5.2 / invariant E): the per-op cache was keyed by
  // active_epoch ALONE, but a pointer can change its target id WITHOUT an epoch
  // bump — the `sessions.active_sandbox_id` FK is `ON DELETE SET NULL`, so a cascade
  // that deletes the pointed-at sandbox nulls the id at the SAME epoch. Keying on the
  // epoch alone kept serving the deleted backend for that epoch (a swap-free route to
  // the Shape-3 symptom: activeSandboxId:null in the list, ops still hitting the dead
  // box). The cache must key on the FULL tuple (activeEpoch, activeSandboxId) so a
  // same-epoch id change invalidates it and the next op re-resolves.
  test("(6) cache key (epoch, sandboxId): a same-epoch target-id change invalidates the cache and re-resolves the HOME", async () => {
    const group = new FakeBackend("group-modal");
    const sibling = new FakeBackend("stale-sibling");
    // A pointer whose id can change WITHOUT bumping the epoch (the FK SET NULL shape).
    let pointer: ActivePointer = { activeSandboxId: "sbx-sibling", activeEpoch: 4 };
    let resolves = 0;
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ ...pointer }),
      resolveActiveBackend: async (p): Promise<ResolvedActiveBackend> => {
        resolves += 1;
        return p.activeSandboxId === null
          ? { session: group, sandboxId: null, kind: "modal" }
          : { session: sibling, sandboxId: p.activeSandboxId, kind: "modal" };
      },
    });

    // Op 1 resolves the sibling target at epoch 4.
    expect(((await proxy.exec({ cmd: "a" })) as { stdout: string }).stdout).toBe("stale-sibling");
    expect(resolves).toBe(1);

    // The FK nulls the pointer id at the SAME epoch (no bump) — as an ON DELETE SET
    // NULL cascade would. The NEXT op must NOT keep serving the cached sibling.
    pointer = { activeSandboxId: null, activeEpoch: 4 };
    expect(((await proxy.exec({ cmd: "b" })) as { stdout: string }).stdout).toBe("group-modal");
    expect(resolves).toBe(2);

    // The stale sibling never saw the second op; the home box did.
    expect(sibling.calls).toEqual(["a"]);
    expect(group.calls).toEqual(["b"]);
  });
});

describe("makeActiveBackendResolver — heterogeneous default/modal/selfhosted dispatch", () => {
  const sandboxes: Record<string, RoutableSandbox> = {
    "sbx-self": { id: "sbx-self", kind: "selfhosted", name: "my-laptop", enrollmentId: "enroll-1" },
    "sbx-modal": { id: "sbx-modal", kind: "modal", name: "cloud-box", enrollmentId: null },
  };

  test("null pointer -> the default group backend (no re-establish)", async () => {
    const defaultBackend = new FakeBackend("group-modal");
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend,
      defaultKind: "modal",
      getSandbox: async (id) => sandboxes[id] ?? null,
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    const r = await resolve({ activeSandboxId: null, activeEpoch: 0 });
    expect(r.sandboxId).toBeNull();
    expect(r.kind).toBe("modal");
    expect(r.session).toBe(defaultBackend);
  });

  test("null pointer after a home repair uses the current durable backend, not the stale default handle", async () => {
    const original = new FakeBackend("group-before-repair");
    const replacement = new FakeBackend("group-after-repair");
    let reboundCalls = 0;
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: original,
      defaultKind: "modal",
      resolveDefaultBackend: async (pointer) => {
        reboundCalls += 1;
        if (pointer.activeEpoch === 0) {
          return { session: original, sandboxId: null, kind: "modal" };
        }
        expect(pointer).toEqual({ activeSandboxId: null, activeEpoch: 1 });
        return { session: replacement, sandboxId: null, kind: "modal" };
      },
      getSandbox: async () => null,
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    const ptr = mutablePointer();
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: original, sandboxId: null, kind: "modal" },
      readPointer: ptr.read,
      resolveActiveBackend: resolve,
    });

    await proxy.exec({ cmd: "before" });
    ptr.swap(null); // same home target, but a repair advanced the route epoch
    const result = (await proxy.exec({ cmd: "after" })) as { stdout: string };

    expect(result.stdout).toBe("group-after-repair");
    expect(original.calls).toEqual(["before"]);
    expect(replacement.calls).toEqual(["after"]);
    expect(reboundCalls).toBe(2);
  });

  test("selfhosted target -> a SelfhostedSession bound to the enrollment agentId, fenced under active_epoch", async () => {
    const mock = new MockAgentResponder({ hostname: "the-laptop" });
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async (id) => sandboxes[id] ?? null,
      controlRpcFactory: () => mock,
      relay: RELAY,
    });
    const r = await resolve({ activeSandboxId: "sbx-self", activeEpoch: 7 });
    expect(r.kind).toBe("selfhosted");
    expect(r.sandboxId).toBe("sbx-self");
    // The session reaches the enrollment's agent subject.
    const exec = await (r.session as { exec: (a: unknown) => Promise<{ stdout: string }> }).exec({
      cmd: "echo $HOSTNAME",
    });
    expect(exec.stdout.trim()).toBe("the-laptop");
    // The op carried the swap's active_epoch as the fence.
    expect(mock.requests[0]?.req.epoch).toBe(7);
    // Addressed to agent.<ws>.<enrollmentId>.rpc (the enrollment IS the agent id).
    expect(mock.requests[0]?.subject).toBe(`agent.${WS}.enroll-1.rpc`);
  });

  test("the resolver threads the run environment into the selfhosted target's manifest (env-parity → no manifest-env delta throw)", async () => {
    // Regression for the pin-to-vm env-delta bug: a selfhosted swap target resolved
    // WITHOUT the run environment gets an empty manifest.environment, and the SDK's
    // per-turn provided-session manifest apply throws "Live sandbox sessions cannot
    // change manifest environment variables." The resolver must thread its
    // `environment` into the SelfhostedSession's manifest so it equals the turn's.
    const env = { GIT_AUTHOR_NAME: "OpenGeni Bot", HOME: "/workspace", DEPLOY_TARGET: "vm2" };
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async (id) => sandboxes[id] ?? null,
      controlRpcFactory: () => new MockAgentResponder({ hostname: "the-laptop" }),
      relay: RELAY,
      environment: env,
    });
    const r = await resolve({ activeSandboxId: "sbx-self", activeEpoch: 7 });
    const manifest = (
      r.session as {
        state: {
          manifest: { resolveEnvironment(): Promise<Record<string, string>>; root: string };
        };
      }
    ).state.manifest;
    expect(await manifest.resolveEnvironment()).toEqual(env);
    expect(manifest.root).toBe("/workspace");
  });

  test("pinnedSelfhosted (Stage D machine-primary): the machine pointer returns the SAME pinned instance; an epoch move builds fresh", async () => {
    // The instance-identity pin: a machine-primary turn pre-establishes ONE
    // SelfhostedSession and pins it for the steady-state machine pointer so the
    // turn-start manifest write (via the proxy's `state` getter) and the per-op reads
    // hit that SAME object — never a second, divergent SelfhostedSession.
    const pinnedInstance = new FakeBackend("pinned-machine");
    let freshBuilds = 0;
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: pinnedInstance,
      defaultKind: "selfhosted",
      getSandbox: async (id) => {
        freshBuilds += 1; // a fresh build always goes through getSandbox first
        return sandboxes[id] ?? null;
      },
      controlRpcFactory: () => new MockAgentResponder({ hostname: "rebuilt" }),
      relay: RELAY,
      pinnedSelfhosted: { sandboxId: "sbx-self", epoch: 7, session: pinnedInstance },
    });

    // Steady state (sbx-self @ epoch 7) → the SAME pinned instance, twice, with NO
    // getSandbox/build (the pin short-circuits BEFORE getSandbox).
    const a = await resolve({ activeSandboxId: "sbx-self", activeEpoch: 7 });
    const b = await resolve({ activeSandboxId: "sbx-self", activeEpoch: 7 });
    expect(a.session).toBe(pinnedInstance);
    expect(b.session).toBe(pinnedInstance);
    expect(a.kind).toBe("selfhosted");
    expect(a.sandboxId).toBe("sbx-self");
    expect(freshBuilds).toBe(0);

    // A swap-back at a MOVED epoch (8) no longer matches the pin → a fresh
    // SelfhostedSession fenced under the new epoch (the stale pinned instance, fenced
    // at epoch 7, must NOT be reused).
    const c = await resolve({ activeSandboxId: "sbx-self", activeEpoch: 8 });
    expect(c.session).not.toBe(pinnedInstance);
    expect(c.kind).toBe("selfhosted");
    expect(freshBuilds).toBe(1);

    // The null (group) pointer still routes to the default backend unchanged.
    const d = await resolve({ activeSandboxId: null, activeEpoch: 7 });
    expect(d.session).toBe(pinnedInstance);
    expect(d.sandboxId).toBeNull();
  });

  test("modal swap target with no establisher -> unresolvable, typed unsupported_backend_context", async () => {
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async (id) => sandboxes[id] ?? null,
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    const err = await resolve({ activeSandboxId: "sbx-modal", activeEpoch: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ActiveBackendUnresolvableError);
    expect((err as ActiveBackendUnresolvableError).code).toBe("unsupported_backend_context");
  });

  test("unknown sandbox id -> unresolvable, typed stale_pointer (issue #341 typed diagnostics)", async () => {
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async () => null,
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    const err = await resolve({ activeSandboxId: "ghost", activeEpoch: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ActiveBackendUnresolvableError);
    expect((err as ActiveBackendUnresolvableError).code).toBe("stale_pointer");
    expect((err as Error).message).toMatch(/not found/);
  });

  test("selfhosted target missing an enrollment -> typed offline_enrollment", async () => {
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async () => ({
        id: "sbx-orphan",
        kind: "selfhosted",
        name: "unpaired",
        enrollmentId: null,
      }),
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    const err = await resolve({ activeSandboxId: "sbx-orphan", activeEpoch: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ActiveBackendUnresolvableError);
    expect((err as ActiveBackendUnresolvableError).code).toBe("offline_enrollment");
  });

  test("end-to-end: proxy + real resolver, swap Modal->selfhosted lands the op on the laptop", async () => {
    const groupModal = new FakeBackend("group-modal");
    const laptop = new MockAgentResponder({ hostname: "laptop-99" });
    const ptr = mutablePointer();
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: groupModal,
      defaultKind: "modal",
      getSandbox: async (id) => sandboxes[id] ?? null,
      controlRpcFactory: () => laptop,
      relay: RELAY,
    });
    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: resolve,
    });

    // Before swap: the op runs on the group Modal box.
    expect(((await proxy.exec({ cmd: "uname" })) as { stdout: string }).stdout).toBe("group-modal");
    // Swap to the laptop.
    ptr.swap("sbx-self");
    // After swap: the exec reaches the laptop agent (echoes its hostname).
    const r = (await proxy.exec({ cmd: "echo $HOSTNAME" })) as { stdout: string };
    expect(r.stdout.trim()).toBe("laptop-99");
    expect(groupModal.calls).toEqual(["uname"]);
  });

  // REGRESSION (issue #341 Shape 3): a Modal-home turn that starts on its group box,
  // swaps to a Connected Machine, then clears BACK to the null/default pointer must
  // re-land the next op on the EXISTING group box — never keep serving the cached
  // SelfhostedSession the swap built. (The 2026-07-10 failure: activeSandboxId:null in
  // the list, but the exec hit a SelfhostedControlError from a stale machine session.)
  test("(Shape 3) swap Modal-home → machine → clear back to null re-lands on the EXISTING group box, never the cached machine session", async () => {
    const groupModal = new FakeBackend("group-modal");
    const laptop = new MockAgentResponder({ hostname: "laptop-1" });
    const ptr = mutablePointer(); // null start == the established Modal group box (home)
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: groupModal,
      defaultKind: "modal",
      getSandbox: async (id) =>
        id === "sbx-self"
          ? { id, kind: "selfhosted", name: "laptop", enrollmentId: "enroll-1" }
          : null,
      controlRpcFactory: () => laptop,
      relay: RELAY,
    });
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: groupModal, sandboxId: null, kind: "modal" },
      readPointer: ptr.read,
      resolveActiveBackend: resolve,
    });

    // Home op: the group Modal box (echoes its tag).
    expect(((await proxy.exec({ cmd: "0" })) as { stdout: string }).stdout).toBe("group-modal");
    // Swap to the machine: the op reaches the laptop agent (echoes its hostname).
    ptr.swap("sbx-self");
    expect(
      ((await proxy.exec({ cmd: "echo $HOSTNAME" })) as { stdout: string }).stdout.trim(),
    ).toBe("laptop-1");
    // Clear BACK to null: the op re-lands on the EXISTING group box, NOT the machine.
    ptr.swap(null);
    const back = await proxy.exec({ cmd: "2" });
    expect((back as { stdout: string }).stdout).toBe("group-modal");
    // The group box served both home ops; the machine served only its swapped-to op.
    expect(groupModal.calls).toEqual(["0", "2"]);
  });

  // A machine going offline WHILE IT IS NOT ACTIVE (pointer back on the group box)
  // must never surface on a home op — the null pointer resolves to the group box,
  // whose availability is independent of the (now offline) machine.
  test("(Shape 3) a machine offline while not active does not surface on the null/home op", async () => {
    const groupModal = new FakeBackend("group-modal");
    // The machine is offline → any op addressed to it would surface agent_offline.
    const offlineLaptop = new MockAgentResponder({ online: false });
    const ptr = mutablePointer();
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: groupModal,
      defaultKind: "modal",
      getSandbox: async (id) =>
        id === "sbx-self"
          ? { id, kind: "selfhosted", name: "laptop", enrollmentId: "enroll-1" }
          : null,
      controlRpcFactory: () => offlineLaptop,
      relay: RELAY,
      selfhostedTimeoutMs: 200,
    });
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: groupModal, sandboxId: null, kind: "modal" },
      readPointer: ptr.read,
      resolveActiveBackend: resolve,
    });

    // The pointer is on the group box (null); the offline machine is irrelevant.
    expect(((await proxy.exec({ cmd: "home" })) as { stdout: string }).stdout).toBe("group-modal");
    expect(groupModal.calls).toEqual(["home"]);
  });
});

describe("swapTargetEstablishability — the shared admission/establishment predicate (issue #341 invariant A)", () => {
  test("the session's own group box is always establishable (it is the null/home target)", () => {
    expect(swapTargetEstablishability({ kind: "modal", isSessionGroup: true })).toEqual({
      ok: true,
    });
    expect(swapTargetEstablishability({ kind: "selfhosted", isSessionGroup: true })).toEqual({
      ok: true,
    });
  });

  test("a selfhosted machine target is establishable (liveness is admission's separate gate)", () => {
    expect(swapTargetEstablishability({ kind: "selfhosted", isSessionGroup: false })).toEqual({
      ok: true,
    });
  });

  test("a NON-group modal target is NOT establishable → unsupported_backend_context (Shape 1)", () => {
    const r = swapTargetEstablishability({ kind: "modal", isSessionGroup: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("unsupported_backend_context");
      expect(r.reason).toMatch(/Modal sandbox other than this session/i);
    }
  });

  test("an unknown backend kind is NOT establishable", () => {
    const r = swapTargetEstablishability({ kind: "daytona", isSessionGroup: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("unsupported_backend_context");
    }
  });
});

describe("RoutingSandboxSession — native-desktop surface (machine-primary computer-use)", () => {
  test("proxy fronting a native-capable default backend duck-types as native + dispatches desktopInput/screenshot to the active backend", async () => {
    // The bug: a machine-primary session routes computer-use through the proxy, but
    // the proxy did not forward desktopInput/screenshot → isNativeDesktopSession failed
    // → the capability bound the Linux exec-shelling SandboxComputer onto the Mac.
    const native = new NativeFakeBackend("selfhosted");
    const ptr = mutablePointer({ activeSandboxId: "sbx-self", activeEpoch: 1 });
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: native, sandboxId: "sbx-self", kind: "selfhosted" },
      readPointer: ptr.read,
      resolveActiveBackend: async () => ({
        session: native,
        sandboxId: "sbx-self",
        kind: "selfhosted",
      }),
    });

    // The REAL discriminator selects the native computer for this proxy.
    expect(isNativeDesktopSession(proxy as never)).toBe(true);

    // desktopInput dispatches to the active backend, carrying the event through.
    const event = { $case: "pointer", pointer: { x: 12, y: 34, action: "click", button: "left" } };
    await proxy.desktopInput!(event);
    expect(native.desktopEvents).toEqual([event]);

    // screenshot dispatches and returns the backend's frame.
    const shot = await proxy.screenshot!();
    expect(native.screenshots).toBe(1);
    expect(shot).toEqual(native.frame);
  });

  test("proxy fronting a Modal-like default backend (no native surface) does NOT duck-type as native (regression: Modal misclassification)", async () => {
    // A Modal box has no desktopInput/screenshot. The proxy must NOT expose them
    // (presence is the selection signal), or every Modal-fronting proxy would be
    // misclassified as native and driven with CGEvent/screenshot ops it can't serve.
    const modal = new FakeBackend("modal");
    const ptr = mutablePointer();
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: modal, sandboxId: null, kind: "modal" },
      readPointer: ptr.read,
      resolveActiveBackend: async () => ({ session: modal, sandboxId: null, kind: "modal" }),
    });

    expect(isNativeDesktopSession(proxy as never)).toBe(false);
    expect(typeof proxy.desktopInput).toBe("undefined");
    expect(typeof proxy.screenshot).toBe("undefined");
  });

  test("mid-turn cross-kind swap: default native, pointer swaps to a NON-native backend → screenshot() rejects RoutingUnsupportedError", async () => {
    // The proxy exposes the native surface (default backend was native), but a
    // mid-turn swap repoints to a Modal box with no screenshot. Rather than silently
    // shelling Linux tools onto a Mac (or crashing opaquely), dispatch surfaces a
    // legible RoutingUnsupportedError the caller can report as a tool failure.
    const native = new NativeFakeBackend("selfhosted");
    const modal = new FakeBackend("modal");
    const ptr = mutablePointer({ activeSandboxId: "sbx-self", activeEpoch: 1 });
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: native, sandboxId: "sbx-self", kind: "selfhosted" },
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer): Promise<ResolvedActiveBackend> =>
        pointer.activeSandboxId === "sbx-self"
          ? { session: native, sandboxId: "sbx-self", kind: "selfhosted" }
          : { session: modal, sandboxId: pointer.activeSandboxId, kind: "modal" },
    });

    // Native surface is present (minted from the native default).
    expect(typeof proxy.screenshot).toBe("function");
    // First screenshot lands on the native backend.
    await proxy.screenshot!();
    expect(native.screenshots).toBe(1);

    // Swap to the non-native Modal box (epoch bump) → the NEXT screenshot rejects.
    ptr.swap("sbx-modal");
    await expect(proxy.screenshot!()).rejects.toBeInstanceOf(RoutingUnsupportedError);
  });

  test("screenshot return value passes through unchanged ({png,width,height})", async () => {
    const native = new NativeFakeBackend("selfhosted");
    const ptr = mutablePointer({ activeSandboxId: "sbx-self", activeEpoch: 1 });
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: native, sandboxId: "sbx-self", kind: "selfhosted" },
      readPointer: ptr.read,
      resolveActiveBackend: async () => ({
        session: native,
        sandboxId: "sbx-self",
        kind: "selfhosted",
      }),
    });

    const shot = await proxy.screenshot!();
    expect(shot.png).toBe(native.frame.png);
    expect(shot.width).toBe(1440);
    expect(shot.height).toBe(900);
  });
});

describe("defaultIsHome — a machine-pinned turn's clear-to-null fails typed (issue #341, deferred sliver)", () => {
  const machineSandbox: RoutableSandbox = {
    id: "sbx-self",
    kind: "selfhosted",
    name: "laptop",
    enrollmentId: "enroll-1",
  };

  test("defaultIsHome:false — a clear-to-null on a machine-pinned turn throws typed home_unavailable_this_turn, never routes to the machine", async () => {
    // A Modal-HOME session pinned to a machine never established its group box this
    // turn. A mid-turn clear-to-null must fail typed-and-specific — the detach is
    // accepted (its pointer commit stands, effective next turn) and this turn has no
    // home box — rather than silently keep serving the pinned machine.
    const machine = new FakeBackend("pinned-machine");
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: machine,
      defaultKind: "selfhosted",
      getSandbox: async (id) => (id === "sbx-self" ? machineSandbox : null),
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
      pinnedSelfhosted: { sandboxId: "sbx-self", epoch: 3, session: machine },
      defaultIsHome: false,
    });

    // The pinned machine pointer still resolves to the machine (normal machine ops).
    const pinned = await resolve({ activeSandboxId: "sbx-self", activeEpoch: 3 });
    expect(pinned.session).toBe(machine);

    // A clear-to-null has NO established home this turn → typed, specific error.
    const err = await resolve({ activeSandboxId: null, activeEpoch: 4 }).catch((e) => e);
    expect(err).toBeInstanceOf(ActiveBackendUnresolvableError);
    expect((err as ActiveBackendUnresolvableError).code).toBe("home_unavailable_this_turn");
    expect((err as Error).message).toMatch(/detach|next turn|no active home/i);
    // The machine was NOT returned as the null answer (no silent re-route).
    expect((err as Error).message).not.toMatch(/pinned-machine/);
  });

  test("defaultIsHome omitted (machine-home / null-start Modal-home): null resolves to the home default as before", async () => {
    const home = new FakeBackend("home-box");
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: home,
      defaultKind: "selfhosted",
      getSandbox: async () => null,
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    const r = await resolve({ activeSandboxId: null, activeEpoch: 0 });
    expect(r.session).toBe(home);
    expect(r.sandboxId).toBeNull();
  });

  test("defaultIsHome:true (a genuine machine-HOME turn): null still resolves to the machine (no regression)", async () => {
    // A machine-HOME session's home IS the machine, so a clear-to-null resolves right
    // back to it — the throw is scoped to Modal-home turns pinned to a machine.
    const machine = new FakeBackend("machine-home");
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: machine,
      defaultKind: "selfhosted",
      getSandbox: async () => null,
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
      defaultIsHome: true,
    });
    const r = await resolve({ activeSandboxId: null, activeEpoch: 5 });
    expect(r.session).toBe(machine);
    expect(r.sandboxId).toBeNull();
  });

  test("the proxy surfaces the typed error to the op (never a silent machine landing)", async () => {
    const machine = new FakeBackend("pinned-machine");
    const ptr = mutablePointer({ activeSandboxId: "sbx-self", activeEpoch: 3 });
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: machine,
      defaultKind: "selfhosted",
      getSandbox: async (id) => (id === "sbx-self" ? machineSandbox : null),
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
      pinnedSelfhosted: { sandboxId: "sbx-self", epoch: 3, session: machine },
      defaultIsHome: false,
    });
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: machine, sandboxId: "sbx-self", kind: "selfhosted" },
      readPointer: ptr.read,
      resolveActiveBackend: resolve,
    });

    // First op on the pinned machine works.
    expect(((await proxy.exec({ cmd: "0" })) as { stdout: string }).stdout).toBe("pinned-machine");
    // Clear to null (the detach) → the next op fails typed, does NOT land on the machine.
    ptr.swap(null);
    const err = await proxy.exec({ cmd: "1" }).catch((e) => e);
    expect(err).toBeInstanceOf(ActiveBackendUnresolvableError);
    expect((err as ActiveBackendUnresolvableError).code).toBe("home_unavailable_this_turn");
    // The machine only ever saw the pre-detach op.
    expect(machine.calls).toEqual(["0"]);
  });
});
