import { describe, expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import {
  assertCanarySupervisionReady,
  assertCompletedTurnPreservedSupervision,
  assertSettledCanarySupervision,
  type CanarySupervisionProjection,
} from "./sandbox-rotation-canary-supervision";

const invocationId = "809b79db-cc2b-4b65-9fa3-89e2f4735665";
const otherId = "10ee7d7d-f457-4419-89ca-a084034a0e61";
const rotationAt = 421_000;
const deadlineAt = 601_000;
function original(): ModalRouterProviderCommand {
  return {
    kind: "modal-router-v1",
    sandboxId: "sb-canary",
    taskId: "ta-canary",
    execId: otherId,
    pty: false,
    supervision: {
      protocol: "native-subreaper-v1",
      invocationId,
      nonce: "b".repeat(64),
      controlPath: `/tmp/opengeni-supervision/${invocationId}.sock`,
    },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 10, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
}
function running(): CanarySupervisionProjection {
  return {
    providerCommand: original(),
    state: "active",
    exitCode: null,
    settledAt: null,
    supervisionReceipt: null,
    supervisionOutputCaptured: false,
    cancellationRequestedAt: null,
    cancellationReason: null,
    backgroundState: "running",
    backgroundCancelledAt: null,
    backgroundExitCode: null,
  };
}
function settled(): CanarySupervisionProjection {
  const providerCommand = original();
  for (const stream of ["stdout", "stderr"] as const) {
    providerCommand.streams[stream] = {
      byteOffset: 100,
      utf8Remainder: "",
      eof: true,
      exitCode: 0,
    };
  }
  return {
    ...running(),
    providerCommand,
    state: "exited",
    exitCode: 137,
    settledAt: new Date(423_000),
    supervisionReceipt: {
      protocol: "native-subreaper-v1",
      invocationId,
      receiptId: otherId,
      leaderExitCode: 137,
    },
    supervisionOutputCaptured: true,
    cancellationRequestedAt: new Date(422_000),
    cancellationReason: "provider_deadline",
    backgroundState: "exited",
    backgroundExitCode: 137,
  };
}
function router(row: CanarySupervisionProjection): ModalRouterProviderCommand {
  if (row.providerCommand?.kind !== "modal-router-v1") throw new Error("invalid test fixture");
  return row.providerCommand;
}

describe("Sandbox rotation launch readiness", () => {
  const ready = { enabled: true, databaseReady: true, backend: "modal" };
  test("requires integrated launch flag and actual DB readiness", () => {
    expect(() => assertCanarySupervisionReady(ready)).not.toThrow();
  });
  for (const patch of [{ enabled: false }, { databaseReady: false }, { backend: "docker" }]) {
    test(`rejects ${Object.keys(patch)[0]}`, () => {
      expect(() => assertCanarySupervisionReady({ ...ready, ...patch })).toThrow(
        "Sandbox rotation canary:",
      );
    });
  }
});

describe("Sandbox rotation completed turns preserve adoption", () => {
  test("allows the uncancelled original running command", () => {
    expect(() => assertCompletedTurnPreservedSupervision(original(), running())).not.toThrow();
  });
  const faults: Array<[string, (row: CanarySupervisionProjection) => void]> = [
    [
      "process cancellation",
      (row) => {
        row.cancellationRequestedAt = new Date(420_000);
        row.cancellationReason = "provider_deadline";
      },
    ],
    [
      "reason without cancellation clock",
      (row) => {
        row.cancellationReason = "explicit_stop";
      },
    ],
    [
      "background cancellation",
      (row) => {
        row.backgroundCancelledAt = new Date(420_000);
      },
    ],
    [
      "background stopping",
      (row) => {
        row.backgroundState = "stopping";
      },
    ],
    [
      "early process exit",
      (row) => {
        row.state = "exited";
      },
    ],
    [
      "early terminal receipt",
      (row) => {
        row.supervisionReceipt = settled().supervisionReceipt;
      },
    ],
    [
      "early output settlement",
      (row) => {
        row.supervisionOutputCaptured = true;
      },
    ],
    [
      "changed provider execution",
      (row) => {
        router(row).execId = invocationId;
      },
    ],
  ];
  for (const [name, mutate] of faults)
    test(`rejects ${name}`, () => {
      const row = running();
      mutate(row);
      expect(() => assertCompletedTurnPreservedSupervision(original(), row)).toThrow(
        "Sandbox rotation canary:",
      );
    });
  test("rejects missing projection", () => {
    expect(() => assertCompletedTurnPreservedSupervision(original(), undefined)).toThrow();
  });
});

describe("Sandbox rotation invocation-bound dual proof", () => {
  test("accepts leader137 independently of both provider0 streams without leaking control capability", () => {
    const proof = assertSettledCanarySupervision(original(), settled(), rotationAt, deadlineAt);
    expect(proof).toMatchObject({
      invocationId,
      receiptId: otherId,
      leaderExitCode: 137,
      providerExitCode: 0,
      stdoutEof: true,
      stderrEof: true,
      outputCaptured: true,
      cancellationReason: "provider_deadline",
    });
    expect(JSON.stringify(proof)).not.toContain(original().supervision!.nonce);
    expect(JSON.stringify(proof)).not.toContain(original().supervision!.controlPath);
  });
  test("also permits leader0 when that is the exact native receipt result", () => {
    const row = settled();
    row.exitCode = row.backgroundExitCode = 0;
    row.supervisionReceipt!.leaderExitCode = 0;
    expect(() =>
      assertSettledCanarySupervision(original(), row, rotationAt, deadlineAt),
    ).not.toThrow();
  });
  const faults: Array<[string, (row: CanarySupervisionProjection) => void]> = [
    [
      "missing quiescence receipt",
      (row) => {
        row.supervisionReceipt = null;
      },
    ],
    [
      "other receipt invocation",
      (row) => {
        row.supervisionReceipt!.invocationId = otherId;
      },
    ],
    [
      "malformed receipt ID",
      (row) => {
        row.supervisionReceipt!.receiptId = "invalid";
      },
    ],
    [
      "uncommitted output",
      (row) => {
        row.supervisionOutputCaptured = false;
      },
    ],
    [
      "stdout not EOF",
      (row) => {
        router(row).streams.stdout.eof = false;
        router(row).streams.stdout.exitCode = null;
      },
    ],
    [
      "stderr not EOF",
      (row) => {
        router(row).streams.stderr.eof = false;
        router(row).streams.stderr.exitCode = null;
      },
    ],
    [
      "stdout provider death",
      (row) => {
        router(row).streams.stdout.exitCode = 137;
      },
    ],
    [
      "stderr provider death",
      (row) => {
        router(row).streams.stderr.exitCode = 137;
      },
    ],
    [
      "provider terminal unknown",
      (row) => {
        router(row).streams.stderr.exitCode = null;
      },
    ],
    [
      "uncaptured UTF8 tail",
      (row) => {
        router(row).streams.stderr.utf8Remainder = "YQ==";
      },
    ],
    [
      "leader conflated with supervisor0",
      (row) => {
        row.exitCode = 0;
      },
    ],
    [
      "background result conflated with supervisor0",
      (row) => {
        row.backgroundExitCode = 0;
      },
    ],
    [
      "background not settled",
      (row) => {
        row.backgroundState = "running";
      },
    ],
    [
      "process loss",
      (row) => {
        row.state = "lost";
        row.exitCode = null;
      },
    ],
    [
      "cancellation absent",
      (row) => {
        row.cancellationRequestedAt = null;
      },
    ],
    [
      "explicit stop instead of deadline",
      (row) => {
        row.cancellationReason = "explicit_stop";
      },
    ],
    [
      "cancellation before rotation",
      (row) => {
        row.cancellationRequestedAt = new Date(rotationAt - 1);
      },
    ],
    [
      "cancellation after settlement",
      (row) => {
        row.cancellationRequestedAt = new Date(424_000);
      },
    ],
    [
      "settled after hard deadline",
      (row) => {
        row.settledAt = new Date(deadlineAt);
      },
    ],
    [
      "missing settlement clock",
      (row) => {
        row.settledAt = null;
      },
    ],
    [
      "other provider sandbox",
      (row) => {
        router(row).sandboxId = "sb-other";
      },
    ],
    [
      "other provider task",
      (row) => {
        router(row).taskId = "ta-other";
      },
    ],
    [
      "other provider execution",
      (row) => {
        router(row).execId = invocationId;
      },
    ],
    [
      "rebound descriptor",
      (row) => {
        router(row).supervision!.invocationId = otherId;
        row.supervisionReceipt!.invocationId = otherId;
      },
    ],
    [
      "rebound control capability",
      (row) => {
        router(row).supervision!.nonce = "c".repeat(64);
      },
    ],
    [
      "missing descriptor",
      (row) => {
        delete router(row).supervision;
      },
    ],
    [
      "PTY descriptor",
      (row) => {
        router(row).pty = true;
      },
    ],
    [
      "regressed cursor",
      (row) => {
        router(row).streams.stderr.byteOffset = 9;
      },
    ],
  ];
  for (const [name, mutate] of faults)
    test(`rejects ${name}`, () => {
      const row = settled();
      mutate(row);
      expect(() => assertSettledCanarySupervision(original(), row, rotationAt, deadlineAt)).toThrow(
        "Sandbox rotation canary:",
      );
    });
  test("rejects missing projection and invalid rotation clock", () => {
    expect(() =>
      assertSettledCanarySupervision(original(), undefined, rotationAt, deadlineAt),
    ).toThrow();
    expect(() => assertSettledCanarySupervision(original(), settled(), NaN, deadlineAt)).toThrow();
  });
});
