// Server-resilience pack for the selfhosted (Connected Machine) control path:
//   - the PURE retry policy matrix (DRAINING always-retryable; a transient TIMEOUT
//     retried once and ONLY for read-only idempotent ops; mutations never re-issued);
//   - the full-jitter backoff bounds;
//   - the same policy driven through `SelfhostedSession.call` over a scripted
//     transport + a deterministic clock (draining-then-success, draining-exhausted,
//     timeout-not-retried-for-exec, timeout-retried-once-for-fs_stat);
//   - the exec/control deadline split; and
//   - the actionable error copy.

import { describe, expect, test } from "bun:test";
import { type ControlRequest, type ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import {
  type ControlRpc,
  type SelfhostedRetryClock,
  SelfhostedControlError,
  SelfhostedSession,
  SELFHOSTED_DRAINING_MAX_RETRIES,
  SELFHOSTED_EXEC_DRAINING_MAX_RETRIES,
  SELFHOSTED_RETRY_BACKOFF_BASE_MS,
  SELFHOSTED_RETRY_BACKOFF_CAP_MS,
  SELFHOSTED_TIMEOUT_MAX_RETRIES,
  agentErrorToControlError,
  decideSelfhostedRetry,
  drainingMessage,
  execDeadlineHint,
  payloadTooLargeMessage,
  selfhostedRetryBackoffMs,
} from "../src/sandbox";

const RELAY = { host: "relay.test", port: 443, tls: true } as const;
const WS = "11111111-1111-1111-1111-111111111111";
const AGENT = "agent-abc";
const encoder = new TextEncoder();

function controlError(code: ErrorCode): SelfhostedControlError {
  return agentErrorToControlError({ code, message: "", retryable: true, detail: {} });
}
const drainingError = () => controlError(ErrorCode.ERROR_CODE_DRAINING);
const timeoutError = () => controlError(ErrorCode.ERROR_CODE_TIMEOUT);

const MUTATING_OPS = [
  "exec",
  "git",
  "fsWrite",
  "fsMove",
  "fsMkdir",
  "fsRemove",
  "ptyOpen",
  "ptyWrite",
  "desktopInput",
];
const READONLY_OPS = ["ping", "metrics", "fsStat", "fsList", "fsRead"];

describe("decideSelfhostedRetry — the pure retry matrix", () => {
  test("DRAINING is retried up to the SHORT budget for any NON-exec op (it never started)", () => {
    const nonExec = [...MUTATING_OPS.filter((o) => o !== "exec"), ...READONLY_OPS];
    for (const opKind of nonExec) {
      for (let n = 0; n < SELFHOSTED_DRAINING_MAX_RETRIES; n++) {
        expect(
          decideSelfhostedRetry({
            opKind,
            error: drainingError(),
            drainingRetries: n,
            timeoutRetries: 0,
            jitter: 0,
          }).action,
        ).toBe("retry");
      }
      // Exhausted at the short budget.
      expect(
        decideSelfhostedRetry({
          opKind,
          error: drainingError(),
          drainingRetries: SELFHOSTED_DRAINING_MAX_RETRIES,
          timeoutRetries: 0,
          jitter: 0,
        }).action,
      ).toBe("fail");
    }
  });

  test("DRAINING for EXEC gets the LONG budget (patient queueing under the flat permit pool)", () => {
    // exec still retries where the short budget would already have given up.
    expect(SELFHOSTED_EXEC_DRAINING_MAX_RETRIES).toBeGreaterThan(SELFHOSTED_DRAINING_MAX_RETRIES);
    expect(
      decideSelfhostedRetry({
        opKind: "exec",
        error: drainingError(),
        drainingRetries: SELFHOSTED_DRAINING_MAX_RETRIES,
        timeoutRetries: 0,
        jitter: 0,
      }).action,
    ).toBe("retry");
    // Retries the whole way up to the exec budget, then surfaces.
    for (let n = 0; n < SELFHOSTED_EXEC_DRAINING_MAX_RETRIES; n++) {
      expect(
        decideSelfhostedRetry({
          opKind: "exec",
          error: drainingError(),
          drainingRetries: n,
          timeoutRetries: 0,
          jitter: 0,
        }).action,
      ).toBe("retry");
    }
    expect(
      decideSelfhostedRetry({
        opKind: "exec",
        error: drainingError(),
        drainingRetries: SELFHOSTED_EXEC_DRAINING_MAX_RETRIES,
        timeoutRetries: 0,
        jitter: 0,
      }).action,
    ).toBe("fail");
  });

  test("a TIMEOUT is retried once — and ONLY for a read-only idempotent op", () => {
    for (const opKind of READONLY_OPS) {
      expect(
        decideSelfhostedRetry({
          opKind,
          error: timeoutError(),
          drainingRetries: 0,
          timeoutRetries: 0,
          jitter: 0,
        }).action,
      ).toBe("retry");
      // Only once.
      expect(
        decideSelfhostedRetry({
          opKind,
          error: timeoutError(),
          drainingRetries: 0,
          timeoutRetries: SELFHOSTED_TIMEOUT_MAX_RETRIES,
          jitter: 0,
        }).action,
      ).toBe("fail");
    }
  });

  test("a TIMEOUT is NEVER retried for a mutating op (at-least-once hazard)", () => {
    for (const opKind of MUTATING_OPS) {
      expect(
        decideSelfhostedRetry({
          opKind,
          error: timeoutError(),
          drainingRetries: 0,
          timeoutRetries: 0,
          jitter: 0,
        }).action,
      ).toBe("fail");
    }
  });

  test("FENCED / AGENT_OFFLINE / OS / PAYLOAD_TOO_LARGE are not retried here", () => {
    for (const code of [
      ErrorCode.ERROR_CODE_FENCED,
      ErrorCode.ERROR_CODE_AGENT_OFFLINE,
      ErrorCode.ERROR_CODE_OS,
      ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
    ]) {
      expect(
        decideSelfhostedRetry({
          opKind: "fsStat",
          error: controlError(code),
          drainingRetries: 0,
          timeoutRetries: 0,
          jitter: 0,
        }).action,
      ).toBe("fail");
    }
  });

  test("draining and timeout budgets are SEPARATE (a read keeps its timeout retry after backpressure)", () => {
    const decision = decideSelfhostedRetry({
      opKind: "fsStat",
      error: timeoutError(),
      drainingRetries: SELFHOSTED_DRAINING_MAX_RETRIES, // already exhausted draining
      timeoutRetries: 0,
      jitter: 0,
    });
    expect(decision.action).toBe("retry");
  });
});

describe("selfhostedRetryBackoffMs — full-jitter bounds", () => {
  test("jitter 0 yields no delay at any attempt", () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(selfhostedRetryBackoffMs(attempt, 0)).toBe(0);
    }
  });

  test("delay stays within [0, base*2^attempt) and under the cap", () => {
    const nearOne = 0.999_999;
    expect(selfhostedRetryBackoffMs(0, nearOne)).toBeLessThan(SELFHOSTED_RETRY_BACKOFF_BASE_MS);
    expect(selfhostedRetryBackoffMs(1, nearOne)).toBeLessThan(SELFHOSTED_RETRY_BACKOFF_BASE_MS * 2);
    expect(selfhostedRetryBackoffMs(2, nearOne)).toBeLessThan(SELFHOSTED_RETRY_BACKOFF_BASE_MS * 4);
    // A large attempt is clamped to the per-delay cap.
    expect(selfhostedRetryBackoffMs(20, nearOne)).toBeLessThan(SELFHOSTED_RETRY_BACKOFF_CAP_MS);
  });

  test("non-exec DRAINING worst-case summed backoff stays under 5s; exec under 60s", () => {
    const worstCaseSum = (retries: number): number => {
      let total = 0;
      for (let attempt = 0; attempt < retries; attempt++) {
        total += selfhostedRetryBackoffMs(attempt, 0.999_999);
      }
      return total;
    };
    expect(worstCaseSum(SELFHOSTED_DRAINING_MAX_RETRIES)).toBeLessThan(5_000);
    expect(worstCaseSum(SELFHOSTED_EXEC_DRAINING_MAX_RETRIES)).toBeLessThan(60_000);
  });
});

// ── A scripted transport + a deterministic clock for the call()-level tests ─────

type Step = (req: ControlRequest) => ControlResponse;

class ScriptedRpc implements ControlRpc {
  readonly requests: ControlRequest[] = [];
  readonly wireTimeouts: number[] = [];
  constructor(private readonly steps: Step[]) {}
  async request(
    _subject: string,
    req: ControlRequest,
    opts: { timeoutMs: number },
  ): Promise<ControlResponse> {
    this.requests.push(req);
    this.wireTimeouts.push(opts.timeoutMs);
    const step = this.steps[Math.min(this.requests.length - 1, this.steps.length - 1)]!;
    return step(req);
  }
}

function fakeClock(jitter = 0.5): { clock: SelfhostedRetryClock; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      jitter: () => jitter,
    },
  };
}

function drainingStep(req: ControlRequest): ControlResponse {
  return {
    requestId: req.requestId,
    error: { code: ErrorCode.ERROR_CODE_DRAINING, message: "full", retryable: true, detail: {} },
    result: undefined,
  };
}
function timeoutStep(req: ControlRequest): ControlResponse {
  return {
    requestId: req.requestId,
    error: { code: ErrorCode.ERROR_CODE_TIMEOUT, message: "slow", retryable: true, detail: {} },
    result: undefined,
  };
}
function execOkStep(req: ControlRequest): ControlResponse {
  return {
    requestId: req.requestId,
    error: undefined,
    result: {
      $case: "exec",
      exec: {
        exitCode: 0,
        stdout: encoder.encode("ok\n"),
        stderr: new Uint8Array(0),
        timedOut: false,
        durationMs: "1",
      },
    },
  };
}
function fsStatOkStep(req: ControlRequest): ControlResponse {
  return {
    requestId: req.requestId,
    error: undefined,
    result: { $case: "fsStat", fsStat: { exists: true, entry: undefined } },
  };
}

function sessionWith(
  rpc: ControlRpc,
  extra: { clock?: SelfhostedRetryClock; timeoutMs?: number; execTimeoutMs?: number } = {},
): SelfhostedSession {
  return new SelfhostedSession({
    workspaceId: WS,
    agentId: AGENT,
    controlRpc: rpc,
    relay: RELAY,
    ...(extra.clock ? { retryClock: extra.clock } : {}),
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
    ...(extra.execTimeoutMs !== undefined ? { execTimeoutMs: extra.execTimeoutMs } : {}),
  });
}

describe("SelfhostedSession.call — bounded retry through the transport", () => {
  test("DRAINING then success: exec retries the backpressure and returns", async () => {
    const rpc = new ScriptedRpc([drainingStep, drainingStep, execOkStep]);
    const { clock, sleeps } = fakeClock(0.5);
    const res = await sessionWith(rpc, { clock }).exec({ cmd: "true" });
    expect(res.exitCode).toBe(0);
    expect(rpc.requests).toHaveLength(3);
    // Two backoff sleeps: full-jitter base*2^n at jitter 0.5 → 250, 500.
    expect(sleeps).toEqual([250, 500]);
    // Each attempt is a fresh request (a retry is a new request id).
    const ids = new Set(rpc.requests.map((r) => r.requestId));
    expect(ids.size).toBe(3);
  });

  test("exec DRAINING exhausted: surfaces after the LONG budget, citing the retry count", async () => {
    const rpc = new ScriptedRpc([drainingStep]); // always draining
    const { clock, sleeps } = fakeClock();
    let err: unknown;
    try {
      await sessionWith(rpc, { clock }).exec({ cmd: "true" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SelfhostedControlError);
    expect((err as SelfhostedControlError).draining).toBe(true);
    expect((err as SelfhostedControlError).message).toContain(
      `retried ${SELFHOSTED_EXEC_DRAINING_MAX_RETRIES} times`,
    );
    // 1 initial + exec-budget retries.
    expect(rpc.requests).toHaveLength(SELFHOSTED_EXEC_DRAINING_MAX_RETRIES + 1);
    expect(sleeps).toHaveLength(SELFHOSTED_EXEC_DRAINING_MAX_RETRIES);
  });

  test("non-exec DRAINING exhausted: surfaces after the SHORT budget", async () => {
    const rpc = new ScriptedRpc([drainingStep]); // always draining
    const { clock, sleeps } = fakeClock();
    let err: unknown;
    try {
      await sessionWith(rpc, { clock }).statFile({ path: "/tmp/x" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SelfhostedControlError);
    expect((err as SelfhostedControlError).draining).toBe(true);
    expect(rpc.requests).toHaveLength(SELFHOSTED_DRAINING_MAX_RETRIES + 1);
    expect(sleeps).toHaveLength(SELFHOSTED_DRAINING_MAX_RETRIES);
  });

  test("TIMEOUT on exec is NOT retried (a timed-out mutation may already have run)", async () => {
    const rpc = new ScriptedRpc([timeoutStep, execOkStep]);
    const { clock, sleeps } = fakeClock();
    let err: unknown;
    try {
      await sessionWith(rpc, { clock }).exec({ cmd: "true" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SelfhostedControlError);
    expect((err as SelfhostedControlError).reason).toBe("agent_reconnecting");
    expect(rpc.requests).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  test("TIMEOUT on a read-only op (fs_stat) is retried once then succeeds", async () => {
    const rpc = new ScriptedRpc([timeoutStep, fsStatOkStep]);
    const { clock, sleeps } = fakeClock(0.5);
    const res = await sessionWith(rpc, { clock }).statFile({ path: "/tmp/x" });
    expect(res.exists).toBe(true);
    expect(rpc.requests).toHaveLength(2);
    expect(sleeps).toEqual([250]);
  });

  test("TIMEOUT on a read-only op twice surfaces after the single retry", async () => {
    const rpc = new ScriptedRpc([timeoutStep]); // always timing out
    const { clock } = fakeClock();
    let err: unknown;
    try {
      await sessionWith(rpc, { clock }).statFile({ path: "/tmp/x" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SelfhostedControlError);
    expect((err as SelfhostedControlError).reason).toBe("agent_reconnecting");
    // 1 initial + 1 retry.
    expect(rpc.requests).toHaveLength(SELFHOSTED_TIMEOUT_MAX_RETRIES + 1);
  });
});

describe("exec / control deadline split", () => {
  test("exec uses execTimeoutMs for the process deadline (control timeout stays short)", async () => {
    const rpc = new ScriptedRpc([execOkStep]);
    await sessionWith(rpc, { timeoutMs: 30_000, execTimeoutMs: 300_000 }).exec({ cmd: "true" });
    const op = rpc.requests[0]?.op;
    if (op?.$case !== "exec") throw new Error("expected exec request");
    expect(op.exec.timeoutMs).toBe(300_000);
    // The wire waits the process deadline plus the reply grace (5s).
    expect(rpc.wireTimeouts[0]).toBe(305_000);
  });

  test("exec falls back to the control timeout when no exec deadline is threaded", async () => {
    const rpc = new ScriptedRpc([execOkStep]);
    await sessionWith(rpc, { timeoutMs: 30_000 }).exec({ cmd: "true" });
    const op = rpc.requests[0]?.op;
    if (op?.$case !== "exec") throw new Error("expected exec request");
    expect(op.exec.timeoutMs).toBe(30_000);
    expect(rpc.wireTimeouts[0]).toBe(35_000);
  });

  test("a timed-out exec result carries the actionable hint on stderr (stdout untouched)", async () => {
    const rpc = new ScriptedRpc([
      (req) => ({
        requestId: req.requestId,
        error: undefined,
        result: {
          $case: "exec",
          exec: {
            exitCode: null,
            stdout: encoder.encode("partial output\n"),
            stderr: new Uint8Array(0),
            timedOut: true,
            durationMs: "300000",
          },
        },
      }),
    ]);
    const res = await sessionWith(rpc, { execTimeoutMs: 300_000 }).exec({ cmd: "sleep 999" });
    expect(res.stdout).toBe("partial output\n");
    expect(res.stderr).toContain("300-second execution limit");
    expect(res.stderr).toContain("nohup");
    // The result carries the timedOut flag for the stdout-only execCommand path.
    expect(res.timedOut).toBe(true);
  });
});

describe("execCommand — the deadline hint reaches the stdout-only SDK path", () => {
  const timedOutExecStep =
    (stdout: string) =>
    (req: ControlRequest): ControlResponse => ({
      requestId: req.requestId,
      error: undefined,
      result: {
        $case: "exec",
        exec: {
          exitCode: null,
          stdout: encoder.encode(stdout),
          stderr: new Uint8Array(0),
          timedOut: true,
          durationMs: "120000",
        },
      },
    });

  test("empty-stdout timeout: execCommand returns the hint (never a silent empty string)", async () => {
    const rpc = new ScriptedRpc([timedOutExecStep("")]);
    const out = await sessionWith(rpc, { execTimeoutMs: 120_000 }).execCommand({
      cmd: "sleep 999",
    });
    expect(out).not.toBe("");
    expect(out).toContain("120-second execution limit");
    expect(out).toContain("nohup");
  });

  test("partial-stdout timeout: execCommand appends the hint after the output", async () => {
    const rpc = new ScriptedRpc([timedOutExecStep("partial output\n")]);
    const out = await sessionWith(rpc, { execTimeoutMs: 120_000 }).execCommand({
      cmd: "sleep 999",
    });
    // The original output, then the hint after a newline separator.
    expect(out).toBe(`partial output\n\n${execDeadlineHint(120)}`);
  });

  test("non-timeout: execCommand returns stdout unchanged", async () => {
    const rpc = new ScriptedRpc([execOkStep]);
    const out = await sessionWith(rpc, { execTimeoutMs: 120_000 }).execCommand({ cmd: "echo ok" });
    expect(out).toBe("ok\n");
    expect(out).not.toContain("execution limit");
  });
});

describe("actionable error copy", () => {
  test("PAYLOAD_TOO_LARGE copy states the sizes and the redirect-to-file workaround", () => {
    const err = agentErrorToControlError({
      code: ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
      message: "raw wire message",
      retryable: false,
      detail: { op: "exec", encoded_bytes: "1500000", max_payload: "1048576" },
    });
    expect(err.code).toBe(ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("1500000");
    expect(err.message).toContain("1048576");
    expect(err.message).toContain("/tmp/out.log");
    // The generic builder degrades gracefully with no sizes.
    expect(payloadTooLargeMessage({})).toContain("single message");
  });

  test("DRAINING copy is human language and appends the retry count only when retried", () => {
    const mapped = agentErrorToControlError({
      code: ErrorCode.ERROR_CODE_DRAINING,
      message: "agent host-work capacity is full (8 in flight)",
      retryable: true,
      detail: {},
    });
    expect(mapped.message).toContain("concurrent-work capacity");
    expect(mapped.message).not.toContain("in flight");
    expect(drainingMessage(0)).not.toContain("retried");
    expect(drainingMessage(1)).toContain("retried 1 time");
    expect(drainingMessage(3)).toContain("retried 3 times");
  });

  test("exec-deadline hint names the limit and points at background execution", () => {
    const hint = execDeadlineHint(300);
    expect(hint).toContain("300-second");
    expect(hint).toContain("nohup");
    expect(hint).toContain("background");
  });
});
