import { expect, test } from "bun:test";
import {
  SandboxRetainedProcessTerminalError,
  SandboxWorkspaceMutationFencedError,
} from "@opengeni/db";
import {
  messageFingerprint,
  PUBLIC_SANDBOX_FENCE_CODES,
  sandboxLeaseTelemetryKey,
} from "@opengeni/observability";
import { failureDiagnostic } from "../../../packages/observability/src/failure-diagnostic";
import {
  warnRetainedProcessProofFailure,
  warnRetainedProcessObservationFailure,
  warnRetainedProcessSettlementFailure,
  sandboxDrainErrorClass,
  warnSandboxDrainFailure,
} from "../src/retained-process-diagnostics";

const process = {
  id: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  ownerAttemptId: null,
  ownerTurnId: null,
  reconcileAttempts: 3,
};

test("observation diagnostics retain the nested provider status and stage without leaking text or identifiers", () => {
  const records: ReturnType<typeof failureDiagnostic>[] = [];
  const warnings: unknown[] = [];
  warnRetainedProcessObservationFailure(
    {
      recordFailureDiagnostic: (input) => {
        const record = failureDiagnostic(input);
        records.push(record);
        return record.diagnosticId;
      },
      warn: (_message, fields) => {
        warnings.push(fields);
      },
    },
    {
      stage: "observation",
      error: Object.assign(
        new Error("SECRET_PROVIDER_PAYLOAD", {
          cause: Object.assign(new Error("SECRET_PROVIDER_PAYLOAD"), {
            code: 9,
            details: "SECRET_PROVIDER_PAYLOAD",
          }),
        }),
        { name: "ProviderCommandObservationUnavailableError" },
      ),
    },
    process,
  );
  expect(records[0]).toMatchObject({
    code: "retained_process_observation_failed",
    stage: "sandbox_retained_processes.observation",
    causes: [
      { kind: "ProviderCommandObservationUnavailableError" },
      { kind: "Error", providerStatus: 9 },
    ],
  });
  expect(warnings).toEqual([
    {
      surface: "retained_process_observation",
      reason: "observation",
      correlationId: records[0]!.diagnosticId,
    },
  ]);
  expect(JSON.stringify({ records, warnings })).not.toContain("SECRET_PROVIDER_PAYLOAD");
  expect(JSON.stringify(warnings)).not.toContain(process.id);
});

test("proof diagnostics distinguish fencing from nested database failures without text leakage", () => {
  const records: ReturnType<typeof failureDiagnostic>[] = [];
  const warnings: unknown[] = [];
  const sink = {
    recordFailureDiagnostic: (input: Parameters<typeof failureDiagnostic>[0]) => {
      const record = failureDiagnostic(input);
      records.push(record);
      return record.diagnosticId;
    },
    warn: (_message: string, fields?: unknown) => warnings.push(fields),
  };
  warnRetainedProcessProofFailure(
    sink,
    new SandboxWorkspaceMutationFencedError("process_fenced", "SECRET_PROOF_PAYLOAD"),
    process,
  );
  warnRetainedProcessProofFailure(
    sink,
    new Error("SECRET_PROOF_PAYLOAD", {
      cause: Object.assign(new Error("SECRET_PROOF_PAYLOAD"), {
        name: "PostgresError",
        code: "23514",
        constraint_name: "sandbox_retained_processes_reconcile_proof_check",
        query: "SECRET_PROOF_PAYLOAD",
        params: ["SECRET_PROOF_PAYLOAD"],
      }),
    }),
    process,
  );
  expect(records[0]).toMatchObject({
    code: "retained_process_fenced",
    stage: "sandbox_retained_processes.proof",
    processId: process.id,
    attempts: 3,
  });
  expect(records[1]).toMatchObject({
    code: "db_failure",
    sqlState: "23514",
    constraint: "sandbox_retained_processes_reconcile_proof_check",
  });
  expect(warnings).toEqual(records.map((record) => ({ correlationId: record.diagnosticId })));
  expect(JSON.stringify(records)).not.toContain("SECRET_PROOF_PAYLOAD");
  expect(JSON.stringify(warnings)).not.toContain(process.id);
});

test("proof diagnostic failures cannot change reconciliation behavior", () => {
  let warned = false;
  expect(() =>
    warnRetainedProcessProofFailure(
      {
        recordFailureDiagnostic: () => {
          throw Error("sink failed");
        },
        warn: () => {
          warned = true;
          throw Error("public sink failed");
        },
      },
      Error("failure"),
      process,
    ),
  ).not.toThrow();
  expect(warned).toBe(true);
});

const boxProcess = {
  ...process,
  workspaceId: "00000000-0000-4000-8000-000000000003",
  sandboxGroupId: "00000000-0000-4000-8000-000000000004",
  leaseEpoch: 7,
  providerBackend: "modal",
};

function recordingSink() {
  const records: ReturnType<typeof failureDiagnostic>[] = [];
  const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
  return {
    records,
    warnings,
    sink: {
      recordFailureDiagnostic: (input: Parameters<typeof failureDiagnostic>[0]) => {
        const record = failureDiagnostic(input);
        records.push(record);
        return record.diagnosticId;
      },
      warn: (message: string, fields?: Record<string, unknown>) =>
        warnings.push({ message, fields: fields ?? {} }),
    },
  };
}

test("settlement failures name the fence, lease and message fingerprint without text or raw identifiers", () => {
  const { records, warnings, sink } = recordingSink();
  const message = "Retained process settlement did not match the copied durable identity";
  warnRetainedProcessSettlementFailure(
    sink,
    new SandboxWorkspaceMutationFencedError("process_fenced", message),
    boxProcess,
  );
  warnRetainedProcessSettlementFailure(
    sink,
    new SandboxRetainedProcessTerminalError("lost", null),
    boxProcess,
  );
  warnRetainedProcessSettlementFailure(
    sink,
    new Error("SECRET_SETTLEMENT_PAYLOAD", {
      cause: Object.assign(new Error("SECRET_SETTLEMENT_PAYLOAD"), {
        name: "PostgresError",
        code: "40P01",
        query: "SECRET_SETTLEMENT_PAYLOAD",
      }),
    }),
    boxProcess,
  );
  expect(records.map((record) => [record.code, record.stage])).toEqual([
    ["retained_process_fenced", "sandbox_retained_processes.settlement"],
    ["retained_process_fenced", "sandbox_retained_processes.settlement"],
    ["db_deadlock", "sandbox_retained_processes.settlement"],
  ]);
  expect(records[0]).toMatchObject({ processId: boxProcess.id, attempts: 3 });
  const leaseKey = sandboxLeaseTelemetryKey(boxProcess.workspaceId, boxProcess.sandboxGroupId);
  expect(warnings[0]).toEqual({
    message: "sandbox reaper: retained-process settlement failed",
    fields: {
      errorClass: "SandboxReaperOperationError",
      errorCode: "sandbox_reaper_settlement_failed",
      origin: "worker",
      sandboxLeaseKey: leaseKey,
      leaseEpoch: 7,
      backend: "modal",
      causeName: "SandboxWorkspaceMutationFencedError",
      causeFenceCode: "process_fenced",
      causeFingerprint: messageFingerprint(message),
      correlationId: records[0]!.diagnosticId,
    },
  });
  expect(warnings[1]!.fields).toMatchObject({
    causeName: "SandboxRetainedProcessTerminalError",
    causeFenceCode: "process_fenced",
  });
  expect(warnings[2]!.fields).toMatchObject({ causeName: "Error", causeSqlState: "40P01" });
  const published = JSON.stringify(warnings);
  expect(published).not.toContain("SECRET_SETTLEMENT_PAYLOAD");
  expect(published).not.toContain(message);
  for (const id of [
    boxProcess.id,
    boxProcess.sessionId,
    boxProcess.workspaceId,
    boxProcess.sandboxGroupId,
  ])
    expect(published).not.toContain(id);
  expect(JSON.stringify(records)).not.toContain("SECRET_SETTLEMENT_PAYLOAD");
});

test("drain failures keep a fingerprint of an interpolated message, never its identifiers", () => {
  const { records, warnings, sink } = recordingSink();
  const message = `sandbox backend modal declares no workspace capture policy for ${boxProcess.sandboxGroupId}`;
  warnSandboxDrainFailure(sink, new Error(message), {
    workspaceId: boxProcess.workspaceId,
    sandboxGroupId: boxProcess.sandboxGroupId,
    leaseEpoch: 7,
    backend: "modal",
  });
  expect(records[0]).toMatchObject({ code: "sandbox_drain_failed", stage: "sandbox_leases.drain" });
  expect(warnings[0]).toEqual({
    message: "sandbox reaper: per-sandbox drain failed",
    fields: {
      errorClass: "SandboxReaperOperationError",
      errorCode: "sandbox_reaper_drain_failed",
      origin: "worker",
      sandboxLeaseKey: sandboxLeaseTelemetryKey(boxProcess.workspaceId, boxProcess.sandboxGroupId),
      leaseEpoch: 7,
      backend: "modal",
      causeClass: "Error",
      causeName: "Error",
      causeFingerprint: messageFingerprint(
        "sandbox backend modal declares no workspace capture policy for <id>",
      ),
      correlationId: records[0]!.diagnosticId,
    },
  });
  expect(JSON.stringify(warnings)).not.toContain(boxProcess.sandboxGroupId);
});

test("drain failures name the thrown error's class even when it is not a public cause name", () => {
  class DrainCommitRefusedError extends Error {}
  class NamedDrainError extends Error {
    override readonly name = "NamedDrainError";
  }
  const { warnings, sink } = recordingSink();
  const lease = {
    workspaceId: boxProcess.workspaceId,
    sandboxGroupId: boxProcess.sandboxGroupId,
    leaseEpoch: 7,
    backend: "modal",
  };
  warnSandboxDrainFailure(sink, new DrainCommitRefusedError("private detail"), lease);
  warnSandboxDrainFailure(sink, new NamedDrainError("private detail"), lease);
  warnSandboxDrainFailure(sink, "a thrown string", lease);
  expect(warnings.map((warning) => warning.fields.causeClass)).toEqual([
    "DrainCommitRefusedError",
    "NamedDrainError",
    undefined,
  ]);
  expect(JSON.stringify(warnings)).not.toContain("private detail");
  expect(sandboxDrainErrorClass({ name: "has spaces in it" })).toBeUndefined();
});

test("reaper failure diagnostics cannot change settlement or drain behavior", () => {
  const failing = {
    recordFailureDiagnostic: () => {
      throw Error("sink failed");
    },
    warn: () => {
      throw Error("public sink failed");
    },
  };
  expect(() => warnRetainedProcessSettlementFailure(failing, Error("x"), boxProcess)).not.toThrow();
  expect(() =>
    warnSandboxDrainFailure(failing, Error("x"), {
      workspaceId: boxProcess.workspaceId,
      sandboxGroupId: boxProcess.sandboxGroupId,
      leaseEpoch: 7,
      backend: "modal",
    }),
  ).not.toThrow();
});

test("every sandbox fence code is publicly loggable", () => {
  // Exhaustive: a new code in the db union fails typecheck here until it is
  // listed, and then this test until it is added to PUBLIC_SANDBOX_FENCE_CODES.
  const codes: Record<SandboxWorkspaceMutationFencedError["code"], true> = {
    attempt_fenced: true,
    holder_fenced: true,
    lease_fenced: true,
    rotation_in_progress: true,
    route_fenced: true,
    process_fenced: true,
    capture_in_progress: true,
    admission_fenced: true,
    operation_invalid: true,
    generation_exhausted: true,
    authority_unattributed: true,
    authority_revoked: true,
  };
  for (const code of Object.keys(codes)) expect(PUBLIC_SANDBOX_FENCE_CODES.has(code)).toBe(true);
});
