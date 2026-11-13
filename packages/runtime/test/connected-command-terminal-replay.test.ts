// A completed connected command's output is collected by replaying it from
// the runner. Its frames share the runner's output connection with every
// other command's, so on a slow link they can arrive long after the attach.

import { describe, expect, test } from "bun:test";
import { ErrorCode, ExecRequest } from "@opengeni/agent-proto";
import { SelfhostedControlError } from "../src/sandbox/selfhosted/control-rpc";
import { OpStreamExecClient } from "../src/sandbox/selfhosted/op-stream";
import { FakeOpRunner, InMemoryOpStreamTransport } from "../src/sandbox/selfhosted/op-testing";
import { OpStreamUnavailableError } from "../src/sandbox/selfhosted/op-transport";
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

async function completedCommand(transport: InMemoryOpStreamTransport) {
  const runner = new FakeOpRunner({
    transport,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    connectionInstanceId: CONNECTION,
  });
  const opId = "slow-link:0";
  runner.script(opId, { frames: [{ channel: "stdout", bytes: "done\n" }] });
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
