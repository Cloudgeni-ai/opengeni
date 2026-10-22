import { expect, test } from "bun:test";
import {
  SandboxCheckpointSelection,
  SandboxFreshWorkspaceRecovery,
  SandboxRecoveryProjection,
  SandboxRecoveryRequest,
  SandboxRecoverySelection,
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

test("current archive retry and fresh continuation require an exact bounded target", () => {
  const {
    version: _version,
    artifactId: _artifactId,
    capturedAt: _capturedAt,
    ...identity
  } = selection;
  const target = { ...identity, restoreStatus: "unrecoverable", restoreCompletedAt: null };
  const request = { operationId: crypto.randomUUID(), action: "retry", target };
  expect(SandboxRecoveryRequest.safeParse(request).success).toBe(true);
  expect(SandboxRecoveryRequest.safeParse({ ...request, action: "continue_fresh" }).success).toBe(
    false,
  );
  expect(
    SandboxRecoveryRequest.safeParse({
      ...request,
      action: "continue_fresh",
      acceptEmptyWorkspace: true,
    }).success,
  ).toBe(true);
  expect(
    SandboxRecoveryRequest.safeParse({
      ...request,
      action: "continue_fresh",
      acceptEmptyWorkspace: false,
    }).success,
  ).toBe(false);
  expect(SandboxRecoveryRequest.safeParse({ ...request, subjectId: "user:other" }).success).toBe(
    false,
  );
  expect(
    SandboxRecoveryRequest.safeParse({ ...request, target: { ...target, objectKey: "secret" } })
      .success,
  ).toBe(false);
  expect(
    SandboxRecoveryRequest.safeParse({
      ...request,
      target: { ...target, revision: "x".repeat(513) },
    }).success,
  ).toBe(false);
});

test("deliberate empty continuation distinguishes a retained archive from successful restoration", () => {
  const warning = freshWorkspaceSandboxRecoveryDiscontinuity({
    version: 1,
    sessionId: selection.sessionId,
    sandboxGroupId: selection.sandboxGroupId,
    leaseId: selection.leaseId,
    leaseEpoch: 3,
    workspaceGeneration: 44,
    archiveGeneration: 10,
    lostAt: selection.capturedAt,
    reason: "restore_abandoned",
  });
  expect(warning).toContain("authorized person chose");
  expect(warning).toContain("previous archive is retained");
  expect(warning).toContain("External effects are not undone");
  expect(warning).toContain("never automatically replay");
  expect(warning).toContain("Selection alone does not prove");
  expect(warning).not.toContain("no checkpoint");
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
  expect(fresh).toContain("no checkpoint Opengeni can restore automatically");
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
test("a portable checkpoint is named only by automaticCheckpoint, never the public selection", () => {
  const portable = { ...selection, artifactId: null };
  expect(SandboxRecoverySelection.safeParse(portable).success).toBe(false);
  expect(SandboxCheckpointSelection.parse(portable)).toEqual(portable);
  const projection = {
    version: 1,
    status: "eligible",
    reason: null,
    checkpoint: null,
    operationId: null,
    automaticAvailable: true,
    automaticLane: "checkpoint",
    automaticCheckpoint: portable,
  };
  expect(SandboxRecoveryProjection.parse(projection)).toEqual(projection);
  expect(SandboxRecoveryProjection.safeParse({ ...projection, checkpoint: portable }).success).toBe(
    false,
  );
  expect(automaticSandboxRecoveryDiscontinuity(portable)).toContain(selection.capturedAt);
});
