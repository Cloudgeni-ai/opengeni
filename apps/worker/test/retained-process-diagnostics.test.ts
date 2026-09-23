import { expect, test } from "bun:test";
import { SandboxWorkspaceMutationFencedError } from "@opengeni/db";
import { failureDiagnostic } from "../../../packages/observability/src/failure-diagnostic";
import { warnRetainedProcessProofFailure } from "../src/retained-process-diagnostics";

const process = {
  id: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  ownerAttemptId: null,
  ownerTurnId: null,
  reconcileAttempts: 3,
};

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
