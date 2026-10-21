import { expect, test } from "bun:test";
import { createObservability } from "../src";

test("operational errors retain safe cause and child correlation without publishing raw context", () => {
  const obs = createObservability(
    { serviceName: "test", environment: "test", observabilityStructuredLogs: true },
    { component: "worker" },
  );
  const records: Record<string, unknown>[] = [];
  const protectedInputs: Record<string, unknown>[] = [];
  const original = console.error;
  console.error = (value) => records.push(JSON.parse(String(value)));
  obs.recordFailureDiagnostic = (input) => {
    protectedInputs.push(input);
    return input.diagnosticId!;
  };
  const childSessionId = "11111111-1111-4111-8111-111111111111";
  const parentSessionId = "22222222-2222-4222-8222-222222222222";
  try {
    const error = new Error("System-update outbox replay changed its connection authority subject");
    obs.error("Failed to wake parent", { childSessionId, parentSessionId, error });
    expect(records[0]).toMatchObject({
      failureKind: "Error",
      failureReason: "connection_authority_replay_mismatch",
    });
    expect(records[0]!.failureFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(records[0]!.sessionKey).toMatch(/^[a-f0-9]{16}$/);
    expect(records[0]!.parentSessionKey).toMatch(/^[a-f0-9]{16}$/);
    expect(protectedInputs[0]).toMatchObject({
      sessionId: childSessionId,
      parentSessionId,
      error,
      diagnosticId: records[0]!.failureDiagnosticId,
    });
    expect(JSON.stringify(records)).not.toContain(childSessionId);
    expect(JSON.stringify(records)).not.toContain(parentSessionId);

    const secret = "credential=never-publish-this SQL select user_message";
    obs.error("Another failure", { error: secret, secret, childSessionId });
    obs.error("Another failure", { error: secret, secret, childSessionId });
    expect(records[1]!.failureFingerprint).toBe(records[2]!.failureFingerprint);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(records[1]).not.toHaveProperty("failureReason");

    const postgres = Object.assign(new Error(secret), { name: "PostgresError", code: "40P01" });
    obs.error("Database failure", { error: new Error("wrapper", { cause: postgres }) });
    expect(records[3]).toMatchObject({ failureSqlState: "40P01" });
    expect(JSON.stringify(records)).not.toContain(secret);

    obs.recordFailureDiagnostic = () => {
      throw new Error("export unavailable");
    };
    obs.error("Export unavailable", { error });
    expect(records[4]).toHaveProperty("failureReason", "connection_authority_replay_mismatch");
    obs.log("error", "Untrusted projection", { failureReason: "invented", failureSource: secret });
    expect(records[5]).not.toHaveProperty("failureReason");
    expect(JSON.stringify(records)).not.toContain(secret);
  } finally {
    console.error = original;
  }
});
