// Unit tests for the op-stream exec client through the REAL SelfhostedSession
// surface (exec() with deps.opStream injected), against the scripted fake
// runner (op-testing.ts). The Rust harness proves the runner half; these prove
// the CLIENT half: reassembly, heals, ack policy, fault taxonomy, rendering
// parity, and the durable-before-wire-ack ordering.

import { describe, expect, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { shell } from "@openai/agents/sandbox";
import { ErrorCode, type ControlRequest } from "@opengeni/agent-proto";
import type { ControlRpc } from "../src/sandbox/selfhosted/control-rpc";
import type { SelfhostedOpObservation } from "../src/sandbox/selfhosted/op-observer";
import { FakeOpRunner, InMemoryOpStreamTransport } from "../src/sandbox/selfhosted/op-testing";
import { SelfhostedSession } from "../src/sandbox/selfhosted/session";
import type { OpStreamJournal } from "../src/sandbox/selfhosted/op-stream";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";

const WORKSPACE = "ws-1";
const AGENT = "agent-1";
const CONNECTION_INSTANCE = "connection-test";

function buildRig(
  opts: {
    journal?: OpStreamJournal;
    execTimeoutMs?: number;
    windowBytes?: number;
    memoryMaxBytes?: number;
    controlWorkspaceId?: string;
    connectionInstanceId?: string;
    adoptBackgroundCommand?: (input: {
      controlWorkspaceId: string;
      enrollmentId: string;
      connectionInstanceId: string;
      opId: string;
      command: string;
    }) => Promise<{ commandId: string }>;
    settleBackgroundCommand?: (input: {
      commandId: string;
      controlWorkspaceId: string;
      enrollmentId: string;
      connectionInstanceId: string;
      opId: string;
      outcome: "exited" | "lost";
      exitCode: number | null;
      reason: string;
    }) => Promise<void>;
  } = {},
) {
  const connectionInstanceId = opts.connectionInstanceId ?? CONNECTION_INSTANCE;
  const transport = new InMemoryOpStreamTransport();
  const runner = new FakeOpRunner({
    transport,
    workspaceId: opts.controlWorkspaceId ?? WORKSPACE,
    agentId: AGENT,
    connectionInstanceId,
  });
  const observations: SelfhostedOpObservation[] = [];
  const requests: ControlRequest[] = [];
  const session = new SelfhostedSession({
    workspaceId: WORKSPACE,
    ...(opts.controlWorkspaceId ? { controlWorkspaceId: opts.controlWorkspaceId } : {}),
    agentId: AGENT,
    connectionInstanceId,
    controlRpc: {
      request: async (subject, request, requestOpts) => {
        requests.push(request);
        return await runner.request(subject, request, requestOpts);
      },
    },
    relay: { host: "relay.test" },
    timeoutMs: 2_000,
    execTimeoutMs: opts.execTimeoutMs ?? 5_000,
    retryClock: { sleep: async () => {}, jitter: () => 0.5 },
    onOp: (observation) => observations.push(observation),
    ...(opts.adoptBackgroundCommand ? { adoptBackgroundCommand: opts.adoptBackgroundCommand } : {}),
    ...(opts.settleBackgroundCommand
      ? { settleBackgroundCommand: opts.settleBackgroundCommand }
      : {}),
    ...(opts.memoryMaxBytes !== undefined
      ? {
          operationResourcePolicy: { memoryMaxBytes: opts.memoryMaxBytes },
          operationResourcePolicySupported: true,
        }
      : {}),
    opStream: {
      transport,
      ...(opts.journal ? { journal: opts.journal } : {}),
      ...(opts.windowBytes !== undefined ? { windowBytes: opts.windowBytes } : {}),
      ackIntervalMs: 20,
      silenceTimeoutMs: 120,
      reconnectHoldMs: 600,
    },
  });
  return { transport, runner, session, observations, requests };
}

describe("op-stream exec (fake runner)", () => {
  test("execCommand durably adopts a live command before returning its exact locator", async () => {
    const adoptions: Array<{
      controlWorkspaceId: string;
      enrollmentId: string;
      connectionInstanceId: string;
      opId: string;
      command: string;
    }> = [];
    const commandId = "11111111-1111-4111-8111-111111111111";
    const { runner, session, requests } = buildRig({
      controlWorkspaceId: "physical-ws",
      connectionInstanceId: "launch-instance",
      adoptBackgroundCommand: async (input) => {
        adoptions.push(input);
        return { commandId };
      },
    });
    runner.script("call_background:0", {
      frames: [],
      live: true,
      holdUntilCancel: true,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const transferStarted: string[] = [];
    const transferred: string[] = [];

    const result = await runWithToolCallCorrelation(
      "call_background",
      () => session.execCommand({ cmd: "sleep 60", yieldTimeMs: 1 }),
      {
        onDurableOpOwnershipTransferStarted: (opId) => transferStarted.push(opId),
        onDurableOpOwnershipTransferred: (opId) => transferred.push(opId),
      },
    );

    expect(transferStarted).toEqual(["call_background:0"]);
    expect(transferred).toEqual(["call_background:0"]);
    expect(result).toContain(`command ID ${commandId}`);
    expect(result).toContain("operation call_background:0");
    expect(adoptions).toEqual([
      {
        controlWorkspaceId: "physical-ws",
        enrollmentId: AGENT,
        connectionInstanceId: "launch-instance",
        opId: "call_background:0",
        command: "sleep 60",
      },
    ]);
    expect(requests[0]?.epoch).toBe(0);
    expect(runner.runs.get("call_background:0")?.exit.cancelled).toBe(false);
  });

  test("failed background adoption exact-cancels and never returns a live locator", async () => {
    const { runner, session } = buildRig({
      connectionInstanceId: "launch-instance",
      adoptBackgroundCommand: async () => {
        throw new Error("database unavailable");
      },
    });
    runner.script("call_adoption_failure:0", {
      frames: [],
      live: true,
      holdUntilCancel: true,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");

    await expect(
      runWithToolCallCorrelation("call_adoption_failure", () =>
        session.execCommand({ cmd: "sleep 60", yieldTimeMs: 1 }),
      ),
    ).rejects.toThrow("database unavailable");
    expect(runner.runs.get("call_adoption_failure:0")?.exit.cancelled).toBe(true);
  });

  test("exit during adoption is fast-settled instead of returned as running", async () => {
    const settlements: Array<Record<string, unknown>> = [];
    let session!: SelfhostedSession;
    const rig = buildRig({
      connectionInstanceId: "launch-instance",
      adoptBackgroundCommand: async (input) => {
        await session.cancelExecCommand(input.opId);
        return { commandId: "22222222-2222-4222-8222-222222222222" };
      },
      settleBackgroundCommand: async (input) => {
        settlements.push(input);
      },
    });
    session = rig.session;
    rig.runner.script("call_exit_during_adoption:0", {
      frames: [],
      live: true,
      holdUntilCancel: true,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");

    const result = await runWithToolCallCorrelation("call_exit_during_adoption", () =>
      session.execCommand({ cmd: "sleep 60", yieldTimeMs: 1 }),
    );

    expect(result).toContain("Process exited with code -1");
    expect(result).not.toContain("Command running in background");
    expect(settlements).toEqual([
      {
        commandId: "22222222-2222-4222-8222-222222222222",
        controlWorkspaceId: WORKSPACE,
        enrollmentId: AGENT,
        connectionInstanceId: "launch-instance",
        opId: "call_exit_during_adoption:0",
        outcome: "exited",
        exitCode: -1,
        reason: "op_exit",
      },
    ]);
  });

  test("fast-settlement failure preserves the terminal result for durable reconciliation", async () => {
    let session!: SelfhostedSession;
    const rig = buildRig({
      connectionInstanceId: "launch-instance",
      adoptBackgroundCommand: async (input) => {
        await session.cancelExecCommand(input.opId);
        return { commandId: "33333333-3333-4333-8333-333333333333" };
      },
      settleBackgroundCommand: async () => {
        throw new Error("database unavailable");
      },
    });
    session = rig.session;
    rig.runner.script("call_fast_settlement_failure:0", {
      frames: [],
      live: true,
      holdUntilCancel: true,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");

    const result = await runWithToolCallCorrelation("call_fast_settlement_failure", () =>
      session.execCommand({ cmd: "sleep 60", yieldTimeMs: 1 }),
    );

    expect(result).toContain("Process exited with code -1");
    expect(result).not.toContain("database unavailable");
  });

  test("baseline: streams stdout+stderr, byte-exact result, ok observation with replyBytes", async () => {
    const { runner, session, observations } = buildRig();
    runner.script("call_base:0", {
      frames: [
        { channel: "stdout", bytes: "hello " },
        { channel: "stderr", bytes: "warn\n" },
        { channel: "stdout", bytes: "world" },
      ],
      exit: { exitCode: 0 },
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const result = await runWithToolCallCorrelation("call_base", () =>
      session.exec({ cmd: "echo hello world" }),
    );
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("warn\n");
    expect(result.exitCode).toBe(0);
    const run = runner.runs.get("call_base:0");
    expect(run?.startCount).toBe(1);
    const ok = observations.find((o) => o.outcome === "ok");
    expect(ok?.op).toBe("exec");
    expect(ok?.replyBytes).toBe("hello world".length + "warn\n".length);
  });

  test("OpStart carries the configured command policy", async () => {
    const { runner, session, requests } = buildRig({ memoryMaxBytes: 134_217_728 });
    runner.script("call_policy:0", { frames: [{ channel: "stdout", bytes: "ok" }] });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");

    await runWithToolCallCorrelation("call_policy", () => session.exec({ cmd: "true" }));

    const start = requests.find((request) => request.op?.$case === "opStart");
    expect(start?.resourcePolicy?.memoryMaxBytes).toBe("134217728");
    expect(start?.resourcePolicy?.memoryHighBytes).toBeUndefined();
    expect(
      requests
        .filter((request) => request.op?.$case !== "opStart")
        .every((request) => request.resourcePolicy === undefined),
    ).toBe(true);
  });

  test("deadline 0 runs over op-stream with no duration wall", async () => {
    const { runner, session } = buildRig({ execTimeoutMs: 0 });
    runner.script("call_unbounded:0", {
      frames: [{ channel: "stdout", bytes: "finished" }],
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const result = await runWithToolCallCorrelation("call_unbounded", () =>
      session.exec({ cmd: "long-running-build" }),
    );

    expect(session.effectiveExecDeadlineMs).toBe(0);
    expect(result.stdout).toBe("finished");
    expect(result.timedOut).toBe(false);
  });

  test("OpCancel physically settles a running connected-machine exec", async () => {
    const { runner, session } = buildRig();
    runner.script("call_cancel:0", { frames: [], live: true, holdUntilCancel: true });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const executing = runWithToolCallCorrelation("call_cancel", () =>
      session.exec({ cmd: "sleep 60" }),
    );
    while (!runner.runs.has("call_cancel:0")) await Bun.sleep(1);

    const cancelledAt = performance.now();
    await session.cancelExecCommand("call_cancel:0");
    const result = await executing;

    expect(performance.now() - cancelledAt).toBeLessThan(2_000);
    expect(result.exitCode).toBe(-1);
    expect(runner.runs.get("call_cancel:0")?.exit.cancelled).toBe(true);
  });

  test("reconnect cancellation stays bound to the admitted connection", async () => {
    const staleTransport = new InMemoryOpStreamTransport();
    const liveTransport = new InMemoryOpStreamTransport();
    const staleRunner = new FakeOpRunner({
      transport: staleTransport,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "stale-instance",
    });
    const liveRunner = new FakeOpRunner({
      transport: liveTransport,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "live-instance",
    });
    const requests: Array<{ subject: string; request: ControlRequest }> = [];
    const session = new SelfhostedSession({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "stale-instance",
      controlRpc: {
        request: async (subject, request, opts) => {
          requests.push({ subject, request });
          return subject.includes("connection.live-instance.rpc")
            ? await liveRunner.request(subject, request, opts)
            : await staleRunner.request(subject, request, opts);
        },
      },
      relay: { host: "relay.test" },
      timeoutMs: 2_000,
      execTimeoutMs: 5_000,
      opStream: { transport: staleTransport },
      resolveOperationAdmission: async () => ({
        connectionInstanceId: "live-instance",
        operationResourcePolicy: {
          memoryMaxBytes: null,
          memoryHighBytes: null,
          cpuMaxMillicores: null,
          revision: 2,
        },
        operationResourcePolicySupported: true,
        operationCpuQuotaSupported: true,
        opStream: { transport: liveTransport },
      }),
    });
    liveRunner.script("call_reconnect_cancel:0", {
      frames: [],
      live: true,
      holdUntilCancel: true,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const executing = runWithToolCallCorrelation("call_reconnect_cancel", () =>
      session.exec({ cmd: "sleep 60" }),
    );
    while (!liveRunner.runs.has("call_reconnect_cancel:0")) await Bun.sleep(1);

    expect(await session.cancelExecCommand("unknown-after-reconnect")).toBe(false);
    expect(await session.cancelExecCommand("call_reconnect_cancel:0")).toBe(true);
    const result = await executing;

    expect(result.exitCode).toBe(-1);
    expect(liveRunner.runs.get("call_reconnect_cancel:0")?.exit.cancelled).toBe(true);
    expect(staleRunner.runs.size).toBe(0);
    expect(
      requests
        .filter(({ request }) => request.op?.$case === "opCancel")
        .map(({ subject }) => subject),
    ).toEqual([expect.stringContaining("connection.live-instance.rpc")]);
  });

  test("the SDK shell capability and turn fence cancel a connected-machine process end to end", async () => {
    const { runner, session } = buildRig();
    runner.script("call_shell_cancel:0", { frames: [], live: true, holdUntilCancel: true });
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    const capability = shell({
      configureTools: (tools) => controller.wrapTools(tools, session),
    });
    const exec = capability
      .clone()
      .bind(session)
      .tools()
      .find(
        (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
          tool.type === "function" && tool.name === "exec_command",
      );
    expect(exec).toBeDefined();
    const invocation = exec!.invoke({} as never, JSON.stringify({ cmd: "sleep 60" }), {
      toolCall: {
        type: "function_call",
        callId: "call_shell_cancel",
        name: "exec_command",
        arguments: "{}",
      },
    });
    while (!runner.runs.has("call_shell_cancel:0")) await Bun.sleep(1);

    const cancelledAt = performance.now();
    abort.abort(new Error("steered"));
    await controller.waitForQuiescence();
    await invocation;

    expect(performance.now() - cancelledAt).toBeLessThan(2_000);
    expect(runner.runs.get("call_shell_cancel:0")?.exit.cancelled).toBe(true);
  });

  test("OpCancel racing before OpStart tombstones the command with zero execution", async () => {
    const { runner, session } = buildRig();
    runner.script("call_cancel_early:0", {
      frames: [{ channel: "stdout", bytes: "must-not-run" }],
    });
    await session.cancelExecCommand("call_cancel_early:0");
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const error = await runWithToolCallCorrelation("call_cancel_early", () =>
      session.exec({ cmd: "printf must-not-run" }).then(
        () => null,
        (reason: unknown) => reason,
      ),
    );

    expect(String((error as Error).message)).toContain("cancelled before");
    expect(runner.runs.has("call_cancel_early:0")).toBe(false);
  });

  test("mid-op acks are credit-only; the final ack lands only via finalizeOpStreamOps, journal-first", async () => {
    const events: string[] = [];
    const journal: OpStreamJournal = {
      attachGeneration: () => "7",
      persistSettled: (opId, exitSeq) => {
        events.push(`persist:${opId}@${exitSeq}`);
      },
    };
    const { transport, runner, session } = buildRig({ journal });
    runner.script("call_ack:0", {
      frames: [{ channel: "stdout", bytes: "x".repeat(1024) }, "progress"],
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    await runWithToolCallCorrelation("call_ack", () => session.exec({ cmd: "true" }));

    const preFinal = transport.decodedAcks();
    // Every ack so far is CREDIT-ONLY: acked_seq 0, never final, and the
    // credit grows past the initial window as payload arrives.
    expect(preFinal.length).toBeGreaterThan(0);
    for (const ack of preFinal) {
      expect(ack.ackedSeq).toBe("0");
      expect(ack.final).toBe(false);
      expect(ack.attachGeneration).toBe("7");
    }
    const run = runner.runs.get("call_ack:0");
    expect(run?.finalAcked).toBe(false);

    // The turn-end hook: journal persist strictly BEFORE the wire final ack.
    transport.onPublish = ((original) => (subject: string, payload: Uint8Array) => {
      events.push("wire-ack");
      original?.(subject, payload);
    })(transport.onPublish);
    await session.finalizeOpStreamOps();
    expect(events[0]).toBe(`persist:call_ack:0@${run?.exitSeq.toString()}`);
    expect(events[1]).toBe("wire-ack");
    expect(runner.runs.get("call_ack:0")?.finalAcked).toBe(true);
  });

  test("re-issued op id ATTACHES and collects — never re-runs (B1)", async () => {
    const { runner, session } = buildRig();
    runner.script("call_dup:0", {
      frames: [{ channel: "stdout", bytes: "once" }],
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const first = await runWithToolCallCorrelation("call_dup", () =>
      session.exec({ cmd: "marker" }),
    );
    // The re-dispatch: same call id → same op id → OpStart dedups → attach
    // replays from retention → byte-identical result.
    const second = await runWithToolCallCorrelation("call_dup", () =>
      session.exec({ cmd: "marker" }),
    );
    expect(second.stdout).toBe(first.stdout);
    const run = runner.runs.get("call_dup:0");
    expect(run?.startCount).toBe(2); // two OpStarts…
    expect(runner.runs.size).toBe(1); // …ONE execution.
  });

  test("live drops + duplicates + reordering heal via attach replay (byte-exact)", async () => {
    const { runner, session, observations } = buildRig();
    runner.script("call_chaos:0", {
      frames: [
        { channel: "stdout", bytes: "a" },
        { channel: "stdout", bytes: "b" },
        { channel: "stdout", bytes: "c" },
        { channel: "stdout", bytes: "d" },
      ],
      live: true,
      dropLiveSeqs: new Set([2]),
      duplicateLiveSeqs: new Set([3]),
      reorderLivePairs: true,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const result = await runWithToolCallCorrelation("call_chaos", () =>
      session.exec({ cmd: "chaotic" }),
    );
    expect(result.stdout).toBe("abcd");
    const healed = observations.find((o) => o.outcome === "ok");
    expect(healed?.healed).toBe(true);
  });

  test("an out-of-order burst larger than the byte stash heals by replay", async () => {
    const { runner, session } = buildRig({ windowBytes: 4 });
    runner.script("call_stash:0", {
      frames: [
        { channel: "stdout", bytes: "0123456789" },
        { channel: "stdout", bytes: "abcdefghij" },
      ],
      live: true,
      reorderLivePairs: true,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const result = await runWithToolCallCorrelation("call_stash", () =>
      session.exec({ cmd: "burst" }),
    );

    expect(result.stdout).toBe("0123456789abcdefghij");
    expect(runner.runs.get("call_stash:0")!.attachCount).toBeGreaterThan(1);
  });

  test("total live loss heals through the silence probe (OpQuery → re-attach)", async () => {
    const { runner, session } = buildRig();
    runner.script("call_silent:0", {
      frames: [{ channel: "stdout", bytes: "recovered" }],
      live: true,
      dropLiveSeqs: new Set([1, 2]),
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const result = await runWithToolCallCorrelation("call_silent", () =>
      session.exec({ cmd: "silent" }),
    );
    expect(result.stdout).toBe("recovered");
    expect(runner.runs.get("call_silent:0")!.attachCount).toBeGreaterThan(1);
  });

  test("runner-typed OP_OVERFLOW maps to the payload-too-large taxonomy", async () => {
    const { runner, session, observations } = buildRig();
    runner.script("call_over:0", {
      frames: [],
      exit: {
        exitCode: 0,
        failureCode: "OP_OVERFLOW",
        failureDetail: { retained_bytes: "268435456" },
      },
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const error = await runWithToolCallCorrelation("call_over", () =>
      session.exec({ cmd: "yes" }).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(error).toMatchObject({ name: "SelfhostedControlError", payloadTooLarge: true });
    const failed = observations.find((o) => o.outcome === "failed");
    expect(failed?.faultClass).toBe("payload_too_large");
  });

  test("OP_OVERFLOW renders the four FAILURE-VISIBILITY fields with the termination truth", async () => {
    const { runner, session } = buildRig();
    runner.script("call_render:0", {
      frames: [],
      exit: {
        failureCode: "OP_OVERFLOW",
        failureDetail: { retained_bytes: "268435456" },
      },
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const error = await runWithToolCallCorrelation("call_render", () =>
      session.exec({ cmd: "yes" }).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    const { renderSelfhostedFault } = await import("../src/sandbox/selfhosted/fault-rendering");
    const { SelfhostedControlError } = await import("../src/sandbox/selfhosted/control-rpc");
    const rendered = renderSelfhostedFault(error as InstanceType<typeof SelfhostedControlError>);
    // The doctrine's four mandatory fields, with the OVERFLOW truth: the
    // command was STOPPED at the retention ceiling (it did not complete), and
    // the recovery is to bound the output — never a silent truncation.
    expect(rendered).toContain("What happened:");
    expect(rendered).toContain("Which layer:");
    expect(rendered).toContain("What was preserved:");
    expect(rendered).toContain("What to try:");
    expect(rendered).toContain("268435456");
    expect(rendered).toContain("did NOT run to completion");
    expect(rendered).toContain("/tmp/out.log");
  });

  test("parallel tool calls keep their correlation contexts separated (ALS)", async () => {
    const { runWithToolCallCorrelation, nextDurableOpId } =
      await import("../src/sandbox/op-correlation");
    // Two overlapping tool invocations mint interleaved ids concurrently; each
    // async chain must see ONLY its own call id and its own ordinal sequence.
    const minted: Record<string, string[]> = { a: [], b: [] };
    const run = (key: "a" | "b", callId: string) =>
      runWithToolCallCorrelation(callId, async () => {
        for (let i = 0; i < 3; i += 1) {
          await Bun.sleep(Math.random() * 5);
          minted[key].push(nextDurableOpId() as string);
        }
      });
    await Promise.all([run("a", "call_par_a"), run("b", "call_par_b")]);
    expect(minted.a).toEqual(["call_par_a:0", "call_par_a:1", "call_par_a:2"]);
    expect(minted.b).toEqual(["call_par_b:0", "call_par_b:1", "call_par_b:2"]);
  });

  test("a lost (evicted) op fails typed, mentioning the eviction", async () => {
    const { runner, session } = buildRig();
    runner.script("call_lost:0", { frames: [] });
    runner.lostOps.add("call_lost:0");
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const error = await runWithToolCallCorrelation("call_lost", () =>
      session.exec({ cmd: "gone" }).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(String((error as Error).message)).toContain("no longer available");
  });

  test("timed-out exec surfaces the deadline hint on stderr (rendering parity)", async () => {
    const { runner, session } = buildRig();
    runner.script("call_timeout:0", {
      frames: [{ channel: "stdout", bytes: "partial" }],
      exit: { exitCode: -1, timedOut: true },
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const result = await runWithToolCallCorrelation("call_timeout", () =>
      session.exec({ cmd: "sleep 999" }),
    );
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("partial");
    expect(result.stderr).toContain("terminated at the 5-second execution limit");
  });

  test("DRAINING OpStarts retry patiently, then succeed (healed via draining)", async () => {
    const { runner, session, observations } = buildRig();
    runner.script("call_drain:0", {
      frames: [{ channel: "stdout", bytes: "admitted" }],
      drainingStarts: 3,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const result = await runWithToolCallCorrelation("call_drain", () =>
      session.exec({ cmd: "queued" }),
    );
    expect(result.stdout).toBe("admitted");
    const ok = observations.find((o) => o.outcome === "ok");
    expect(ok?.healed).toBe(true);
    expect(ok?.retries).toBe(3);
  });

  test("unavailable transport fails before request-reply exec dispatch", async () => {
    const transport = new InMemoryOpStreamTransport();
    transport.available = false;
    const { MockAgentResponder } = await import("../src/sandbox/selfhosted/testing");
    const responder = new MockAgentResponder();
    const session = new SelfhostedSession({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: CONNECTION_INSTANCE,
      controlRpc: responder,
      relay: { host: "relay.test" },
      timeoutMs: 2_000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      opStream: { transport, ackIntervalMs: 20, silenceTimeoutMs: 120, reconnectHoldMs: 600 },
    });
    await expect(session.exec({ cmd: "must-not-start" })).rejects.toMatchObject({
      name: "SelfhostedControlError",
      code: ErrorCode.ERROR_CODE_STREAM,
      reason: "agent_reconnecting",
      retryable: true,
    });
    expect(responder.requests).toHaveLength(0);
  });

  test("op-stream transport failure does not take a second admission for fallback", async () => {
    const transport = new InMemoryOpStreamTransport();
    transport.available = false;
    const { MockAgentResponder } = await import("../src/sandbox/selfhosted/testing");
    const responder = new MockAgentResponder();
    let admissionReads = 0;
    const session = new SelfhostedSession({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "stale-constructor-instance",
      controlRpc: responder,
      relay: { host: "relay.test" },
      timeoutMs: 2_000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      resolveOperationAdmission: async () => {
        admissionReads += 1;
        return {
          connectionInstanceId: "admitted-instance",
          operationResourcePolicy: {
            memoryMaxBytes: 134_217_728,
            memoryHighBytes: null,
            cpuMaxMillicores: null,
            revision: 4,
          },
          operationResourcePolicySupported: true,
          operationCpuQuotaSupported: false,
          opStream: {
            transport,
            ackIntervalMs: 20,
            silenceTimeoutMs: 120,
            reconnectHoldMs: 600,
          },
        };
      },
    });

    await expect(session.exec({ cmd: "must-not-start" })).rejects.toMatchObject({
      name: "SelfhostedControlError",
      code: ErrorCode.ERROR_CODE_STREAM,
      reason: "agent_reconnecting",
      retryable: true,
    });
    expect(admissionReads).toBe(1);
    expect(responder.requests).toHaveLength(0);
  });

  test("revocation after a refused OpStart fences the proven-unstarted retry", async () => {
    const transport = new InMemoryOpStreamTransport();
    const runner = new FakeOpRunner({
      transport,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "connection-1",
    });
    runner.script("call_retry_revoke:0", {
      frames: [{ channel: "stdout", bytes: "must-not-run" }],
      drainingStarts: 1,
    });
    let authorized = true;
    let startDispatches = 0;
    const rpc: ControlRpc = {
      request: async (subject, request, opts) => {
        const response = await runner.request(subject, request, opts);
        if (request.op?.$case === "opStart") {
          startDispatches += 1;
          if (response.error?.code === ErrorCode.ERROR_CODE_DRAINING) authorized = false;
        }
        return response;
      },
    };
    const session = new SelfhostedSession({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "connection-1",
      controlRpc: rpc,
      relay: { host: "relay.test" },
      timeoutMs: 2_000,
      execTimeoutMs: 5_000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      resolveOperationAdmission: async () =>
        authorized
          ? {
              connectionInstanceId: "connection-1",
              operationResourcePolicy: {
                memoryMaxBytes: null,
                memoryHighBytes: null,
                cpuMaxMillicores: null,
                revision: 1,
              },
              operationResourcePolicySupported: true,
              operationCpuQuotaSupported: true,
              opStream: { transport },
            }
          : null,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");

    await expect(
      runWithToolCallCorrelation("call_retry_revoke", () => session.exec({ cmd: "must-not-run" })),
    ).rejects.toThrow(/authoritative live runner connection/iu);
    expect(startDispatches).toBe(1);
    expect(runner.runs.has("call_retry_revoke:0")).toBe(false);
  });

  test("revocation while the frame subscription is opening fences the initial OpStart", async () => {
    const transport = new InMemoryOpStreamTransport();
    const runner = new FakeOpRunner({
      transport,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "connection-1",
    });
    runner.script("call_subscribe_revoke:0", {
      frames: [{ channel: "stdout", bytes: "must-not-run" }],
    });
    let authorized = true;
    let startDispatches = 0;
    const subscribe = transport.subscribe.bind(transport);
    transport.subscribe = async (subject, onMessage) => {
      // Model a broker subscription that yields long enough for the exact
      // personal-machine authority to be revoked after initial admission.
      await Promise.resolve();
      authorized = false;
      return await subscribe(subject, onMessage);
    };
    const rpc: ControlRpc = {
      request: async (subject, request, opts) => {
        if (request.op?.$case === "opStart") startDispatches += 1;
        return await runner.request(subject, request, opts);
      },
    };
    const session = new SelfhostedSession({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "connection-1",
      controlRpc: rpc,
      relay: { host: "relay.test" },
      timeoutMs: 2_000,
      execTimeoutMs: 5_000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      resolveOperationAdmission: async () =>
        authorized
          ? {
              connectionInstanceId: "connection-1",
              operationResourcePolicy: {
                memoryMaxBytes: null,
                memoryHighBytes: null,
                cpuMaxMillicores: null,
                revision: 1,
              },
              operationResourcePolicySupported: true,
              operationCpuQuotaSupported: true,
              opStream: { transport },
            }
          : null,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");

    await expect(
      runWithToolCallCorrelation("call_subscribe_revoke", () =>
        session.exec({ cmd: "must-not-run" }),
      ),
    ).rejects.toThrow(/authoritative live runner connection/iu);
    expect(startDispatches).toBe(0);
    expect(runner.runs.has("call_subscribe_revoke:0")).toBe(false);
  });

  test("an OpStart protocol refusal never dispatches request-reply exec", async () => {
    const transport = new InMemoryOpStreamTransport();
    const { MockAgentResponder } = await import("../src/sandbox/selfhosted/testing");
    const fallback = new MockAgentResponder();
    const runner = new FakeOpRunner({
      transport,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "connection-1",
    });
    runner.script("call_fallback_revoke:0", {
      frames: [],
      startError: {
        code: ErrorCode.ERROR_CODE_PROTOCOL,
        message: "old runner",
        retryable: false,
        detail: {},
      },
    });
    let startDispatches = 0;
    const rpc: ControlRpc = {
      request: async (subject, request, opts) => {
        const response = await runner.request(subject, request, opts);
        if (request.op?.$case === "opStart") {
          startDispatches += 1;
        }
        return response;
      },
    };
    const session = new SelfhostedSession({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "connection-1",
      controlRpc: rpc,
      relay: { host: "relay.test" },
      timeoutMs: 2_000,
      execTimeoutMs: 5_000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      resolveOperationAdmission: async () => ({
        connectionInstanceId: "connection-1",
        operationResourcePolicy: {
          memoryMaxBytes: null,
          memoryHighBytes: null,
          cpuMaxMillicores: null,
          revision: 1,
        },
        operationResourcePolicySupported: true,
        operationCpuQuotaSupported: true,
        opStream: { transport },
      }),
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");

    await expect(
      runWithToolCallCorrelation("call_fallback_revoke", () =>
        session.exec({ cmd: "must-not-run" }),
      ),
    ).rejects.toMatchObject({
      name: "SelfhostedControlError",
      code: ErrorCode.ERROR_CODE_UNSUPPORTED,
      retryable: false,
    });
    expect(startDispatches).toBe(1);
    expect(fallback.requests).toHaveLength(0);
  });

  test("unbounded exec fails without request-reply downgrade when the stream is unavailable", async () => {
    const transport = new InMemoryOpStreamTransport();
    transport.available = false;
    const { MockAgentResponder } = await import("../src/sandbox/selfhosted/testing");
    const responder = new MockAgentResponder();
    const session = new SelfhostedSession({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: CONNECTION_INSTANCE,
      controlRpc: responder,
      relay: { host: "relay.test" },
      timeoutMs: 2_000,
      execTimeoutMs: 0,
      opStream: { transport, ackIntervalMs: 20, silenceTimeoutMs: 120, reconnectHoldMs: 600 },
    });

    const error = await session.exec({ cmd: "must-not-start" }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({
      name: "SelfhostedControlError",
      code: ErrorCode.ERROR_CODE_STREAM,
      reason: "agent_reconnecting",
      retryable: true,
    });
    expect(responder.requests).toHaveLength(0);
  });

  test("a runner that refuses OpStart (protocol) is unsupported without fallback", async () => {
    const transport = new InMemoryOpStreamTransport();
    const { MockAgentResponder } = await import("../src/sandbox/selfhosted/testing");
    const responder = new MockAgentResponder();
    const runner = new FakeOpRunner({
      transport,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "connection-test",
    });
    runner.script("call_old:0", {
      frames: [],
      startError: {
        code: 7, // ERROR_CODE_PROTOCOL — an old runner: "ControlRequest carried no op"
        message: "ControlRequest carried no op",
        retryable: false,
        detail: {},
      },
    });
    const session = new SelfhostedSession({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: "connection-test",
      controlRpc: runner,
      relay: { host: "relay.test" },
      timeoutMs: 2_000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      opStream: { transport, ackIntervalMs: 20, silenceTimeoutMs: 120, reconnectHoldMs: 600 },
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    await expect(
      runWithToolCallCorrelation("call_old", () => session.exec({ cmd: "must-not-start" })),
    ).rejects.toMatchObject({
      name: "SelfhostedControlError",
      code: ErrorCode.ERROR_CODE_UNSUPPORTED,
      retryable: false,
    });
    expect(responder.requests).toHaveLength(0);
  });

  test("non-tool exec (no correlation context) still streams under an anonymous id", async () => {
    const { runner, session } = buildRig();
    // No script is registered for an anon id we cannot predict — so instead
    // assert the OTHER direction: the exec reaches the fake runner as an
    // opStart whose id is NOT correlation-shaped, and the typed no-script
    // refusal (PROTOCOL) becomes a typed unsupported result. Unique anon ids
    // still never collide with durable tool-call ids.
    runner.script("unused", { frames: [] });
    const error = await session.exec({ cmd: "anon" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      name: "SelfhostedControlError",
      code: ErrorCode.ERROR_CODE_UNSUPPORTED,
      retryable: false,
    });
  });
});
