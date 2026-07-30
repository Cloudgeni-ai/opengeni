import { describe, expect, test } from "bun:test";
import {
  ControlRequest,
  ControlResponse,
  ErrorCode,
  type ExecResponse,
} from "@opengeni/agent-proto";
import { type ControlRpc } from "@opengeni/runtime/sandbox";
import {
  executeRunOnSelfhostedMachine,
  type RunOnOp,
  type RunOnResult,
} from "../src/sandbox/fleet";

const encoder = new TextEncoder();
const TARGET = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

type ExecPlan = {
  durationMs: number;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  transportLoss?: boolean;
  sideEffect?: boolean;
};

/**
 * A deterministic in-memory Connected Machine runner. Duration is logical, not
 * wall-clock time: a plan longer than ExecRequest.timeoutMs returns the exact
 * typed deadline-kill response the Rust runner produces and suppresses the
 * planned side effect. It also simulates the monolithic transport's output cap
 * and a post-dispatch transport loss without a real broker or machine.
 */
class InMemoryMachineRunner implements ControlRpc {
  readonly requests: Array<{ req: ControlRequest; wireTimeoutMs: number }> = [];
  executions = 0;
  completedSideEffects = 0;

  constructor(
    private readonly plans: Record<string, ExecPlan>,
    private readonly outputCapBytes = 1_048_576,
  ) {}

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
    if (op?.$case !== "exec") {
      return {
        requestId: req.requestId,
        error: {
          code: ErrorCode.ERROR_CODE_UNSUPPORTED,
          message: "test runner supports exec and fsRead only",
          retryable: false,
          detail: {},
        },
      };
    }

    this.executions += 1;
    const command = op.exec.command.join(" ");
    const plan = this.plans[command];
    if (!plan) {
      throw new Error(`missing test plan for ${command}`);
    }
    if (plan.transportLoss) {
      return {
        requestId: req.requestId,
        error: {
          code: ErrorCode.ERROR_CODE_TIMEOUT,
          message: "machine link was lost after dispatch; execution outcome is unknown",
          retryable: true,
          detail: {},
        },
      };
    }

    const stdout = encoder.encode(plan.stdout ?? "");
    const stderr = encoder.encode(plan.stderr ?? "");
    const encodedBytes = stdout.length + stderr.length;
    if (encodedBytes > this.outputCapBytes) {
      return {
        requestId: req.requestId,
        error: {
          code: ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
          message: "reply exceeded the runner output cap",
          retryable: false,
          detail: {
            op: "exec",
            encoded_bytes: String(encodedBytes),
            max_payload: String(this.outputCapBytes),
          },
        },
      };
    }

    if (plan.durationMs > op.exec.timeoutMs) {
      return this.execResponse(req, {
        // The generated proto surface represents this as int32, while the live
        // Rust deadline-kill response is intentionally decoded as null by the
        // structural session contract. Keep the fake at that public boundary.
        exitCode: null,
        stdout,
        stderr,
        timedOut: true,
        durationMs: String(op.exec.timeoutMs),
      });
    }
    if (plan.sideEffect) {
      this.completedSideEffects += 1;
    }
    return this.execResponse(req, {
      exitCode: plan.exitCode,
      stdout,
      stderr,
      timedOut: false,
      durationMs: String(plan.durationMs),
    });
  }

  private execResponse(
    req: ControlRequest,
    result: Omit<ExecResponse, "exitCode"> & { exitCode: number | null },
  ): ControlResponse {
    return {
      requestId: req.requestId,
      result: {
        $case: "exec",
        exec: result as ExecResponse,
      },
    };
  }
}

async function run(
  runner: InMemoryMachineRunner,
  op: RunOnOp,
  timeouts: { controlTimeoutMs?: number; execTimeoutMs?: number } = {},
): Promise<RunOnResult> {
  return executeRunOnSelfhostedMachine(
    {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      controlRpc: runner,
      relay: { host: "relay.test", tls: true },
      controlTimeoutMs: timeouts.controlTimeoutMs ?? 30_000,
      execTimeoutMs: timeouts.execTimeoutMs ?? 120_000,
    },
    TARGET,
    op,
  );
}

describe("run_on Connected Machine exec receipts", () => {
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
    const execRequest = runner.requests[0];
    expect(execRequest?.req.op?.$case).toBe("exec");
    if (execRequest?.req.op?.$case !== "exec") throw new Error("expected exec request");
    expect(execRequest.req.op.exec.timeoutMs).toBe(120_000);
    expect(execRequest.wireTimeoutMs).toBe(125_000);

    const read = await run(runner, { kind: "read", path: "/tmp/result" });
    expect(read).toMatchObject({ kind: "read", ok: true, content: "machine-file" });
    const readRequest = runner.requests[1];
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
      exitCode: null,
      timedOut: true,
      deadlineMs: 120_000,
      stdout: "partial\n",
    });
    expect(result.stderr).toContain("120-second execution limit");
    expect(result.reason).toContain("120000 ms execution deadline");
    expect(runner.executions).toBe(1);
    expect(runner.completedSideEffects).toBe(0);
  });

  test("transport loss is failed as ambiguous and the exec is not duplicated", async () => {
    const runner = new InMemoryMachineRunner({
      ambiguous: { durationMs: 1, exitCode: 0, transportLoss: true },
    });

    const result = await run(runner, { kind: "exec", cmd: "ambiguous" });
    expect(result).toMatchObject({
      kind: "exec",
      ok: false,
      deadlineMs: 120_000,
    });
    expect(result.timedOut).toBeUndefined();
    expect(result.reason).toMatch(/lost after dispatch|outcome is unknown/i);
    expect(runner.executions).toBe(1);
    expect(runner.requests).toHaveLength(1);
  });

  test("a non-timeout null exit is failed instead of reported ok:true", async () => {
    const runner = new InMemoryMachineRunner({
      nullExit: { durationMs: 1, exitCode: null, stdout: "orphaned status\n" },
    });

    const result = await run(runner, { kind: "exec", cmd: "nullExit" });
    expect(result).toMatchObject({
      kind: "exec",
      ok: false,
      exitCode: null,
      timedOut: false,
      deadlineMs: 120_000,
      reason: "machine returned no terminal exit code",
    });
    expect(runner.executions).toBe(1);
  });

  test("output over the monolithic transport cap fails typed and is not duplicated", async () => {
    const runner = new InMemoryMachineRunner(
      {
        capped: { durationMs: 1, exitCode: 0, stdout: "123456789" },
      },
      8,
    );

    const result = await run(runner, { kind: "exec", cmd: "capped" });
    expect(result).toMatchObject({ kind: "exec", ok: false, deadlineMs: 120_000 });
    expect(result.reason).toContain("9 bytes");
    expect(result.reason).toContain("8-byte");
    expect(result.reason).toContain("/tmp/out.log");
    expect(runner.executions).toBe(1);
    expect(runner.requests).toHaveLength(1);
  });
});
