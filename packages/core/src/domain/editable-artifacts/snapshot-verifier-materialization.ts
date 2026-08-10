import { createHash } from "node:crypto";
import { EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES } from "@opengeni/contracts/editable-artifacts";

declare const editableArtifactMaterializationKeyBrand: unique symbol;

export type EditableArtifactMaterializationKey = string & {
  readonly [editableArtifactMaterializationKeyBrand]: true;
};

export type EditableArtifactMaterializationKeyInput = Readonly<{
  stateHash: string;
  format: string;
  /** SHA-256 of the canonical, normalized export options. */
  optionsHash: string;
  codecVersion: string;
  kernelVersion: string;
  fontRegistryHash: string;
  policyHash: string;
}>;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FORMAT_PATTERN = /^[a-z0-9][a-z0-9.+_-]{0,63}$/;
const VERSION_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Complete materialization identity from docs/artifact-engine.md. Length
 * framing prevents concatenation ambiguity and the output is safe as a DB
 * idempotency key; it is deliberately not an object-storage key.
 */
export function editableArtifactMaterializationKey(
  input: EditableArtifactMaterializationKeyInput,
): EditableArtifactMaterializationKey {
  for (const [label, value] of [
    ["state hash", input.stateHash],
    ["options hash", input.optionsHash],
    ["font registry hash", input.fontRegistryHash],
    ["policy hash", input.policyHash],
  ] as const) {
    if (!SHA256_PATTERN.test(value)) {
      throw new TypeError(`${label} must be a canonical SHA-256 digest`);
    }
  }
  if (!FORMAT_PATTERN.test(input.format)) {
    throw new TypeError("materialization format is invalid");
  }
  if (!VERSION_PATTERN.test(input.codecVersion) || input.codecVersion.length > 128) {
    throw new TypeError("codec version is invalid");
  }
  if (
    !VERSION_PATTERN.test(input.kernelVersion) ||
    input.kernelVersion.length > EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES
  ) {
    throw new TypeError("kernel version is invalid");
  }
  const fields = [
    input.stateHash,
    input.format,
    input.optionsHash,
    input.codecVersion,
    input.kernelVersion,
    input.fontRegistryHash,
    input.policyHash,
  ];
  const digest = createHash("sha256");
  digest.update("OpenGeni editable artifact materialization\0v1\0", "utf8");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    digest.update(length);
    digest.update(bytes);
  }
  return `materialization:v1:sha256:${digest.digest("hex")}` as EditableArtifactMaterializationKey;
}
