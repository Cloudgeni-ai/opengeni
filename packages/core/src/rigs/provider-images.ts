import { createHash } from "node:crypto";
import {
  RIG_PROVIDER_IMAGE_COLD_BOOT_VALIDATION_VERSION,
  RigProviderImage as RigProviderImageContract,
  stableJson,
  type RigChangeVerification,
  type RigProviderImage,
  type RigProviderImages,
  type RigVersion,
  type SandboxBackend,
} from "@opengeni/contracts";
import {
  hasTrustedRigPlatformSurfaceValidationProvenance,
  RigPlatformSurfaceValidationReceipt,
  type RigPlatformSurfaceValidationReceipt as RigPlatformSurfaceValidationReceiptValue,
} from "@opengeni/contracts/rig-platform-surface-validation";

export type RigProviderImageDefinition = Pick<
  RigVersion,
  "setupScript" | "checks" | "credentialHooks" | "defaultVariableSetIds"
>;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function rigProviderImageProviderBindingKeyHash(bindingKey: string): string {
  return sha256(bindingKey);
}

export function rigProviderImageSetupHash(
  definition: Pick<RigProviderImageDefinition, "setupScript">,
): string {
  return sha256(definition.setupScript ?? "");
}

/**
 * Hash every exact rig-definition input that can affect whether a provider
 * image may be reused. Credential values and variable-set contents are
 * intentionally absent: verification never injects them into the build box.
 * Their declared hook/set identities still participate so a new rig version
 * cannot silently inherit an older build record.
 */
export function rigProviderImageContentHash(input: {
  backend: SandboxBackend;
  sourceImage: string | null;
  definition: RigProviderImageDefinition;
}): string {
  return sha256(
    stableJson({
      version: 2,
      backend: input.backend,
      sourceImage: input.sourceImage,
      setupScript: input.definition.setupScript,
      checks: input.definition.checks,
      credentialHooks: input.definition.credentialHooks,
      defaultVariableSetIds: input.definition.defaultVariableSetIds,
    }),
  );
}

/** Modal's patched snapshot API accepts a caller-owned UUID idempotency key.
 * v4 denotes images whose activation receipt is bound to the exact derived
 * provider image rather than the mutable source verifier or platform base. */
export function rigProviderImageBuildRequestId(input: {
  targetId: string;
  backend: SandboxBackend;
  contentHash: string;
}): string {
  const bytes = createHash("sha256")
    .update("opengeni-rig-provider-image-build-v4\0", "utf8")
    .update(input.targetId, "utf8")
    .update("\0", "utf8")
    .update(input.backend, "utf8")
    .update("\0", "utf8")
    .update(input.contentHash, "utf8")
    .digest()
    .subarray(0, 16);
  // RFC 4122 variant + deterministic version-5-shaped UUID. The digest, not a
  // provider response, is the idempotency identity.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function rigProviderImageMatchesDefinition(
  image: RigProviderImage,
  definition: RigProviderImageDefinition,
): boolean {
  return (
    image.setupHash === rigProviderImageSetupHash(definition) &&
    image.contentHash ===
      rigProviderImageContentHash({
        backend: image.backend,
        sourceImage: image.sourceImage,
        definition,
      })
  );
}

/** Match activation evidence to the exact immutable image that was booted.
 * The build request owns the cold-boot sandbox group, while rigVersionId and
 * provider-image provenance bind that observation to the promoted target. */
export function rigProviderImageMatchesSurfaceValidation(
  image: RigProviderImage,
  receipt: RigPlatformSurfaceValidationReceiptValue,
  expectedTargetId: string,
  expectedTargetKind?: "change" | "version",
): boolean {
  const imageIdentity = image.imageId ?? image.imageDigest;
  return (
    hasTrustedRigPlatformSurfaceValidationProvenance(receipt) &&
    image.status === "ready" &&
    image.coldBootValidation?.version === RIG_PROVIDER_IMAGE_COLD_BOOT_VALIDATION_VERSION &&
    image.provenance.targetId === expectedTargetId &&
    (expectedTargetKind === undefined || image.provenance.targetKind === expectedTargetKind) &&
    receipt.binding.rigVersionId === expectedTargetId &&
    receipt.binding.sandboxGroupId === image.buildRequestId &&
    receipt.binding.backendId === image.backend &&
    imageIdentity !== null &&
    receipt.provenance.providerImage === imageIdentity &&
    receipt.provenance.providerImageId === imageIdentity
  );
}

/**
 * Promotion copies only a finalized, structurally valid build record whose
 * hashes match the exact version definition being inserted. A malformed or
 * stale optimization record is discarded; the version remains correct and
 * falls back to runtime setup.
 */
export function rigProviderImagesFromVerification(
  verification: RigChangeVerification | null,
  definition: RigProviderImageDefinition,
  expectedTargetId: string,
): RigProviderImages {
  const parsed = RigProviderImageContract.safeParse(verification?.providerImage);
  const receipt = RigPlatformSurfaceValidationReceipt.safeParse(
    verification?.platformSurfaceValidation,
  );
  if (
    !parsed.success ||
    !receipt.success ||
    !rigProviderImageMatchesSurfaceValidation(parsed.data, receipt.data, expectedTargetId, "change")
  ) {
    return {};
  }
  if (!rigProviderImageMatchesDefinition(parsed.data, definition)) return {};
  return { [parsed.data.backend]: parsed.data };
}
