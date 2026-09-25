import { expect, test } from "bun:test";
import {
  SandboxRecoveryRequest,
  automaticSandboxRecoveryDiscontinuity,
  sandboxRecoveryDiscontinuity,
} from "../src/sandbox-recovery";
const selection = {
  version: 1 as const,
  sessionId: crypto.randomUUID(),
  sandboxGroupId: crypto.randomUUID(),
  leaseId: crypto.randomUUID(),
  routeEpoch: 0,
  authorityEpoch: 1,
  leaseEpoch: 3,
  workspaceGeneration: 44,
  archiveGeneration: 10,
  artifactId: crypto.randomUUID(),
  revision: "wa2:exact",
  capturedAt: "2026-09-16T06:24:07.000Z",
};
test("explicit bounded checkpoint consent only; no secret bindings or actor substitutions", () => {
  const request = { operationId: crypto.randomUUID(), acceptHistoricalCheckpoint: true, selection };
  expect(SandboxRecoveryRequest.safeParse(request).success).toBe(true);
  expect(
    SandboxRecoveryRequest.safeParse({ ...request, acceptHistoricalCheckpoint: false }).success,
  ).toBe(false);
  expect(SandboxRecoveryRequest.safeParse({ ...request, subjectId: "user:other" }).success).toBe(
    false,
  );
  expect(
    SandboxRecoveryRequest.safeParse({
      ...request,
      selection: { ...selection, providerBinding: {} },
    }).success,
  ).toBe(false);
});
test("durable model warning is exact and never claims edits counted, external rollback or replay safety", () => {
  const text = sandboxRecoveryDiscontinuity(selection);
  expect(text).toContain(selection.capturedAt);
  expect(text).toContain("not a count of lost files");
  expect(text).toContain("External effects are not undone");
  expect(text).toContain("unknown outcomes");
  expect(text).toContain("Consent alone is not proof");
  const automatic = automaticSandboxRecoveryDiscontinuity(selection);
  expect(automatic).toContain(selection.capturedAt);
  expect(automatic).toContain("automatically");
  expect(automatic).toContain("not a count of lost files");
  expect(automatic).toContain("External effects are not undone");
  expect(automatic).toContain("unknown outcomes");
  expect(automatic).not.toContain("human explicitly consented");
});
