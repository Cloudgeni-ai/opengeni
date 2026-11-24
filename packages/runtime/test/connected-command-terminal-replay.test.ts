// A completed connected command's output is collected by replaying it from
// the runner. Its frames share the runner's output connection with every
// other command's, so on a slow link they can arrive long after the attach.

import { describe, expect, test } from "bun:test";
import { ControlResponse, ErrorCode, ExecRequest, OpFrame, OpState } from "@opengeni/agent-proto";
import { SelfhostedControlError } from "../src/sandbox/selfhosted/control-rpc";
import { OpStreamExecClient } from "../src/sandbox/selfhosted/op-stream";
import {
  FakeOpRunner,
  InMemoryOpStreamTransport,
  type FakeOpScript,
} from "../src/sandbox/selfhosted/op-testing";
import { opFrameSubject, OpStreamUnavailableError } from "../src/sandbox/selfhosted/op-transport";
import {
  ConnectedCommandCollectionError,
  connectedCommandFailureReason,
  replayConnectedCommandOutput,
} from "../src/sandbox/selfhosted/terminal-replay";

const WORKSPACE = "ws-1";
const AGENT = "agent-1";
const CONNECTION = "connection-test";
const RPC_SUBJECT = `agent.${WORKSPACE}.${AGENT}.connection.${CONNECTION}.rpc`;

/** Output frames reach the collector `delayMs` after the runner sends them,
 * as behind other commands' output queued on a slow uplink. */
class QueuedLinkTransport extends InMemoryOpStreamTransport {
  constructor(private readonly delayMs: number) {
    super();
  }
  override deliver(subject: string, payload: Uint8Array): void {
    setTimeout(() => super.deliver(subject, payload), this.delayMs);
  }
}

async function completedCommand(
  transport: InMemoryOpStreamTransport,
  script: FakeOpScript = { frames: [{ channel: "stdout", bytes: "done\n" }] },
) {
  const runner = new FakeOpRunner({
    transport,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    connectionInstanceId: CONNECTION,
  });
  const opId = "slow-link:0";
  runner.script(opId, script);
  await runner.request(
    RPC_SUBJECT,
    {
      requestId: opId,
      epoch: 0,
      op: {
        $case: "opStart",
        opStart: {
          op: { $case: "exec", exec: ExecRequest.fromPartial({ command: ["true"] }) },
          windowBytes: "65536",
          deadlineMs: "0",
          originId: "synthetic-session",
        },
      },
    },
    { timeoutMs: 1000 },
  );
  const client = new OpStreamExecClient({
    workspaceId: WORKSPACE,
    agentId: AGENT,
    connectionInstanceId: CONNECTION,
    epoch: 0,
    rpcSubject: RPC_SUBJECT,
    transport,
    controlRpc: runner,
    controlTimeoutMs: 1000,
    retryClock: { sleep: async () => {}, jitter: () => 0.5 },
    journal: { attachGeneration: () => String(Date.now()), persistSettled: () => {} },
  });
  return { runner, opId, client };
}

describe("connected command terminal replay", () => {
  test("observes a gap-heal failure even while the initial attach is awaiting its reply", async () => {
    const opId = "early-gap:0";
    const transport = new InMemoryOpStreamTransport();
    const refusal = new SelfhostedControlError({
      message: "gap heal refused",
      code: ErrorCode.ERROR_CODE_STREAM,
      reason: null,
      retryable: false,
    });
    let attaches = 0;
    const client = new OpStreamExecClient({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: CONNECTION,
      epoch: 0,
      rpcSubject: RPC_SUBJECT,
      transport,
      controlTimeoutMs: 1000,
      controlRpc: {
        async request(_subject, request) {
          expect(request.op?.$case).toBe("opAttach");
          if (++attaches === 2) throw refusal;
          // Replay frames can reach the subscriber before the first RPC
          // answer. A gap starts a second attach while that answer is pending.
          transport.deliver(
            opFrameSubject(WORKSPACE, AGENT, opId, CONNECTION),
            OpFrame.encode(OpFrame.fromPartial({ opId, seq: "2" })).finish(),
          );
          await Bun.sleep(20); // Allow the rejection checkpoint before replying.
          return ControlResponse.fromPartial({
            result: {
              $case: "opStatus",
              opStatus: { state: OpState.OP_STATE_RUNNING, nextSeq: "3" },
            },
          });
        },
      },
    });

    // The outer read owns the error. There must not also be an unhandled
    // rejection on the inner settlement promise (which would fail this test).
    await expect(client.readExisting(opId, 500, async () => {})).rejects.toBe(refusal);
    expect(attaches).toBe(2);
  });

  test("follows one attachment until output queued behind a slow link arrives", async () => {
    // Longer than the five seconds a terminal replay used to wait before it
    // gave up, attached again and left the command for a later retry.
    const transport = new QueuedLinkTransport(5_500);
    const { runner, opId, client } = await completedCommand(transport);
    const captured: string[] = [];
    const replay = await replayConnectedCommandOutput(
      client,
      opId,
      true,
      async (frames) => {
        captured.push(...frames.map((frame) => frame.chunk));
      },
      Date.now() + 30_000,
    );
    expect(replay.status).toBe("completed");
    expect(captured.join("")).toBe("done\n");
    // The same frames were not requested again behind the ones in flight.
    expect(runner.runs.get(opId)!.attachCount).toBe(1);
  }, 15_000);

  test("a look at a running command stores all output retained so far, however long it takes to arrive", async () => {
    // The look is the only reader once the attempt that started the command
    // has ended (for example, its session moved to another machine). A look
    // that stopped at a fixed quarter second stored only the frames that
    // happened to arrive by then, the same prefix every time.
    const transport = new QueuedLinkTransport(600);
    const lines = Array.from({ length: 2_000 }, (_, index) => `line ${index}\n`);
    const { runner, opId, client } = await completedCommand(transport, {
      runningRetained: true,
      frames: lines.map((bytes) => ({ channel: "stdout" as const, bytes })),
    });
    const captured: string[] = [];
    const startedAt = Date.now();
    const replay = await replayConnectedCommandOutput(
      client,
      opId,
      false,
      async (frames) => {
        captured.push(...frames.map((frame) => frame.chunk));
      },
      Date.now() + 10_000,
    );
    expect(replay.status).toBe("running");
    expect(captured.join("")).toBe(lines.join(""));
    // It returned once caught up, not at its deadline.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(runner.runs.get(opId)!.attachCount).toBe(1);
  }, 15_000);

  test("ends with a typed reason at its deadline", async () => {
    const transport = new QueuedLinkTransport(2_000);
    const { opId, client } = await completedCommand(transport);
    const replay = replayConnectedCommandOutput(
      client,
      opId,
      true,
      async () => {},
      Date.now() + 300,
    );
    await expect(replay).rejects.toBeInstanceOf(ConnectedCommandCollectionError);
    await expect(replay).rejects.toMatchObject({ reason: "claim_deadline" });
  });

  test("a terminal replay without a deadline is refused", async () => {
    const { opId, client } = await completedCommand(new InMemoryOpStreamTransport());
    await expect(
      replayConnectedCommandOutput(
        client,
        opId,
        true,
        async () => {},
        undefined as unknown as number,
      ),
    ).rejects.toThrow("requires its collector's deadline");
  });

  test("failure reasons are closed codes, never error text", () => {
    expect(
      connectedCommandFailureReason(
        new ConnectedCommandCollectionError("exit_frontier_not_reached", "no exit"),
      ),
    ).toBe("exit_frontier_not_reached");
    expect(connectedCommandFailureReason(new OpStreamUnavailableError("gone"))).toBe(
      "output_transport_unavailable",
    );
    expect(
      connectedCommandFailureReason(
        new SelfhostedControlError({
          message: "agent timed out",
          code: ErrorCode.ERROR_CODE_TIMEOUT,
          reason: null,
          retryable: true,
        }),
      ),
    ).toBe("control_timeout");
    // A database error, also when wrapped by the query builder.
    const serialization = Object.assign(new Error("could not serialize access"), {
      code: "40001",
    });
    expect(connectedCommandFailureReason(serialization)).toBe("database_40001");
    expect(connectedCommandFailureReason(new Error("Failed query", { cause: serialization }))).toBe(
      "database_40001",
    );
    expect(connectedCommandFailureReason(new Error("secret /home/user/path"))).toBe("unclassified");
    expect(connectedCommandFailureReason("text")).toBe("unclassified");
  });
});
