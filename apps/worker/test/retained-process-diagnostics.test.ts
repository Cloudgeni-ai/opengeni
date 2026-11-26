import { expect, test } from "bun:test";
import {
  SandboxRetainedProcessTerminalError,
  SandboxWorkspaceMutationFencedError,
} from "@opengeni/db";
import { messageFingerprint, sandboxLeaseTelemetryKey } from "@opengeni/observability";
import { failureDiagnostic } from "../../../packages/observability/src/failure-diagnostic";
import {
  warnRetainedProcessProofFailure,
  warnRetainedProcessObservationFailure,
  warnRetainedProcessSettlementFailure,
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
      causeName: "Error",
      causeFingerprint: messageFingerprint(
        "sandbox backend modal declares no workspace capture policy for <id>",
      ),
      correlationId: records[0]!.diagnosticId,
    },
  });
  expect(JSON.stringify(warnings)).not.toContain(boxProcess.sandboxGroupId);
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
