import type { RigProviderImage } from "@opengeni/contracts";
import type { RigPlatformSurfaceValidationReceipt } from "@opengeni/contracts/rig-platform-surface-validation";
import {
  beginRigVersionVerificationAttempt,
  claimRigVersionProviderImageBuild,
  completeRigVersionVerification,
  createRig,
  createRigVersion,
  finalizeRigVersionProviderImageBuild,
  getRig,
  listRigVersions,
  type Database,
} from "@opengeni/db";

const TEST_RIG_PROVIDER_IMAGE_ID = `sha256:${"d".repeat(64)}`;
const TEST_RIG_PROVIDER_IMAGE_HASH = `sha256:${"a".repeat(64)}`;
const TEST_RIG_PROVIDER_SETUP_HASH = `sha256:${"b".repeat(64)}`;

export function testRigProviderImage(
  targetId: string,
  targetKind: "change" | "version" = "version",
): RigProviderImage {
  return {
    backend: "docker",
    provider: "docker",
    status: "ready",
    contentHash: TEST_RIG_PROVIDER_IMAGE_HASH,
    setupHash: TEST_RIG_PROVIDER_SETUP_HASH,
    sourceImage: "example.invalid/opengeni:test",
    buildRequestId: targetId,
    imageId: TEST_RIG_PROVIDER_IMAGE_ID,
    imageDigest: null,
    artifactId: null,
    providerBindingKeyHash: null,
    coldBootValidation: {
      version: 3,
      checkedAt: "2026-08-30T12:00:00.000Z",
    },
    provenance: {
      kind: "rig_verification",
      targetKind,
      targetId,
    },
    startedAt: "2026-08-30T11:59:00.000Z",
    finishedAt: "2026-08-30T12:00:00.000Z",
    error: null,
  };
}

export function testRigSurfaceReceipt(
  versionId: string,
  image: RigProviderImage = testRigProviderImage(versionId),
): RigPlatformSurfaceValidationReceipt {
  const imageIdentity = image.imageId ?? image.imageDigest;
  if (!imageIdentity) throw new Error("test Rig provider image has no immutable identity");
  return {
    version: 3,
    checkedAt: "2026-08-30T12:00:00.000Z",
    binding: {
      leaseId: "11111111-2222-4333-8444-555555555555",
      sandboxGroupId: image.buildRequestId,
      leaseEpoch: 1,
      workspaceGeneration: 1,
      instanceId: "test-rig-verifier",
      backendId: image.backend,
      rigVersionId: versionId,
    },
    provenance: {
      authority: "deployment_control_plane",
      providerImage: imageIdentity,
      providerImageId: imageIdentity,
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

export async function installTestRigProviderImage(
  db: Database,
  workspaceId: string,
  versionId: string,
): Promise<RigProviderImage> {
  const image = testRigProviderImage(versionId);
  const claim = await claimRigVersionProviderImageBuild(db, {
    workspaceId,
    versionId,
    staleAfterMs: 1,
    retryUnsupported: true,
    image: {
      ...image,
      status: "building",
      imageId: null,
      coldBootValidation: undefined,
      finishedAt: null,
    },
  });
  if (claim.status === "ready") return claim.image;
  if (claim.status !== "claimed") {
    throw new Error(`test Rig provider image could not be claimed (${claim.status})`);
  }
  const finalized = await finalizeRigVersionProviderImageBuild(db, {
    workspaceId,
    versionId,
    image,
  });
  if (!finalized) throw new Error("test Rig provider image could not be finalized");
  return image;
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
  const image = await installTestRigProviderImage(db, input.workspaceId, version.id);
  await completeRigVersionVerification(db, {
    workspaceId: input.workspaceId,
    rigId: rig.id,
    versionId: version.id,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    receipt: testRigSurfaceReceipt(version.id, image),
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
  const image = await installTestRigProviderImage(db, workspaceId, version.id);
  const completed = await completeRigVersionVerification(db, {
    workspaceId,
    rigId,
    versionId: version.id,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    receipt: testRigSurfaceReceipt(version.id, image),
  });
  return completed.version;
}
