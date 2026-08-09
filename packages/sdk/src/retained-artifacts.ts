import type { GeneratedImageReceipt, RetainedArtifactReference } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATETIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const WORKSPACE_PATH = /^\/v1\/workspaces\/([0-9a-f-]+)\/artifacts\/([0-9a-f-]+)\/content$/;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 67_108_864;
const MAX_RANGE_BYTES = 1024 * 1024;

/** Zero-dependency validation for the SDK's permanent generated-image wire receipt. */
export function parseRetainedGeneratedImageReference(
  value: unknown,
  expectedWorkspaceId?: string,
): RetainedArtifactReference | null {
  if (!recordWithKeys(value, GENERATED_IMAGE_REFERENCE_KEYS)) return null;
  const artifact = value as Record<string, unknown>;
  if (
    artifact.available !== true ||
    artifact.kind !== "generated_image" ||
    typeof artifact.artifactId !== "string" ||
    !UUID.test(artifact.artifactId) ||
    !["image/png", "image/jpeg", "image/webp"].includes(String(artifact.contentType)) ||
    !safeIntegerBetween(artifact.originalBytes, 1, MAX_BYTES) ||
    typeof artifact.sha256 !== "string" ||
    !SHA256.test(artifact.sha256) ||
    typeof artifact.retainedAt !== "string" ||
    artifact.retainedAt.length > 64 ||
    !ISO_DATETIME_WITH_OFFSET.test(artifact.retainedAt) ||
    !Number.isFinite(Date.parse(artifact.retainedAt)) ||
    !recordWithKeys(artifact.dimensions, DIMENSION_KEYS) ||
    !recordWithKeys(artifact.retention, RETENTION_KEYS) ||
    !recordWithKeys(artifact.retrieval, RETRIEVAL_KEYS)
  ) {
    return null;
  }
  const dimensions = artifact.dimensions as Record<string, unknown>;
  if (
    !safeIntegerBetween(dimensions.width, 1, MAX_DIMENSION) ||
    !safeIntegerBetween(dimensions.height, 1, MAX_DIMENSION) ||
    Number(dimensions.width) * Number(dimensions.height) > MAX_PIXELS
  ) {
    return null;
  }
  const retention = artifact.retention as Record<string, unknown>;
  if (retention.policy !== "workspace_file" || retention.expiresAt !== null) return null;
  const retrieval = artifact.retrieval as Record<string, unknown>;
  if (
    retrieval.method !== "GET" ||
    retrieval.acceptRanges !== "bytes" ||
    retrieval.maxRangeBytes !== MAX_RANGE_BYTES ||
    typeof retrieval.path !== "string" ||
    retrieval.path.length > 256
  ) {
    return null;
  }
  const match = WORKSPACE_PATH.exec(retrieval.path);
  if (
    !match ||
    !UUID.test(match[1] ?? "") ||
    match[2] !== artifact.artifactId ||
    (expectedWorkspaceId !== undefined && match[1] !== expectedWorkspaceId)
  ) {
    return null;
  }
  return value as RetainedArtifactReference;
}

export function generatedImageSandboxPathMatches(
  artifact: RetainedArtifactReference,
  sandboxPath: unknown,
): sandboxPath is string {
  if (typeof sandboxPath !== "string") return false;
  const extension =
    artifact.contentType === "image/png"
      ? "png"
      : artifact.contentType === "image/jpeg"
        ? "jpg"
        : artifact.contentType === "image/webp"
          ? "webp"
          : null;
  return (
    extension !== null &&
    sandboxPath ===
      `/workspace/generated-images/generated-image-${artifact.artifactId}.${extension}`
  );
}

/** Parse the complete closed generated-image tool result. */
export function parseGeneratedImageReceipt(
  value: unknown,
  expectedWorkspaceId?: string,
): GeneratedImageReceipt | null {
  if (typeof value === "string" && value.length <= 4_096) {
    try {
      return parseGeneratedImageReceipt(JSON.parse(value), expectedWorkspaceId);
    } catch {
      return null;
    }
  }
  if (!recordWithKeys(value, GENERATED_IMAGE_RECEIPT_KEYS)) return null;
  if (value.type !== "generated_image") return null;
  const artifact = parseRetainedGeneratedImageReference(value.artifact, expectedWorkspaceId);
  if (!artifact || !generatedImageSandboxPathMatches(artifact, value.sandboxPath)) return null;
  return { type: "generated_image", artifact, sandboxPath: value.sandboxPath };
}

const GENERATED_IMAGE_REFERENCE_KEYS = new Set([
  "available",
  "artifactId",
  "kind",
  "contentType",
  "originalBytes",
  "sha256",
  "retainedAt",
  "dimensions",
  "retention",
  "retrieval",
]);
const DIMENSION_KEYS = new Set(["width", "height"]);
const RETENTION_KEYS = new Set(["policy", "expiresAt"]);
const RETRIEVAL_KEYS = new Set(["method", "path", "acceptRanges", "maxRangeBytes"]);
const GENERATED_IMAGE_RECEIPT_KEYS = new Set(["type", "artifact", "sandboxPath"]);

function recordWithKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === allowed.size &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function safeIntegerBetween(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
