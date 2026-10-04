// Unit tests for the op-stream exec client through the REAL SelfhostedSession
// surface (exec() with deps.opStream injected), against the scripted fake
// runner (op-testing.ts). The Rust harness proves the runner half; these prove
// the CLIENT half: reassembly, heals, ack policy, fault taxonomy, rendering
// parity, and the durable-before-wire-ack ordering.

import { describe, expect, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { shell } from "@openai/agents/sandbox";
import { ErrorCode, ExecRequest, OpChannel, type ControlRequest } from "@opengeni/agent-proto";
import type { ControlRpc } from "../src/sandbox/selfhosted/control-rpc";
import type { SelfhostedOpObservation } from "../src/sandbox/selfhosted/op-observer";
import { FakeOpRunner, InMemoryOpStreamTransport } from "../src/sandbox/selfhosted/op-testing";
import { SelfhostedSession } from "../src/sandbox/selfhosted/session";
import {
  OpStreamExecClient,
  OP_STREAM_DEFAULT_WINDOW_BYTES,
  type OpStreamJournal,
  type OpStreamOutputFrame,
} from "../src/sandbox/selfhosted/op-stream";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";
import { executeCommandReadWithRefresh } from "../src/command-read-refresh";

const WORKSPACE = "ws-1";
const AGENT = "agent-1";
const CONNECTION_INSTANCE = "connection-test";
const WORKSPACE_ROOT = "/home/user/project";

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
    captureBackgroundCommandOutput?: (
      commandId: string,
      frames: OpStreamOutputFrame[],
    ) => Promise<void>;
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
    workspaceRoot: WORKSPACE_ROOT,
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
    ...(opts.captureBackgroundCommandOutput
      ? { captureBackgroundCommandOutput: opts.captureBackgroundCommandOutput }
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
  for (const failureCode of ["OP_OVERFLOW", "OP_PIPE_IO", "OP_SPOOL_IO", ""]) {
    test(`owner refresh preserves terminal classification with zero exit: ${failureCode || "normal"}`, async () => {
      const events: string[] = [];
      const settlements: unknown[] = [];
      const { runner, session } = buildRig({
        adoptBackgroundCommand: async () => ({ commandId: "typed-terminal" }),
        captureBackgroundCommandOutput: async (_id, frames) => {
          if (frames.length) events.push("capture");
        },
        settleBackgroundCommand: async (value) => {
          events.push("settle");
          settlements.push(value);
        },
      });
      runner.script("typed_terminal:0", {
        live: true,
        holdUntilCancel: true,
        frames: [{ channel: "stdout", bytes: "retained-prefix" }],
        exit: { exitCode: 0, failureCode, failureDetail: { retained_bytes: "268435456" } },
      });
      const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
      await runWithToolCallCorrelation("typed_terminal", () =>
        session.execCommand({ cmd: "work", yieldTimeMs: 1 }),
      );
      runner.runs.get("typed_terminal:0")!.script.holdUntilCancel = false;
      if (failureCode) {
        await expect(
          executeCommandReadWithRefresh({
            toolName: "command_read",
            args: { commandId: "typed-terminal" },
            refresh: (id) => session.refreshOwnedCommand(id),
            call: async () => ({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    commandId: "typed-terminal",
                    terminal: false,
                    chunks: [],
                    hasMore: false,
                  }),
                },
              ],
            }),
          }),
        ).rejects.toMatchObject({
          name: "SelfhostedControlError",
          code:
            failureCode === "OP_OVERFLOW"
              ? ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE
              : ErrorCode.ERROR_CODE_STREAM,
          retryable: false,
          payloadTooLarge: failureCode === "OP_OVERFLOW",
          detail: { failure_code: failureCode, retained_bytes: "268435456" },
        });
      } else {
        expect(await session.refreshOwnedCommand("typed-terminal")).toBe(true);
      }
      expect(events).toEqual(["capture", "settle"]);
      expect(settlements).toEqual([
        expect.objectContaining({
          outcome: "exited",
          exitCode: 0,
          reason: failureCode ? `op_failure_${failureCode}` : "op_exit",
        }),
      ]);
      expect(await session.refreshOwnedCommand("typed-terminal")).toBe(false);
    });
  }

  for (const corruptDigest of [false, true]) {
    test(`running reads bound replay, detach before capture, and preserve UTF-8/integrity (corrupt=${corruptDigest})`, async () => {
      const { runner, transport, session } = buildRig({
        adoptBackgroundCommand: async () => ({ commandId: "bounded-read" }),
      });
      const bytes = new TextEncoder().encode("🙂" + "x".repeat(128 * 1024));
      runner.script("bounded_read:0", {
        live: true,
        holdUntilCancel: true,
        frames: [
          { channel: "stdout", bytes: bytes.slice(0, 2) },
          { channel: "stdout", bytes: bytes.slice(2) },
        ],
      });
      const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
      await runWithToolCallCorrelation("bounded_read", () =>
        session.execCommand({ cmd: "work", yieldTimeMs: 1 }),
      );
      const run = runner.runs.get("bounded_read:0")!;
      // The fake's retained log grows in stages, as a real still-running child does.
      const allFrames = [...run.frames];
      run.liveEmitted = true;
      run.frames = allFrames.slice(0, 1);
      const fromSeqs: string[] = [];
      let delivered = 0;
      let activeSubscriptions = 0;
      let expectDetached = true;
      const reader = new OpStreamExecClient({
        workspaceId: WORKSPACE,
        agentId: AGENT,
        connectionInstanceId: CONNECTION_INSTANCE,
        epoch: 0,
        rpcSubject: `agent.${WORKSPACE}.${AGENT}.connection.${CONNECTION_INSTANCE}.rpc`,
        controlRpc: {
          request: async (subject, request, opts) => {
            if (request.op?.$case === "opAttach") fromSeqs.push(request.op.opAttach.fromSeq);
            return runner.request(subject, request, opts);
          },
        },
        transport: {
          subscribe: async (subject, handler) => {
            const subscription = await transport.subscribe(subject, (payload) => {
              delivered++;
              handler(payload);
            });
            activeSubscriptions++;
            return {
              unsubscribe: () => {
                activeSubscriptions--;
                subscription.unsubscribe();
              },
            };
          },
          publish: (subject, payload) => transport.publish(subject, payload),
        },
        controlTimeoutMs: 1000,
        ackIntervalMs: 2,
        retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      });
      const captured: OpStreamOutputFrame[] = [];
      const capture = async (frames: OpStreamOutputFrame[]) => {
        if (expectDetached) expect(activeSubscriptions).toBe(0);
        captured.push(...frames);
      };
      expect(await reader.readExisting("bounded_read:0", 1, capture)).toMatchObject({
        status: "running",
        replaySequence: "1",
      });
      expect(captured).toEqual([]); // split UTF-8 prefix lives in the checkpoint decoder
      for (let i = 0; i < 5; i++) await reader.readExisting("bounded_read:0", 1, capture);
      expect(fromSeqs).toEqual(["0", "1", "1", "1", "1", "1"]);
      expect(delivered).toBe(1);
      run.frames = allFrames.slice(0, 2);
      await expect(
        reader.readExisting("bounded_read:0", 1, async () => {
          throw new Error("persistence failed");
        }),
      ).rejects.toThrow("persistence failed");
      await reader.readExisting("bounded_read:0", 1, capture);
      expect(fromSeqs.at(-1)).toBe("0");
      expect(captured.map((frame) => frame.chunk).join("")).toBe(new TextDecoder().decode(bytes));
      const afterCapture = delivered;
      for (let i = 0; i < 5; i++) await reader.readExisting("bounded_read:0", 1, capture);
      expect(delivered).toBe(afterCapture);
      expect(captured).toHaveLength(1);
      // No new bytes in this attachment: periodic credit must not include the
      // retained prefix counted by the integrity checkpoint.
      const priorAcks = transport.decodedAcks().length;
      await reader.readExisting("bounded_read:0", 20, capture);
      const currentAcks = transport
        .decodedAcks()
        .slice(priorAcks)
        .filter((ack) => BigInt(ack.creditBytes) < 1_000_000_000n);
      expect(currentAcks.length).toBeGreaterThan(0);
      expect(
        currentAcks.every((ack) => ack.creditBytes === String(OP_STREAM_DEFAULT_WINDOW_BYTES)),
      ).toBe(true);
      run.frames = allFrames;
      expectDetached = false;
      if (corruptDigest) {
        const originalDigest = run.exit.digests.stdout!;
        run.exit.digests.stdout = "invalid";
        await expect(reader.readExisting("bounded_read:0", 100, capture)).rejects.toThrow(
          "digest mismatch",
        );
        expect(captured).toHaveLength(1);
        run.exit.digests.stdout = originalDigest;
      }
      expect((await reader.readExisting("bounded_read:0", 100, capture)).status).toBe("completed");
      expect(fromSeqs.at(-1)).toBe(corruptDigest ? "0" : "2");
      expect(captured).toHaveLength(corruptDigest ? 2 : 1);
      expect(transport.decodedAcks().every((ack) => !ack.final && ack.ackedSeq === "0")).toBe(true);
    });
  }

  test("a failure racing adoption is captured and settled as failure, never foreground success", async () => {
    const events: string[] = [];
    const settlements: unknown[] = [];
    let session!: SelfhostedSession;
    const rig = buildRig({
      adoptBackgroundCommand: async ({ opId }) => {
        await session.cancelExecCommand(opId);
        return { commandId: "raced-failure" };
      },
      captureBackgroundCommandOutput: async (_id, frames) => {
        if (frames.length) events.push("capture");
      },
      settleBackgroundCommand: async (value) => {
        events.push("settle");
        settlements.push(value);
      },
    });
    session = rig.session;
    rig.runner.script("raced_failure:0", {
      live: true,
      holdUntilCancel: true,
      frames: [{ channel: "stdout", bytes: "partial" }],
      exit: { failureCode: "OP_OVERFLOW", failureDetail: { retained_bytes: "7" } },
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    const result = await runWithToolCallCorrelation("raced_failure", () =>
      session.execCommand({ cmd: "work", yieldTimeMs: 1 }),
    );
    expect(result).toContain("command ID raced-failure");
    expect(events).toEqual(["capture", "settle"]);
    expect(settlements).toEqual([
      expect.objectContaining({ outcome: "exited", reason: "op_failure_OP_OVERFLOW" }),
    ]);
  });

  test("owner read uses a fresh attach after the reaper and stale consumers cannot replay", async () => {
    const captured: string[] = [];
    const settled: string[] = [];
    const { runner, transport, session, requests } = buildRig({
      journal: { attachGeneration: () => "7", persistSettled: () => {} },
      adoptBackgroundCommand: async () => ({ commandId: "owner-after-reaper" }),
      captureBackgroundCommandOutput: async (_id, frames) => {
        captured.push(...frames.map((frame) => frame.chunk));
      },
      settleBackgroundCommand: async ({ commandId }) => {
        settled.push(commandId);
      },
    });
    runner.script("after_reaper:0", {
      frames: [
        { channel: "stdout", bytes: "prefix" },
        { channel: "stderr", bytes: "tail" },
      ],
      live: true,
      holdUntilCancel: true,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    await runWithToolCallCorrelation("after_reaper", () =>
      session.execCommand({ cmd: "work", yieldTimeMs: 1 }),
    );
    const run = runner.runs.get("after_reaper:0")!;
    expect(run.highestGeneration).toBe(7n);
    const rpcSubject = `agent.${WORKSPACE}.${AGENT}.connection.${CONNECTION_INSTANCE}.rpc`;
    const reaper = new OpStreamExecClient({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: CONNECTION_INSTANCE,
      epoch: 0,
      rpcSubject,
      controlRpc: runner,
      transport,
      controlTimeoutMs: 1000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      journal: { attachGeneration: () => String(Date.now()), persistSettled: () => {} },
    });
    expect((await reaper.readExisting("after_reaper:0", 5, async () => {})).status).toBe("running");
    const reaperGeneration = run.highestGeneration;
    expect(reaperGeneration).toBeGreaterThan(7n);
    // Output becomes available after the reaper left. A stale launch-generation
    // attach must NOT trigger live emission or replay, just as in Rust.
    run.script.holdUntilCancel = false;
    for (const attachGeneration of ["0", "7"]) {
      await runner.request(
        rpcSubject,
        {
          requestId: crypto.randomUUID(),
          epoch: 0,
          op: {
            $case: "opAttach",
            opAttach: {
              opId: "after_reaper:0",
              fromSeq: "0",
              attachGeneration,
              windowBytes: "65536",
            },
          },
        },
        { timeoutMs: 1000 },
      );
      expect(run.liveEmitted).toBe(false);
      expect(run.highestGeneration).toBe(reaperGeneration);
    }
    expect(await session.refreshOwnedCommand("owner-after-reaper")).toBe(true);
    expect(captured).toEqual(["prefix", "tail"]);
    expect(settled).toEqual(["owner-after-reaper"]);
    expect(run.highestGeneration).toBeGreaterThanOrEqual(reaperGeneration);
    const ownerAttaches = requests.filter((request) => request.op?.$case === "opAttach");
    expect(ownerAttaches).toHaveLength(2);
    expect(run.startCount).toBe(1);
    expect(run.exit.cancelled).toBe(false);
    await session.finalizeOpStreamOps(["after_reaper"]);
    await session.finalizeOpStreamOps();
    expect(run.finalAcked).toBe(false);
  });

  test("live owner refresh attaches to adopted command and persists before terminal settlement", async () => {
    const events: string[] = [];
    const { runner, session, requests } = buildRig({
      adoptBackgroundCommand: async () => ({ commandId: "owned-refresh" }),
      captureBackgroundCommandOutput: async (_id, frames) => {
        if (frames.length) events.push("capture");
      },
      settleBackgroundCommand: async () => {
        events.push("settle");
      },
    });
    runner.script("owner_refresh:0", {
      frames: [{ channel: "stdout", bytes: "retained-tail" }],
      live: true,
      holdUntilCancel: true,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    await runWithToolCallCorrelation("owner_refresh", () =>
      session.execCommand({ cmd: "work", yieldTimeMs: 1 }),
    );
    expect(await session.refreshOwnedCommand("other-owner")).toBe(false);
    // Simulate an independently requested stop, then read its durable replay.
    await session.cancelExecCommand("owner_refresh:0");
    events.length = 0;
    const before = requests.length;
    await Promise.all([
      session.refreshOwnedCommand("owned-refresh"),
      session.refreshOwnedCommand("owned-refresh"),
    ]);
    expect(events).toEqual(["capture", "settle"]);
    expect(requests.slice(before).map((request) => request.op?.$case)).not.toContain("opStart");
    expect(requests.slice(before).map((request) => request.op?.$case)).not.toContain("opCancel");
    expect(await session.refreshOwnedCommand("owned-refresh")).toBe(false);
  });

  test("attach-only command reads replay exact UTF-8 frames without starting, cancelling, or final-acking", async () => {
    const { runner, transport, session } = buildRig({
      adoptBackgroundCommand: async () => ({ commandId: "live-command" }),
    });
    const bytes = new TextEncoder().encode("🙂done");
    runner.script("read_existing:0", {
      frames: [
        { channel: "stdout", bytes: bytes.slice(0, 2) },
        { channel: "stdout", bytes: bytes.slice(2) },
        { channel: "stderr", bytes: "warning" },
      ],
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    await runWithToolCallCorrelation("read_existing", () => session.execCommand({ cmd: "work" }));
    const calls: string[] = [];
    let replayDelayMs = 0;
    const reader = new OpStreamExecClient({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: CONNECTION_INSTANCE,
      epoch: 0,
      rpcSubject: `agent.${WORKSPACE}.${AGENT}.connection.${CONNECTION_INSTANCE}.rpc`,
      controlRpc: {
        request: async (subject, request, opts) => {
          calls.push(request.op?.$case ?? "none");
          return await runner.request(subject, request, opts);
        },
      },
      transport: {
        subscribe: async (subject, handler) =>
          transport.subscribe(subject, (payload) => {
            if (replayDelayMs) setTimeout(() => handler(payload), replayDelayMs);
            else handler(payload);
          }),
        publish: (subject, payload) => transport.publish(subject, payload),
      },
      controlTimeoutMs: 1000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
    });
    const pages: OpStreamOutputFrame[][] = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(
        (
          await reader.readExisting("read_existing:0", 5, async (frames) => {
            pages.push(frames);
          })
        ).status,
      ).toBe("completed");
    }
    expect(pages[0]).toEqual(pages[1]);
    expect(pages[0]!.map((frame) => frame.chunk).join("")).toBe("🙂donewarning");
    expect(calls).not.toContain("opStart");
    expect(calls).not.toContain("opCancel");
    replayDelayMs = 350;
    const partial = await reader.readExisting("read_existing:0", 250, async () => {});
    expect(partial.status).toBe("running");
    expect("terminal" in partial && partial.terminal).toBeFalsy();
    const delayedFrames: OpStreamOutputFrame[] = [];
    const complete = await reader.readExisting("read_existing:0", 1000, async (frames) => {
      delayedFrames.push(...frames);
    });
    expect(complete.status).toBe("completed");
    expect(delayedFrames.map((frame) => frame.chunk).join("")).toBe("🙂donewarning");
    replayDelayMs = 0;
    const exit = runner.runs.get("read_existing:0")!.exit;
    const originalDigest = exit.digests.stdout;
    exit.digests.stdout = "invalid";
    const invalidFrames: OpStreamOutputFrame[] = [];
    await expect(
      reader.readExisting("read_existing:0", 1000, async (frames) => {
        invalidFrames.push(...frames);
      }),
    ).rejects.toThrow("digest mismatch");
    expect(invalidFrames).toEqual([]);
    exit.digests.stdout = originalDigest!;
    expect(runner.runs.get("read_existing:0")!.startCount).toBe(1);
    expect(transport.decodedAcks().some((ack) => ack.final)).toBe(false);
    await expect(reader.readExisting("missing", 5, async () => {})).rejects.toThrow();
    expect(calls).not.toContain("opStart");
    runner.script("read_live:0", { frames: [], live: true, holdUntilCancel: true });
    await runWithToolCallCorrelation("read_live", () =>
      session.execCommand({ cmd: "live", yieldTimeMs: 0 }),
    );
    expect((await reader.readExisting("read_live:0", 5, async () => {})).status).toBe("running");
    expect(runner.runs.get("read_live:0")!.exit.cancelled).toBe(false);
    expect(calls).not.toContain("opStart");
    expect(calls).not.toContain("opCancel");
  });

  for (const path of ["replay", "adoption"] as const) {
    for (const channel of ["stdout", "stderr"] as const) {
      for (const missing of ["digest", "blank digest", "total"] as const) {
        test(`${path} retains output when ${channel} exit ${missing} is missing`, async () => {
          const { runner, transport } = buildRig();
          const opId = `integrity_${path}_${channel}_${missing.replaceAll(" ", "_")}`;
          runner.script(opId, {
            frames: [
              { channel: "stdout", bytes: "original-output" },
              { channel: "stderr", bytes: "original-error" },
            ],
            ...(path === "adoption" ? { live: true, holdUntilCancel: true } : {}),
          });
          const captures: OpStreamOutputFrame[] = [];
          const client = new OpStreamExecClient({
            workspaceId: WORKSPACE,
            agentId: AGENT,
            connectionInstanceId: CONNECTION_INSTANCE,
            epoch: 0,
            rpcSubject: `agent.${WORKSPACE}.${AGENT}.connection.${CONNECTION_INSTANCE}.rpc`,
            controlRpc: runner,
            transport,
            controlTimeoutMs: 1000,
            retryClock: { sleep: async () => {}, jitter: () => 0.5 },
          });
          const exec = ExecRequest.create({ command: ["work"], shell: true });
          if (path === "replay") {
            await runner.request(
              `agent.${WORKSPACE}.${AGENT}.connection.${CONNECTION_INSTANCE}.rpc`,
              {
                requestId: opId,
                epoch: 0,
                resourcePolicy: undefined,
                op: {
                  $case: "opStart",
                  opStart: {
                    op: { $case: "exec", exec },
                    windowBytes: "65536",
                    deadlineMs: "0",
                    originId: "synthetic-retained-command",
                  },
                },
              },
              { timeoutMs: 1000 },
            );
          }
          let restoreIntegrity!: () => void;
          const removeIntegrity = () => {
            const run = runner.runs.get(opId)!;
            const exit = run.exit;
            const digest = exit.digests[channel]!;
            const total = exit.totals[channel]!;
            const data = run.frames.find(
              (frame) =>
                frame.body?.$case === "data" &&
                frame.body.data.channel ===
                  (channel === "stdout"
                    ? OpChannel.OP_CHANNEL_STDOUT
                    : OpChannel.OP_CHANNEL_STDERR),
            )!.body!;
            if (data.$case !== "data") throw new Error("missing synthetic output");
            const original = data.data.bytes;
            // Equal-length corruption would evade the remaining byte-count check.
            if (missing !== "total") {
              data.data.bytes = new TextEncoder().encode(
                channel === "stdout" ? "modified-output" : "modified-error",
              );
            }
            restoreIntegrity = () => {
              exit.digests[channel] = digest;
              exit.totals[channel] = total;
              data.data.bytes = original;
            };
            if (missing === "total") delete exit.totals[channel];
            else if (missing === "digest") delete exit.digests[channel];
            else exit.digests[channel] = "";
          };
          const capture = async (frames: OpStreamOutputFrame[]) => {
            captures.push(...frames);
          };
          if (path === "replay") removeIntegrity();
          const read =
            path === "replay"
              ? client.readExisting(opId, 100, capture)
              : client.execWithYield(opId, exec, 1000, 2000, {
                  yieldMs: 1,
                  onYield: async () => {
                    removeIntegrity();
                    await client.cancel(opId);
                  },
                  captureOutput: capture,
                });
          await expect(read).rejects.toMatchObject({
            name: "SelfhostedControlError",
            code: ErrorCode.ERROR_CODE_PROTOCOL,
            retryable: false,
          });
          expect(captures).toEqual([]);
          expect(runner.runs.get(opId)!.finalAcked).toBe(false);
          expect(transport.decodedAcks().some((ack) => ack.final)).toBe(false);
          await client.finalizeSettledOps();
          expect(runner.runs.get(opId)!.finalAcked).toBe(false);
          restoreIntegrity();
          const recovered = await client.readExisting(opId, 100, capture);
          expect(recovered.status).toBe("completed");
          expect(captures.map((frame) => frame.chunk).join("")).toBe(
            "original-outputoriginal-error",
          );
          expect(recovered.outputReceipt).toBeDefined();
          expect(await client.releaseCapturedOutput(opId, recovered.outputReceipt!)).toBe(
            "published",
          );
          expect(runner.runs.get(opId)!.finalAcked).toBe(true);
          expect(runner.runs.get(opId)!.startCount).toBe(1);
        });
      }
    }
  }

  test("adoption captures output with its durable UUID even when exit races the adoption transaction", async () => {
    const saved: { commandId: string; frames: OpStreamOutputFrame[] }[] = [];
    let session!: SelfhostedSession;
    const rig = buildRig({
      adoptBackgroundCommand: async ({ opId }) => {
        await session.cancelExecCommand(opId);
        return { commandId: "captured-command" };
      },
      captureBackgroundCommandOutput: async (commandId, frames) => {
        saved.push({ commandId, frames });
      },
    });
    session = rig.session;
    rig.runner.script("capture_adoption:0", {
      frames: [{ channel: "stdout", bytes: "retained" }],
      live: true,
      holdUntilCancel: true,
    });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    await runWithToolCallCorrelation("capture_adoption", () =>
      session.execCommand({ cmd: "work", yieldTimeMs: 1 }),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]!.commandId).toBe("captured-command");
    expect(saved[0]!.frames.map((frame) => frame.chunk).join("")).toBe("retained");
  });

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

  test("exit during adoption settles the adopted command and returns only its receipt", async () => {
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

    expect(result).toContain("Command running in background");
    expect(result).toContain("command ID 22222222-2222-4222-8222-222222222222");
    expect(result).not.toContain("Process exited with code -1");
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

  test("fast-settlement failure still returns only the adopted command receipt", async () => {
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

    expect(result).toContain("Command running in background");
    expect(result).toContain("command ID 33333333-3333-4333-8333-333333333333");
    expect(result).not.toContain("Process exited with code -1");
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
      workspaceRoot: WORKSPACE_ROOT,
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
        workspaceRoot: WORKSPACE_ROOT,
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

  test("a durable tool result releases only its own sub-ops, preserving parallel and setup output", async () => {
    const { runner, session, transport } = buildRig();
    for (const opId of ["call_first:0", "call_first:1", "call_second:0"]) {
      runner.script(opId, { frames: [{ channel: "stdout", bytes: opId }] });
    }
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    await Promise.all([
      runWithToolCallCorrelation("call_first", async () => {
        await session.exec({ cmd: "first sub-op" });
        await session.exec({ cmd: "second sub-op" });
      }),
      runWithToolCallCorrelation("call_second", () => session.exec({ cmd: "parallel" })),
    ]);
    const request = runner.request.bind(runner);
    runner.request = async (subject, input, options) => {
      if (input.op?.$case === "opStart" && input.requestId.startsWith("anon_")) {
        runner.script(input.requestId, { frames: [{ channel: "stdout", bytes: "setup" }] });
      }
      return request(subject, input, options);
    };
    await session.exec({ cmd: "setup without a tool call" });
    const setupOpId = [...runner.runs.keys()].find((id) => id.startsWith("anon_"))!;

    await session.finalizeOpStreamOps([]);
    expect(transport.decodedAcks().filter((ack) => ack.final)).toEqual([]);
    await session.finalizeOpStreamOps(["call_first"]);
    expect(runner.runs.get("call_first:0")?.finalAcked).toBe(true);
    expect(runner.runs.get("call_first:1")?.finalAcked).toBe(true);
    expect(runner.runs.get("call_second:0")?.finalAcked).toBe(false);
    expect(runner.runs.get(setupOpId)?.finalAcked).toBe(false);

    await session.finalizeOpStreamOps(["call_second"]);
    expect(runner.runs.get("call_second:0")?.finalAcked).toBe(true);
    expect(runner.runs.get(setupOpId)?.finalAcked).toBe(false);
    await session.finalizeOpStreamOps();
    expect(runner.runs.get(setupOpId)?.finalAcked).toBe(true);
    expect(transport.decodedAcks().filter((ack) => ack.final)).toHaveLength(4);
  });

  test("durable result scope uses the original call id, not a sanitized op-id prefix", async () => {
    const { runner, session } = buildRig();
    const { runWithToolCallCorrelation, sanitizeOpIdToken } =
      await import("../src/sandbox/op-correlation");
    const callId = "call.with.punctuation";
    const opId = `${sanitizeOpIdToken(callId)}:0`;
    runner.script(opId, { frames: [{ channel: "stdout", bytes: "retained result" }] });
    await runWithToolCallCorrelation(callId, () => session.exec({ cmd: "work" }));
    await session.finalizeOpStreamOps([sanitizeOpIdToken(callId)]);
    expect(runner.runs.get(opId)?.finalAcked).toBe(false);
    await session.finalizeOpStreamOps([callId]);
    expect(runner.runs.get(opId)?.finalAcked).toBe(true);
  });

  test("failed journal persistence retains the frontier for a later durable-result hook", async () => {
    let rejectPersistence = true;
    const persisted: string[] = [];
    const { runner, session, transport } = buildRig({
      journal: {
        attachGeneration: () => "11",
        persistSettled: (opId) => {
          if (rejectPersistence) throw new Error("journal unavailable");
          persisted.push(opId);
        },
      },
    });
    runner.script("call_journal:0", { frames: [{ channel: "stdout", bytes: "preserve" }] });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    await runWithToolCallCorrelation("call_journal", () => session.exec({ cmd: "work" }));
    await expect(session.finalizeOpStreamOps(["call_journal"])).rejects.toThrow(
      "journal unavailable",
    );
    expect(runner.runs.get("call_journal:0")?.finalAcked).toBe(false);
    expect(transport.decodedAcks().filter((ack) => ack.final)).toEqual([]);

    rejectPersistence = false;
    await session.finalizeOpStreamOps(["call_journal"]);
    expect(persisted).toEqual(["call_journal:0"]);
    expect(transport.decodedAcks().filter((ack) => ack.final)).toMatchObject([
      { opId: "call_journal:0", attachGeneration: "11" },
    ]);
    await session.finalizeOpStreamOps();
    expect(transport.decodedAcks().filter((ack) => ack.final)).toHaveLength(1);
  });

  test("a finalization boundary never consumes an op that settles during journal I/O", async () => {
    let journalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      journalStarted = resolve;
    });
    let releaseJournal!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseJournal = resolve;
    });
    const { runner, session } = buildRig({
      journal: {
        attachGeneration: () => "13",
        persistSettled: async () => {
          journalStarted();
          await blocked;
        },
      },
    });
    for (const opId of ["call_durable:0", "call_later:0"]) {
      runner.script(opId, { frames: [{ channel: "stdout", bytes: opId }] });
    }
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    await runWithToolCallCorrelation("call_durable", () => session.exec({ cmd: "first" }));
    const finalization = session.finalizeOpStreamOps();
    await started;
    try {
      await runWithToolCallCorrelation("call_later", () => session.exec({ cmd: "later" }));
    } finally {
      releaseJournal();
    }
    await finalization;
    expect(runner.runs.get("call_durable:0")?.finalAcked).toBe(true);
    expect(runner.runs.get("call_later:0")?.finalAcked).toBe(false);
    await session.finalizeOpStreamOps(["call_later"]);
    expect(runner.runs.get("call_later:0")?.finalAcked).toBe(true);
  });

  test("a failed wire final ACK remains retryable without repeating command execution", async () => {
    const { runner, session, transport } = buildRig();
    runner.script("call_wire:0", { frames: [{ channel: "stdout", bytes: "once" }] });
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    await runWithToolCallCorrelation("call_wire", () => session.exec({ cmd: "work" }));
    transport.available = false;
    await session.finalizeOpStreamOps(["call_wire"]);
    expect(runner.runs.get("call_wire:0")?.finalAcked).toBe(false);
    transport.available = true;
    await session.finalizeOpStreamOps(["call_wire"]);
    expect(runner.runs.get("call_wire:0")?.finalAcked).toBe(true);
    expect(runner.runs.size).toBe(1);
  });

  test("overlapping durability hooks serialize journal writes and final-ack each op once", async () => {
    let journalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      journalStarted = resolve;
    });
    let releaseJournal!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseJournal = resolve;
    });
    const persisted: string[] = [];
    const { runner, session, transport } = buildRig({
      journal: {
        attachGeneration: () => "17",
        persistSettled: async (opId) => {
          persisted.push(opId);
          if (persisted.length === 1) {
            journalStarted();
            await blocked;
          }
        },
      },
    });
    for (const opId of ["call_overlap_first:0", "call_overlap_second:0"]) {
      runner.script(opId, { frames: [{ channel: "stdout", bytes: opId }] });
    }
    const { runWithToolCallCorrelation } = await import("../src/sandbox/op-correlation");
    await Promise.all([
      runWithToolCallCorrelation("call_overlap_first", () => session.exec({ cmd: "first" })),
      runWithToolCallCorrelation("call_overlap_second", () => session.exec({ cmd: "second" })),
    ]);
    const first = session.finalizeOpStreamOps(["call_overlap_first"]);
    await started;
    const completeBoundary = session.finalizeOpStreamOps();
    expect(persisted).toEqual(["call_overlap_first:0"]);
    expect(transport.decodedAcks().filter((ack) => ack.final)).toEqual([]);
    releaseJournal();
    await Promise.all([first, completeBoundary]);
    expect(persisted).toEqual(["call_overlap_first:0", "call_overlap_second:0"]);
    expect(transport.decodedAcks().filter((ack) => ack.final)).toMatchObject([
      { opId: "call_overlap_first:0", attachGeneration: "17" },
      { opId: "call_overlap_second:0", attachGeneration: "17" },
    ]);
    expect(runner.runs.get("call_overlap_first:0")?.startCount).toBe(1);
    expect(runner.runs.get("call_overlap_second:0")?.startCount).toBe(1);
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
      workspaceRoot: WORKSPACE_ROOT,
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
      workspaceRoot: WORKSPACE_ROOT,
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
          workspaceRoot: WORKSPACE_ROOT,
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
      workspaceRoot: WORKSPACE_ROOT,
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
              workspaceRoot: WORKSPACE_ROOT,
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
      workspaceRoot: WORKSPACE_ROOT,
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
              workspaceRoot: WORKSPACE_ROOT,
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
      workspaceRoot: WORKSPACE_ROOT,
      agentId: AGENT,
      connectionInstanceId: "connection-1",
      controlRpc: rpc,
      relay: { host: "relay.test" },
      timeoutMs: 2_000,
      execTimeoutMs: 5_000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      resolveOperationAdmission: async () => ({
        connectionInstanceId: "connection-1",
        workspaceRoot: WORKSPACE_ROOT,
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
      workspaceRoot: WORKSPACE_ROOT,
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
      workspaceRoot: WORKSPACE_ROOT,
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

async function retainedOutputRig() {
  const { runner, transport } = buildRig();
  const opId = "captured-output:0";
  const rpcSubject = `agent.${WORKSPACE}.${AGENT}.connection.${CONNECTION_INSTANCE}.rpc`;
  runner.script(opId, { frames: [{ channel: "stdout", bytes: "retained output" }] });
  await runner.request(
    rpcSubject,
    {
      requestId: opId,
      epoch: 0,
      op: {
        $case: "opStart",
        opStart: {
          op: { $case: "exec", exec: ExecRequest.fromPartial({ command: ["synthetic"] }) },
          windowBytes: "65536",
          deadlineMs: "0",
          originId: "synthetic-session",
        },
      },
    },
    { timeoutMs: 1000 },
  );
  const requests: ControlRequest[] = [];
  let generation = "1";
  const makeReader = () =>
    new OpStreamExecClient({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: CONNECTION_INSTANCE,
      epoch: 0,
      rpcSubject,
      transport,
      controlRpc: {
        request: async (subject, request, options) => {
          requests.push(request);
          return runner.request(subject, request, options);
        },
      },
      controlTimeoutMs: 1000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      journal: {
        attachGeneration: () => generation,
        persistSettled: () => {
          throw new Error("Output custody must not use the foreground journal");
        },
      },
    });
  return {
    runner,
    transport,
    opId,
    requests,
    makeReader,
    setGeneration: (value: string) => {
      generation = value;
    },
  };
}

test("captured-output receipt waits for persistence and never publishes a final ACK by reading", async () => {
  const rig = await retainedOutputRig();
  const reader = rig.makeReader();
  let capturing!: () => void;
  const captureStarted = new Promise<void>((resolve) => {
    capturing = resolve;
  });
  let persist!: () => void;
  const persisted = new Promise<void>((resolve) => {
    persist = resolve;
  });
  let returned = false;
  const reading = reader
    .readExisting(rig.opId, 1000, async () => {
      capturing();
      await persisted;
    })
    .then((result) => {
      returned = true;
      return result;
    });
  await captureStarted;
  expect(returned).toBe(false);
  expect(rig.transport.decodedAcks().some((ack) => ack.final)).toBe(false);
  persist();
  const result = await reading;
  expect(result.outputReceipt).toMatchObject({ exitSeq: "2" });
  expect(rig.runner.runs.get(rig.opId)!.finalAcked).toBe(false);
  await reader.finalizeSettledOps();
  expect(rig.runner.runs.get(rig.opId)!.finalAcked).toBe(false);
});

test("a new output releaser retries the persisted exact receipt after publisher failure without replay or restart", async () => {
  const rig = await retainedOutputRig();
  const captured = await rig.makeReader().readExisting(rig.opId, 1000, async () => {});
  const receipt = captured.outputReceipt!;
  rig.transport.available = false;
  await expect(rig.makeReader().releaseCapturedOutput(rig.opId, receipt)).rejects.toThrow();
  expect(rig.runner.runs.get(rig.opId)!.finalAcked).toBe(false);
  rig.transport.available = true;
  rig.setGeneration((BigInt(receipt.attachGeneration) + 100n).toString());
  expect(await rig.makeReader().releaseCapturedOutput(rig.opId, receipt)).toBe("published");
  expect(rig.runner.runs.get(rig.opId)!.finalAcked).toBe(true);
  expect(rig.runner.runs.get(rig.opId)!.startCount).toBe(1);
  expect(
    rig.requests.every((request) => request.epoch === 0 && request.op?.$case === "opAttach"),
  ).toBe(true);
  const ack = rig.transport.decodedAcks().find((value) => value.final)!;
  expect(ack.opId).toBe(rig.opId);
  expect(ack.ackedSeq).toBe(receipt.exitSeq);
  expect(BigInt(ack.attachGeneration)).toBeGreaterThan(BigInt(receipt.attachGeneration));
  rig.runner.lostOps.add(rig.opId);
  expect(await rig.makeReader().releaseCapturedOutput(rig.opId, receipt)).toBe("not_retained");
  expect(rig.transport.decodedAcks().filter((value) => value.final)).toHaveLength(1);
});

test("output release refuses divergent, malformed and nonterminal frontiers before final ACK", async () => {
  const rig = await retainedOutputRig();
  const reader = rig.makeReader();
  const result = await reader.readExisting(rig.opId, 1000, async () => {});
  const receipt = result.outputReceipt!;
  for (const exitSeq of ["0", "-1", "18446744073709551616", "3"]) {
    await expect(reader.releaseCapturedOutput(rig.opId, { ...receipt, exitSeq })).rejects.toThrow();
  }
  rig.runner.runs.get(rig.opId)!.script.holdUntilCancel = true;
  rig.runner.runs.get(rig.opId)!.script.live = true;
  rig.runner.runs.get(rig.opId)!.liveEmitted = false;
  await expect(reader.releaseCapturedOutput(rig.opId, receipt)).rejects.toThrow();
  expect(rig.runner.runs.get(rig.opId)!.finalAcked).toBe(false);
  expect(rig.transport.decodedAcks().some((value) => value.final)).toBe(false);
  expect(rig.runner.runs.get(rig.opId)!.startCount).toBe(1);
});
