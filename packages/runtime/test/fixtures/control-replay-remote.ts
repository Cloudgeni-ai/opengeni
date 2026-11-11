// Explicit transport benchmark for a remote broker or the network-delay fixture.
// Run against the isolated native fixture,
// never a production enrollment. Uses the same command execution and retained
// output transport as run_on and command_read; excludes API/DB orchestration.
import { ControlRequest, ControlResponse, ExecRequest } from "@opengeni/agent-proto";
import { connect, createNatsEventBus } from "@opengeni/events";
import { NatsControlRpc } from "../../src/sandbox/selfhosted/control-rpc";
import { SelfhostedSession } from "../../src/sandbox/selfhosted/session";
import { NatsOpStreamTransport } from "../../src/sandbox/selfhosted/op-transport";
import { OpStreamExecClient } from "../../src/sandbox/selfhosted/op-stream";

const workspaceId = "hx-test-ws";
const agentId = "hx-test-agent";
const connectionInstanceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const subject = `agent.${workspaceId}.${agentId}.connection.${connectionInstanceId}.rpc`;
const url = process.env.OPENGENI_REPLAY_BENCH_URL!;
const token = process.env.OPENGENI_REPLAY_BENCH_BEARER!;
if (!url || !token) throw new Error("Provide the isolated broker URL and temporary bearer");
const bus = await createNatsEventBus(url, undefined, {
  connect: (options) => connect({ ...options, token }),
});
const native = bus.getRequestConnection();
const transport = new NatsOpStreamTransport(async () => bus.getOpStreamConnection!());
const requestCounts = { control: 0, negotiation: 0 };
const connection = {
  supportsHeaders: true,
  async request(
    target: string,
    payload: Uint8Array,
    options: Parameters<typeof native.request>[2],
  ) {
    requestCounts.control++;
    const op = ControlRequest.decode(payload).op;
    if (op?.$case === "ping" && op.ping.controlReplayWindowMs !== "0") requestCounts.negotiation++;
    return native.request(target, payload, options);
  },
};
function rpc(mode: string) {
  if (mode === "pooled") return new NatsControlRpc(async () => connection);
  return {
    async request(target: string, request: ControlRequest, options: { timeoutMs: number }) {
      let delivery = target;
      if (mode === "per-call") {
        const lease = await connection.request(
          target,
          ControlRequest.encode(
            ControlRequest.fromPartial({
              requestId: crypto.randomUUID(),
              op: {
                $case: "ping",
                ping: { controlReplayWindowMs: String(options.timeoutMs + 120_000) },
              },
            }),
          ).finish(),
          { timeout: options.timeoutMs },
        );
        const result = ControlResponse.decode(lease.data).result;
        if (result?.$case !== "ping") throw new Error("missing lease");
        delivery += `.replay.${result.ping.controlReplayTokens[0]}`;
      }
      return ControlResponse.decode(
        (
          await connection.request(delivery, ControlRequest.encode(request).finish(), {
            timeout: options.timeoutMs,
          })
        ).data,
      );
    },
  };
}
const sampleCount = Number(process.env.OPENGENI_REPLAY_BENCH_SAMPLES ?? 60);
const quantiles = (values: number[]) => {
  values.sort((a, b) => a - b);
  return {
    samples: values.length,
    p50Ms: values[Math.floor(values.length * 0.5)],
    p95Ms: values[Math.floor(values.length * 0.95)],
  };
};
try {
  const readyBy = performance.now() + 15_000;
  for (;;) {
    try {
      await native.request(
        subject,
        ControlRequest.encode(
          ControlRequest.fromPartial({
            requestId: "benchmark-ready",
            op: { $case: "ping", ping: {} },
          }),
        ).finish(),
        { timeout: 1000 },
      );
      break;
    } catch (error) {
      if (performance.now() >= readyBy) throw error;
      await Bun.sleep(100);
    }
  }
  const cases = [];
  for (const mode of ["direct", "per-call", "pooled"]) {
    const control = rpc(mode);
    const probeStart = performance.now();
    const probe = await control.request(
      subject,
      ControlRequest.fromPartial({
        requestId: crypto.randomUUID(),
        op: { $case: "ping", ping: {} },
      }),
      { timeoutMs: 5000 },
    );
    if (probe.error) throw new Error(probe.error.message);
    const firstProbeMs = performance.now() - probeStart;
    const reader = new OpStreamExecClient({
      workspaceId,
      agentId,
      connectionInstanceId,
      epoch: 0,
      controlRpc: control,
      rpcSubject: subject,
      transport,
      controlTimeoutMs: 5000,
      retryClock: { sleep: (ms) => Bun.sleep(ms), jitter: () => 0.5 },
    });
    const retainedId = crypto.randomUUID();
    await reader.exec(
      retainedId,
      ExecRequest.fromPartial({ command: ["/bin/sh", "-c", "printf retained"], timeoutMs: 5000 }),
      5000,
      10000,
    );
    cases.push({
      mode,
      reader,
      retainedId,
      firstProbeMs,
      reads: [] as number[],
      execs: [] as number[],
      controlRequests: 0,
      negotiations: 0,
    });
  }
  // Rotate mode order on every sample to spread host/process-start jitter
  // evenly, rather than measuring several long sequential blocks.
  for (let index = 0; index < sampleCount; index++) {
    for (let slot = 0; slot < cases.length; slot++) {
      const current = cases[(index + slot) % cases.length]!;
      const { mode, reader, retainedId, reads, execs } = current;
      const initial = { ...requestCounts };
      let start = performance.now();
      const read = await reader.readExisting(retainedId, 500, async () => {});
      if (read.status !== "completed") throw new Error("retained read not complete");
      reads.push(performance.now() - start);
      // Like run_on, use a fresh session facade over the shared control bus.
      const session = new SelfhostedSession({
        workspaceId,
        agentId,
        connectionInstanceId,
        workspaceRoot: process.env.OPENGENI_REPLAY_BENCH_ROOT!,
        controlRpc: rpc(mode),
        relay: { host: "unused.invalid" },
        timeoutMs: 5000,
        execTimeoutMs: 5000,
        opStream: { transport },
      });
      start = performance.now();
      const result = await session.exec({ cmd: "printf probe" });
      if (result.exitCode !== 0 || result.stdout !== "probe") throw new Error("short exec failed");
      await session.finalizeOpStreamOps();
      execs.push(performance.now() - start);
      current.controlRequests += requestCounts.control - initial.control;
      current.negotiations += requestCounts.negotiation - initial.negotiation;
    }
  }
  for (const current of cases) await current.reader.finalizeSettledOps();
  console.log(
    JSON.stringify(
      {
        interleaved: cases.map((values) => ({
          mode: values.mode,
          firstProbeMs: values.firstProbeMs,
          commandRead: quantiles(values.reads),
          runOnExec: quantiles(values.execs),
          controlRequests: values.controlRequests,
          negotiations: values.negotiations,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await bus.close();
}
