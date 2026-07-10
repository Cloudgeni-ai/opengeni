// In-band fault legibility (the failure-visibility doctrine's in-band plane):
//   - G2: `renderSelfhostedFault` renders every fault class into the four mandatory
//     fields with a CORRECT retry verdict, and the routing proxy surfaces it as the
//     `exec_command` result instead of the SDK's misleading "Please try again".
//   - G5: PAYLOAD_TOO_LARGE is typed (a distinguishing flag) and rendered with the
//     size wall + recovery moves.
//   - G3-remnant: a PRE-SEND (never-sent) offline synthesis is retried for ANY op
//     (provably not executed), while an ambiguous post-send fault is not.

import { describe, expect, test } from "bun:test";
import { type ControlRequest, type ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import {
  type ControlRpc,
  type RoutableBackendSession,
  type SelfhostedRetryClock,
  NatsControlRpc,
  RoutingSandboxSession,
  RoutingUnsupportedError,
  SelfhostedControlError,
  SelfhostedSession,
  SELFHOSTED_NEVER_SENT_MAX_RETRIES,
  agentErrorToControlError,
  decideSelfhostedRetry,
  offlineAgentError,
  offlineControlResponse,
  renderSelfhostedFault,
  selfhostedFaultClass,
  SELFHOSTED_INFRASTRUCTURE_FAULT_CLASSES,
  timeoutAgentError,
  FAULT_FIELD_WHAT_HAPPENED,
  FAULT_FIELD_WHICH_LAYER,
  FAULT_FIELD_WHAT_PRESERVED,
  FAULT_FIELD_WHAT_TO_TRY,
} from "../src/sandbox";

const WS = "11111111-1111-1111-1111-111111111111";
const AGENT = "agent-abc";
const RELAY = { host: "relay.test", port: 443, tls: true } as const;
const encoder = new TextEncoder();

const ALL_FIELDS = [
  FAULT_FIELD_WHAT_HAPPENED,
  FAULT_FIELD_WHICH_LAYER,
  FAULT_FIELD_WHAT_PRESERVED,
  FAULT_FIELD_WHAT_TO_TRY,
];

function mapped(code: ErrorCode, message = "", detail: Record<string, string> = {}) {
  return agentErrorToControlError({ code, message, retryable: false, detail });
}
function offlineErr(neverSent: boolean): SelfhostedControlError {
  return agentErrorToControlError(offlineAgentError(undefined, neverSent));
}

describe("renderSelfhostedFault — every fault class carries all four fields", () => {
  const cases: Record<string, SelfhostedControlError> = {
    "offline (never-sent)": offlineErr(true),
    "offline (ambiguous)": offlineErr(false),
    draining: mapped(ErrorCode.ERROR_CODE_DRAINING),
    consent: mapped(ErrorCode.ERROR_CODE_CONSENT_REQUIRED),
    payload: mapped(ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE, "", {
      op: "exec",
      encoded_bytes: "1500000",
      max_payload: "1048576",
    }),
    reconnecting: agentErrorToControlError(timeoutAgentError()),
    notFound: mapped(ErrorCode.ERROR_CODE_NOT_FOUND, "no such file: /x"),
    fenced: mapped(ErrorCode.ERROR_CODE_FENCED),
    os: mapped(ErrorCode.ERROR_CODE_OS, "disk write failed"),
  };

  for (const [name, error] of Object.entries(cases)) {
    test(`${name}: all four fields present, never an empty rendering`, () => {
      const out = renderSelfhostedFault(error);
      expect(out.length).toBeGreaterThan(0);
      for (const field of ALL_FIELDS) {
        expect(out).toContain(field);
      }
      // The typed wire code is always folded in (typed code + plain language).
      expect(out).toContain("control code ERROR_CODE_");
    });
  }
});

describe("renderSelfhostedFault — the retry verdict is correct per class", () => {
  test("offline (never-sent): nothing ran; do NOT suggest a blind retry", () => {
    const out = renderSelfhostedFault(offlineErr(true));
    expect(out).toContain("nothing ran");
    expect(out.toLowerCase()).toContain("offline");
    expect(out.toLowerCase()).toContain("will not help");
  });

  test("offline (ambiguous): the effect is unknown; check before re-running", () => {
    const out = renderSelfhostedFault(offlineErr(false)).toLowerCase();
    expect(out).toContain("may or may not have run");
    expect(out).toContain("re-running");
  });

  test("draining: nothing ran; retryable shortly", () => {
    const out = renderSelfhostedFault(mapped(ErrorCode.ERROR_CODE_DRAINING)).toLowerCase();
    expect(out).toContain("nothing ran");
    expect(out).toContain("try again shortly");
  });

  test("consent: not retryable — must be granted on the machine", () => {
    const out = renderSelfhostedFault(mapped(ErrorCode.ERROR_CODE_CONSENT_REQUIRED)).toLowerCase();
    expect(out).toContain("consent");
    expect(out).toContain("keep failing");
  });

  test("payload: cites the sizes, says dropped whole, gives the recovery moves", () => {
    const out = renderSelfhostedFault(
      mapped(ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE, "", {
        encoded_bytes: "1500000",
        max_payload: "1048576",
      }),
    );
    expect(out).toContain("1500000");
    expect(out).toContain("1048576");
    expect(out).toContain("dropped whole");
    expect(out.toLowerCase()).toContain("/tmp/out.log");
    expect(out).toContain("head -c");
  });

  test("reconnecting: ambiguous — check effects before re-running", () => {
    const out = renderSelfhostedFault(agentErrorToControlError(timeoutAgentError())).toLowerCase();
    expect(out).toContain("may or may not have run");
  });

  test("never renders the SDK's misleading wrapper phrasing", () => {
    for (const error of [
      offlineErr(true),
      mapped(ErrorCode.ERROR_CODE_CONSENT_REQUIRED),
      mapped(ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE),
    ]) {
      expect(renderSelfhostedFault(error)).not.toContain("Please try again");
    }
  });
});

describe("selfhostedFaultClass — the out-of-band class taxonomy + infra filter", () => {
  const expectations: Array<[ErrorCode, string, boolean]> = [
    [ErrorCode.ERROR_CODE_AGENT_OFFLINE, "offline", true],
    [ErrorCode.ERROR_CODE_DRAINING, "draining", true],
    [ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE, "payload_too_large", true],
    [ErrorCode.ERROR_CODE_TIMEOUT, "reconnecting", true],
    [ErrorCode.ERROR_CODE_OS, "os", true],
    [ErrorCode.ERROR_CODE_STREAM, "stream", true],
    [ErrorCode.ERROR_CODE_PROTOCOL, "protocol", true],
    // Semantic misses + routing — NOT infrastructure faults.
    [ErrorCode.ERROR_CODE_NOT_FOUND, "not_found", false],
    [ErrorCode.ERROR_CODE_CONSENT_REQUIRED, "consent", false],
    [ErrorCode.ERROR_CODE_FENCED, "fenced", false],
  ];

  for (const [code, expectedClass, isInfra] of expectations) {
    test(`${expectedClass}: class + infra=${isInfra}`, () => {
      const cls = selfhostedFaultClass(mapped(code));
      expect(cls).toBe(expectedClass);
      expect(SELFHOSTED_INFRASTRUCTURE_FAULT_CLASSES.has(cls)).toBe(isInfra);
    });
  }
});

describe("G5 — PAYLOAD_TOO_LARGE is a typed, distinguishable fault", () => {
  test("agentErrorToControlError sets the payloadTooLarge flag", () => {
    const err = mapped(ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE);
    expect(err.payloadTooLarge).toBe(true);
    expect(err.code).toBe(ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE);
    expect(err.retryable).toBe(false);
  });
});

describe("G3-remnant — never-sent retry safety in the pure policy", () => {
  const NON_READONLY = ["exec", "git", "fsWrite", "fsMove", "desktopInput"];

  test("a never-sent offline fault is retried for ANY op kind (provably not executed)", () => {
    const error = offlineErr(true);
    for (const opKind of NON_READONLY) {
      expect(
        decideSelfhostedRetry({
          opKind,
          error,
          drainingRetries: 0,
          timeoutRetries: 0,
          neverSentRetries: 0,
          jitter: 0,
        }).action,
      ).toBe("retry");
      // Exhausted after the bounded budget.
      expect(
        decideSelfhostedRetry({
          opKind,
          error,
          drainingRetries: 0,
          timeoutRetries: 0,
          neverSentRetries: SELFHOSTED_NEVER_SENT_MAX_RETRIES,
          jitter: 0,
        }).action,
      ).toBe("fail");
    }
  });

  test("an AMBIGUOUS offline fault (not never-sent) is never retried", () => {
    const error = offlineErr(false);
    for (const opKind of [...NON_READONLY, "fsRead"]) {
      expect(
        decideSelfhostedRetry({
          opKind,
          error,
          drainingRetries: 0,
          timeoutRetries: 0,
          neverSentRetries: 0,
          jitter: 0,
        }).action,
      ).toBe("fail");
    }
  });
});

describe("G3-remnant — the transport marks never-sent only pre-send", () => {
  const req: ControlRequest = {
    requestId: "req-1",
    epoch: 0,
    op: { $case: "ping", ping: { nonce: "1" } },
  };

  test("offlineControlResponse threads never-sent through the mapping", () => {
    expect(agentErrorToControlError(offlineControlResponse("r", true).error!).neverSent).toBe(true);
    expect(agentErrorToControlError(offlineControlResponse("r", false).error!).neverSent).toBe(
      false,
    );
  });

  test("no NATS connection → offline + never-sent (the request never left)", async () => {
    const rpc = new NatsControlRpc(async () => null);
    const res = await rpc.request("subj", req, { timeoutMs: 10 });
    const err = agentErrorToControlError(res.error!);
    expect(err.agentOffline).toBe(true);
    expect(err.neverSent).toBe(true);
  });

  test("no responders (503) → offline + never-sent (reached no responder)", async () => {
    const conn = {
      request: async () => {
        throw { code: "503" };
      },
    };
    const rpc = new NatsControlRpc(async () => conn);
    const err = agentErrorToControlError(
      (await rpc.request("subj", req, { timeoutMs: 10 })).error!,
    );
    expect(err.agentOffline).toBe(true);
    expect(err.neverSent).toBe(true);
  });

  test("a request timeout → reconnecting, NOT never-sent (ambiguous, post-send)", async () => {
    const conn = {
      request: async () => {
        throw { code: "TIMEOUT" };
      },
    };
    const rpc = new NatsControlRpc(async () => conn);
    const err = agentErrorToControlError(
      (await rpc.request("subj", req, { timeoutMs: 10 })).error!,
    );
    expect(err.reason).toBe("agent_reconnecting");
    expect(err.neverSent).toBe(false);
  });

  test("any other transport error → offline but NOT never-sent (ambiguous mid-send)", async () => {
    const conn = {
      request: async () => {
        throw new Error("connection reset by peer");
      },
    };
    const rpc = new NatsControlRpc(async () => conn);
    const err = agentErrorToControlError(
      (await rpc.request("subj", req, { timeoutMs: 10 })).error!,
    );
    expect(err.agentOffline).toBe(true);
    expect(err.neverSent).toBe(false);
  });
});

// ── call()-level never-sent heal (a reconnect blip that provably never sent) ────

type Step = (req: ControlRequest) => ControlResponse;
class ScriptedRpc implements ControlRpc {
  readonly requests: ControlRequest[] = [];
  constructor(private readonly steps: Step[]) {}
  async request(_s: string, req: ControlRequest): Promise<ControlResponse> {
    this.requests.push(req);
    return this.steps[Math.min(this.requests.length - 1, this.steps.length - 1)]!(req);
  }
}
function fakeClock(jitter = 0): SelfhostedRetryClock {
  return { sleep: async () => {}, jitter: () => jitter };
}
function neverSentStep(req: ControlRequest): ControlResponse {
  return offlineControlResponse(req.requestId, true);
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
function sessionWith(rpc: ControlRpc): SelfhostedSession {
  return new SelfhostedSession({
    workspaceId: WS,
    agentId: AGENT,
    controlRpc: rpc,
    relay: RELAY,
    retryClock: fakeClock(),
  });
}

describe("G3-remnant — call() heals a never-sent blip and surfaces a real outage", () => {
  test("never-sent then success: a state-changing exec is safely re-issued", async () => {
    const rpc = new ScriptedRpc([neverSentStep, neverSentStep, execOkStep]);
    const res = await sessionWith(rpc).exec({ cmd: "true" });
    expect(res.exitCode).toBe(0);
    expect(rpc.requests).toHaveLength(3);
  });

  test("persistent never-sent surfaces offline after the bounded budget", async () => {
    const rpc = new ScriptedRpc([neverSentStep]);
    let err: unknown;
    try {
      await sessionWith(rpc).exec({ cmd: "true" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SelfhostedControlError);
    expect((err as SelfhostedControlError).agentOffline).toBe(true);
    expect(rpc.requests).toHaveLength(SELFHOSTED_NEVER_SENT_MAX_RETRIES + 1);
  });
});

// ── G2 — the routing proxy surfaces the rendering as the exec_command result ────

function proxyOverBackend(backend: RoutableBackendSession): RoutingSandboxSession {
  const resolved = { session: backend, sandboxId: null, kind: "selfhosted" };
  return new RoutingSandboxSession({
    defaultResolved: resolved,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => resolved,
  });
}

describe("G2 — RoutingSandboxSession.execCommand renders a terminal fault as its result", () => {
  test("an offline fault becomes a four-field string (never a thrown wrapper)", async () => {
    const backend: RoutableBackendSession = {
      execCommand: async () => {
        throw offlineErr(true);
      },
    };
    const out = await proxyOverBackend(backend).execCommand({ cmd: "ls" });
    for (const field of ALL_FIELDS) {
      expect(out).toContain(field);
    }
    expect(out).not.toContain("Please try again");
  });

  test("a fence error is re-thrown (routing retries it), NOT rendered", async () => {
    const backend: RoutableBackendSession = {
      execCommand: async () => {
        throw mapped(ErrorCode.ERROR_CODE_FENCED);
      },
    };
    let threw = false;
    try {
      await proxyOverBackend(backend).execCommand({ cmd: "ls" });
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(SelfhostedControlError);
      expect((e as SelfhostedControlError).fenced).toBe(true);
    }
    expect(threw).toBe(true);
  });

  test("a non-selfhosted error is re-thrown unchanged", async () => {
    const backend: RoutableBackendSession = {
      execCommand: async () => {
        throw new RoutingUnsupportedError("execCommand", "modal");
      },
    };
    let threw = false;
    try {
      await proxyOverBackend(backend).execCommand({ cmd: "ls" });
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(RoutingUnsupportedError);
    }
    expect(threw).toBe(true);
  });

  test("a healthy command is unaffected (returns real stdout)", async () => {
    const backend: RoutableBackendSession = {
      execCommand: async () => "hello\n",
    };
    expect(await proxyOverBackend(backend).execCommand({ cmd: "echo hello" })).toBe("hello\n");
  });
});
