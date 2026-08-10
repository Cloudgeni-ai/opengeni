import { createHash } from "node:crypto";
import {
  RigProviderImage as RigProviderImageContract,
  stableJson,
  type RigChangeVerification,
  type RigProviderImage,
  type RigProviderImages,
  type RigVersion,
  type SandboxBackend,
} from "@opengeni/contracts";

export type RigProviderImageDefinition = Pick<
  RigVersion,
  "image" | "setupScript" | "checks" | "credentialHooks" | "defaultVariableSetIds"
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
      version: 1,
      backend: input.backend,
      sourceImage: input.sourceImage,
      image: input.definition.image,
      setupScript: input.definition.setupScript,
      checks: input.definition.checks,
      credentialHooks: input.definition.credentialHooks,
      defaultVariableSetIds: input.definition.defaultVariableSetIds,
    }),
  );
}

/** Modal's patched snapshot API accepts a caller-owned UUID idempotency key. */
export function rigProviderImageBuildRequestId(input: {
  targetId: string;
  backend: SandboxBackend;
  contentHash: string;
}): string {
  const bytes = createHash("sha256")
    .update("opengeni-rig-provider-image-build-v1\0", "utf8")
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

/**
 * Promotion copies only a finalized, structurally valid build record whose
 * hashes match the exact version definition being inserted. A malformed or
 * stale optimization record is discarded; the version remains correct and
 * falls back to runtime setup.
 */
export function rigProviderImagesFromVerification(
  verification: RigChangeVerification | null,
  definition: RigProviderImageDefinition,
): RigProviderImages {
  const parsed = RigProviderImageContract.safeParse(verification?.providerImage);
  if (!parsed.success || parsed.data.status === "building") return {};
  if (!rigProviderImageMatchesDefinition(parsed.data, definition)) return {};
  return { [parsed.data.backend]: parsed.data };
}
