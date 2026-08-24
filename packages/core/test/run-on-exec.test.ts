import { describe, expect, test } from "bun:test";
import { type ControlRequest, type ControlResponse } from "@opengeni/agent-proto";
import {
  FakeOpRunner,
  type FakeOpScript,
  InMemoryOpStreamTransport,
  type ControlRpc,
} from "@opengeni/runtime/sandbox";
import {
  executeRunOnSelfhostedMachine,
  type RunOnOp,
  type RunOnResult,
} from "../src/sandbox/fleet";

const encoder = new TextEncoder();
const TARGET = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const CONNECTION_INSTANCE = "connection-run-on";

type ExecPlan = {
  durationMs: number;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  healAfterLiveLoss?: boolean;
  failureCode?: "OP_OVERFLOW" | "OP_SPOOL_IO" | "OP_PIPE_IO";
  failureDetail?: Record<string, string>;
  sideEffect?: boolean;
};

/**
 * A deterministic in-memory Connected Machine runner. Duration is logical, not
 * wall-clock time: a plan longer than ExecRequest.timeoutMs returns the exact
 * typed deadline-kill outcome the Rust runner produces and suppresses the
 * planned side effect. Exec always uses the production op-stream protocol;
 * request/reply remains only for non-exec control operations such as fsRead.
 */
class InMemoryMachineRunner implements ControlRpc {
  readonly requests: Array<{ req: ControlRequest; wireTimeoutMs: number }> = [];
  readonly transport = new InMemoryOpStreamTransport();
  readonly opStream = { transport: this.transport };
  readonly opRunner: FakeOpRunner;
  executions = 0;
  completedSideEffects = 0;

  constructor(private readonly plans: Record<string, ExecPlan>) {
    this.opRunner = new FakeOpRunner({
      transport: this.transport,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: CONNECTION_INSTANCE,
      defaultScript: (exec) => this.scriptExec(exec),
    });
  }

  async request(
    _subject: string,
    req: ControlRequest,
    opts: { timeoutMs: number },
  ): Promise<ControlResponse> {
    this.requests.push({ req, wireTimeoutMs: opts.timeoutMs });
    const op = req.op;
    if (op?.$case === "fsRead") {
      const content = encoder.encode("machine-file");
      return {
        requestId: req.requestId,
        result: {
          $case: "fsRead",
          fsRead: { content, totalSize: String(content.length) },
        },
      };
    }
    return await this.opRunner.request(_subject, req, opts);
  }

  private scriptExec(exec: { command: string[]; timeoutMs: number }): FakeOpScript {
    this.executions += 1;
    const command = exec.command.join(" ");
    const plan = this.plans[command];
    if (!plan) {
      throw new Error(`missing test plan for ${command}`);
    }
    const frames: FakeOpScript["frames"] = [
      ...(plan.stdout ? [{ channel: "stdout" as const, bytes: plan.stdout }] : []),
      ...(plan.stderr ? [{ channel: "stderr" as const, bytes: plan.stderr }] : []),
    ];
    if (plan.durationMs > exec.timeoutMs) {
      return {
        frames,
        exit: {
          exitCode: -1,
          timedOut: true,
          durationMs: String(exec.timeoutMs),
        },
      };
    }
    if (plan.sideEffect) {
      this.completedSideEffects += 1;
    }
    return {
      frames,
      ...(plan.healAfterLiveLoss
        ? {
            live: true,
            dropLiveSeqs: new Set(frames.map((_, index) => index + 1)),
          }
        : {}),
      exit: {
        exitCode: plan.exitCode ?? -1,
        timedOut: false,
        durationMs: String(plan.durationMs),
        ...(plan.failureCode
          ? {
              failureCode: plan.failureCode,
              failureDetail: plan.failureDetail ?? {},
            }
          : {}),
      },
    };
  }
}

async function run(
  runner: InMemoryMachineRunner,
  op: RunOnOp,
  timeouts: { controlTimeoutMs?: number; execTimeoutMs?: number } = {},
  transientExecEnvironment?: Readonly<Record<string, string>>,
): Promise<RunOnResult> {
  return executeRunOnSelfhostedMachine(
    {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: CONNECTION_INSTANCE,
      controlRpc: runner,
      opStream: runner.opStream,
      relay: { host: "relay.test", tls: true },
      controlTimeoutMs: timeouts.controlTimeoutMs ?? 30_000,
      execTimeoutMs: timeouts.execTimeoutMs ?? 120_000,
      ...(transientExecEnvironment ? { transientExecEnvironment } : {}),
    },
    TARGET,
    op,
  );
}

describe("run_on Connected Machine exec receipts", () => {
  test("a grant revoked after snapshot fences exec/read/write at the last boundary with zero dispatch", async () => {
    for (const op of [
      { kind: "exec", cmd: "true" },
      { kind: "read", path: "/workspace/input.txt" },
      { kind: "write", path: "/workspace/output.txt", content: "blocked" },
    ] satisfies RunOnOp[]) {
      const runner = new InMemoryMachineRunner({
        true: { durationMs: 1, exitCode: 0, sideEffect: true },
      });
      let gateReads = 0;
      const result = await executeRunOnSelfhostedMachine(
        {
          workspaceId: WORKSPACE,
          agentId: AGENT,
          connectionInstanceId: "snapshotted-before-revoke",
          controlRpc: runner,
          relay: { host: "relay.test", tls: true },
          controlTimeoutMs: 30_000,
          execTimeoutMs: 120_000,
          resolveOperationAdmission: async () => {
            gateReads += 1;
            return null;
          },
        },
        TARGET,
        op,
      );
      expect(result.ok).toBe(false);
      expect(gateReads).toBe(1);
      expect(runner.requests).toHaveLength(0);
      expect(runner.executions).toBe(0);
      expect(runner.completedSideEffects).toBe(0);
    }
  });

  test("threads the enrollment command policy and fails closed without support", async () => {
    const supported = new InMemoryMachineRunner({ true: { durationMs: 1, exitCode: 0 } });
    const base = {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: CONNECTION_INSTANCE,
      relay: { host: "relay.test", tls: true } as const,
      controlTimeoutMs: 30_000,
      execTimeoutMs: 120_000,
      operationResourcePolicy: { memoryMaxBytes: 1_073_741_824 },
    };

    const accepted = await executeRunOnSelfhostedMachine(
      {
        ...base,
        controlRpc: supported,
        opStream: supported.opStream,
        operationResourcePolicySupported: true,
      },
      TARGET,
      { kind: "exec", cmd: "true" },
    );
    expect(accepted.ok).toBe(true);
    const policyStart = supported.requests.find(({ req }) => req.op?.$case === "opStart");
    expect(policyStart?.req.resourcePolicy?.memoryMaxBytes).toBe("1073741824");

    const incapable = new InMemoryMachineRunner({ true: { durationMs: 1, exitCode: 0 } });
    const rejected = await executeRunOnSelfhostedMachine(
      {
        ...base,
        controlRpc: incapable,
        operationResourcePolicySupported: false,
      },
      TARGET,
      { kind: "exec", cmd: "true" },
    );
    expect(rejected).toMatchObject({ ok: false, kind: "exec" });
    expect(rejected.reason).toContain("cannot enforce");
    expect(incapable.requests).toHaveLength(0);
  });

  test("projects exact-attempt values only onto the one-off child exec", async () => {
    const runner = new InMemoryMachineRunner({
      inspect: { durationMs: 1, exitCode: 0 },
    });
    const environment = {
      OPENGENI_CODEMODE_URL: "https://control.example/v1/workspaces/test/codemode",
      OPENGENI_CODEMODE_TOKEN: "attempt-bearer",
    } as const;

    await run(runner, { kind: "exec", cmd: "inspect" }, {}, environment);

    expect(runner.opRunner.starts[0]?.exec.env).toEqual(environment);
    expect(environment).toEqual({
      OPENGENI_CODEMODE_URL: "https://control.example/v1/workspaces/test/codemode",
      OPENGENI_CODEMODE_TOKEN: "attempt-bearer",
    });
  });

  test("<deadline exit 0 and nonzero preserve exact terminal status", async () => {
    const runner = new InMemoryMachineRunner({
      clean: { durationMs: 119_999, exitCode: 0, stdout: "clean\n" },
      nonzero: { durationMs: 1, exitCode: 7, stderr: "failed\n" },
    });

    const clean = await run(runner, { kind: "exec", cmd: "clean" });
    expect(clean).toMatchObject({
      target: TARGET,
      kind: "exec",
      ok: true,
      exitCode: 0,
      timedOut: false,
      deadlineMs: 120_000,
      stdout: "clean\n",
    });

    const nonzero = await run(runner, { kind: "exec", cmd: "nonzero" });
    expect(nonzero).toMatchObject({
      kind: "exec",
      ok: true,
      exitCode: 7,
      timedOut: false,
      deadlineMs: 120_000,
      stderr: "failed\n",
    });
    expect(runner.executions).toBe(2);
  });

  test("configured 120s exec deadline is distinct from the 30s control deadline", async () => {
    const runner = new InMemoryMachineRunner({
      build: { durationMs: 31_000, exitCode: 0, stdout: "built\n" },
    });

    const exec = await run(runner, { kind: "exec", cmd: "build" });
    expect(exec.deadlineMs).toBe(120_000);
    const execRequest = runner.requests.find(({ req }) => req.op?.$case === "opStart");
    if (execRequest?.req.op?.$case !== "opStart") throw new Error("expected OpStart request");
    if (execRequest.req.op.opStart.op?.$case !== "exec") {
      throw new Error("expected op-stream exec request");
    }
    expect(execRequest.req.op.opStart.op.exec.timeoutMs).toBe(120_000);
    expect(execRequest.wireTimeoutMs).toBe(30_000);

    const read = await run(runner, { kind: "read", path: "/tmp/result" });
    expect(read).toMatchObject({ kind: "read", ok: true, content: "machine-file" });
    const readRequest = runner.requests.find(({ req }) => req.op?.$case === "fsRead");
    expect(readRequest?.req.op?.$case).toBe("fsRead");
    expect(readRequest?.wireTimeoutMs).toBe(30_000);
  });

  test(">deadline execution is killed, typed, and never ok:true", async () => {
    const runner = new InMemoryMachineRunner({
      delayed: {
        durationMs: 120_001,
        exitCode: 0,
        stdout: "partial\n",
        sideEffect: true,
      },
    });

    const result = await run(runner, { kind: "exec", cmd: "delayed" });
    expect(result).toMatchObject({
      kind: "exec",
      ok: false,
      exitCode: -1,
      timedOut: true,
      deadlineMs: 120_000,
      stdout: "partial\n",
    });
    expect(result.stderr).toContain("120-second execution limit");
    expect(result.reason).toContain("120000 ms execution deadline");
    expect(runner.executions).toBe(1);
    expect(runner.completedSideEffects).toBe(0);
  });

  test("live stream loss heals from runner retention and the exec is not duplicated", async () => {
    const runner = new InMemoryMachineRunner({
      healed: {
        durationMs: 1,
        exitCode: 0,
        stdout: "recovered\n",
        healAfterLiveLoss: true,
      },
    });

    const result = await run(runner, { kind: "exec", cmd: "healed" });
    expect(result).toMatchObject({
      kind: "exec",
      ok: true,
      deadlineMs: 120_000,
      stdout: "recovered\n",
    });
    expect(runner.executions).toBe(1);
    expect(runner.opRunner.runs.size).toBe(1);
  });

  test("a runner capture failure is typed and never reported ok:true", async () => {
    const runner = new InMemoryMachineRunner({
      captureFailure: {
        durationMs: 1,
        exitCode: 0,
        failureCode: "OP_PIPE_IO",
        failureDetail: { stream: "stdout" },
      },
    });

    const result = await run(runner, { kind: "exec", cmd: "captureFailure" });
    expect(result).toMatchObject({
      kind: "exec",
      ok: false,
      deadlineMs: 120_000,
    });
    expect(result.reason).toContain("OP_PIPE_IO");
    expect(runner.executions).toBe(1);
  });

  test("runner retention overflow fails typed and is not duplicated", async () => {
    const runner = new InMemoryMachineRunner({
      capped: {
        durationMs: 1,
        exitCode: 0,
        failureCode: "OP_OVERFLOW",
        failureDetail: { retained_bytes: "9", retained_limit_bytes: "8" },
      },
    });

    const result = await run(runner, { kind: "exec", cmd: "capped" });
    expect(result).toMatchObject({ kind: "exec", ok: false, deadlineMs: 120_000 });
    expect(result.reason).toContain("more output than the machine link can retain");
    expect(result.reason).toContain("/tmp/out.log");
    expect(runner.executions).toBe(1);
    expect(runner.opRunner.runs.size).toBe(1);
  });
});
