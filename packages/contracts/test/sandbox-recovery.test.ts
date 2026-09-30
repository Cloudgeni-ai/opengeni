import { expect, test } from "bun:test";
import {
  SandboxFreshWorkspaceRecovery,
  SandboxRecoveryProjection,
  SandboxRecoveryRequest,
  automaticSandboxRecoveryDiscontinuity,
  freshWorkspaceSandboxRecoveryDiscontinuity,
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
test("recovery projection distinguishes automatic Retry from explicit human consent", () => {
  expect(
    SandboxRecoveryProjection.parse({
      version: 1,
      status: "eligible",
      reason: null,
      checkpoint: selection,
      operationId: null,
      automaticAvailable: true,
    }).automaticAvailable,
  ).toBe(true);
});

test("automatic lanes are a closed public set; an empty workspace carries no checkpoint", () => {
  expect(
    SandboxRecoveryProjection.parse({
      version: 1,
      status: "eligible",
      reason: null,
      checkpoint: null,
      operationId: null,
      automaticAvailable: true,
      automaticLane: "fresh_workspace",
    }).automaticLane,
  ).toBe("fresh_workspace");
  expect(
    SandboxRecoveryProjection.safeParse({
      version: 1,
      status: "eligible",
      reason: null,
      checkpoint: null,
      operationId: null,
      automaticAvailable: true,
      automaticLane: "reset",
    }).success,
  ).toBe(false);
});

test("shared checkpoint and empty-workspace warnings never claim success, counts or replay safety", () => {
  const shared = automaticSandboxRecoveryDiscontinuity(selection, "shared");
  expect(shared).toContain("shares with other sessions");
  expect(shared).toContain(selection.capturedAt);
  expect(shared).toContain("unknown outcomes");
  const recovery = SandboxFreshWorkspaceRecovery.parse({
    version: 1,
    sessionId: selection.sessionId,
    sandboxGroupId: selection.sandboxGroupId,
    leaseId: selection.leaseId,
    leaseEpoch: 3,
    workspaceGeneration: 44,
    archiveGeneration: null,
    lostAt: "2026-09-17T06:24:31.000Z",
    reason: "archive_unavailable",
  });
  const fresh = freshWorkspaceSandboxRecoveryDiscontinuity(recovery);
  expect(fresh).toContain("lost at 2026-09-17T06:24:31.000Z");
  expect(fresh).toContain("no checkpoint OpenGeni can restore automatically");
  expect(fresh).toContain("new empty workspace");
  expect(fresh).toContain("do not assume they exist");
  expect(fresh).toContain("External effects are not undone");
  expect(fresh).toContain("Never automatically replay prior commands");
  expect(
    SandboxFreshWorkspaceRecovery.safeParse({ ...recovery, providerBinding: {} }).success,
  ).toBe(false);
  expect(SandboxFreshWorkspaceRecovery.safeParse({ ...recovery, reason: "other" }).success).toBe(
    false,
  );
});
