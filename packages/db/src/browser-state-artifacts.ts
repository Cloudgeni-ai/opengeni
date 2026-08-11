import {
  BrowserRevisionMaterialization,
  type BrowserRevisionMaterialization as BrowserRevisionMaterializationValue,
} from "@opengeni/contracts";
import type * as schema from "./schema";

type BrowserStateArtifactRow = typeof schema.browserStateArtifacts.$inferSelect;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OBJECT_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9._=-]+$/u;

export type BrowserStateArtifactCommitInput = {
  kind: BrowserStateArtifactRow["kind"];
  format: string;
  artifactDigest: string;
  contentDigest: string;
  manifestDigest: string;
  objectKey: string;
  encryptedDataKey: string;
  sizeBytes: number;
  materialization: BrowserRevisionMaterializationValue;
};

/** Validate storage authority before it can become durable state. */
export function validateBrowserStateArtifactCommitInput(
  workspaceId: string,
  value: BrowserStateArtifactCommitInput,
): BrowserStateArtifactCommitInput {
  const prefix = `workspaces/${workspaceId}/browser-state/`;
  const objectKeySuffix = value.objectKey.slice(prefix.length);
  if (
    !SHA256_PATTERN.test(value.artifactDigest) ||
    !SHA256_PATTERN.test(value.contentDigest) ||
    !SHA256_PATTERN.test(value.manifestDigest) ||
    !value.objectKey.startsWith(prefix) ||
    objectKeySuffix.length < 1 ||
    objectKeySuffix
      .split("/")
      .some(
        (segment) =>
          !OBJECT_KEY_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..",
      ) ||
    Buffer.byteLength(value.objectKey) > 2_048 ||
    value.format.trim() !== value.format ||
    Buffer.byteLength(value.format) < 1 ||
    Buffer.byteLength(value.format) > 512 ||
    Buffer.byteLength(value.encryptedDataKey) < 16 ||
    Buffer.byteLength(value.encryptedDataKey) > 8_192 ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1
  ) {
    throw new Error("Browser state artifact metadata is invalid");
  }
  const materialization = BrowserRevisionMaterialization.parse(value.materialization);
  if (value.kind === "provider_snapshot" && materialization.portability !== "provider_bound") {
    throw new Error("Provider snapshots must declare their provider binding");
  }
  return { ...value, materialization };
}
