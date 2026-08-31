import type { RigPlatformSurfaceValidationReceipt } from "@opengeni/contracts/rig-platform-surface-validation";
import {
  beginRigVersionVerificationAttempt,
  completeRigVersionVerification,
  createRig,
  createRigVersion,
  getRig,
  listRigVersions,
  type Database,
} from "@opengeni/db";

export function testRigSurfaceReceipt(versionId: string): RigPlatformSurfaceValidationReceipt {
  return {
    version: 2,
    checkedAt: "2026-08-30T12:00:00.000Z",
    binding: {
      leaseId: "11111111-2222-4333-8444-555555555555",
      sandboxGroupId: versionId,
      leaseEpoch: 1,
      workspaceGeneration: 1,
      instanceId: "test-rig-verifier",
      backendId: "docker",
      rigVersionId: versionId,
    },
    provenance: {
      authority: "deployment_control_plane",
      providerImage: "example.invalid/opengeni:test",
    },
    terminal: { status: "disabled" },
    browser: {
      status: "passed",
      browserSessionId: "22222222-3333-4444-8555-666666666666",
      controllerGeneration: "test-rig-verifier",
      targetId: "page-1",
      observedTargetGeneration: "page-generation-1",
    },
    computer: { status: "disabled" },
  };
}

/** Seed an already-verified active Rig for tests that are unrelated to the
 * verification lifecycle itself. Production code must use the real worker. */
export async function createVerifiedTestRig(db: Database, input: Parameters<typeof createRig>[1]) {
  const rig = await createRig(db, {
    ...input,
    activateInitialVersion: false,
  });
  const [version] = await listRigVersions(db, input.workspaceId, rig.id);
  if (!version) throw new Error("test Rig initial version was not created");
  const attempt = await beginRigVersionVerificationAttempt(
    db,
    { workspaceId: input.workspaceId, rigId: rig.id, versionId: version.id },
    { allowAlreadyPending: true },
  );
  await completeRigVersionVerification(db, {
    workspaceId: input.workspaceId,
    rigId: rig.id,
    versionId: version.id,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    receipt: testRigSurfaceReceipt(version.id),
  });
  const activated = await getRig(db, input.workspaceId, rig.id);
  if (!activated) throw new Error("test Rig disappeared after verification");
  return activated;
}

export async function createVerifiedTestRigVersion(
  db: Database,
  workspaceId: string,
  rigId: string,
  input: Parameters<typeof createRigVersion>[3],
) {
  const version = await createRigVersion(db, workspaceId, rigId, input);
  const attempt = await beginRigVersionVerificationAttempt(db, {
    workspaceId,
    rigId,
    versionId: version.id,
  });
  const completed = await completeRigVersionVerification(db, {
    workspaceId,
    rigId,
    versionId: version.id,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    receipt: testRigSurfaceReceipt(version.id),
  });
  return completed.version;
}
