import { z } from "zod";

/** Hard server-side ceiling for one retained-output response body. */
export const RETAINED_OUTPUT_MAX_PAGE_BYTES = 1024 * 1024;
/** Default first page when the client does not send a Range header. */
export const RETAINED_OUTPUT_DEFAULT_PAGE_BYTES = 256 * 1024;
/** Receipts are timeline references, never an extensible metadata bag. */
export const RETAINED_OUTPUT_RECEIPT_MAX_BYTES = 2 * 1024;

const encoder = new TextEncoder();
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const CANONICAL_MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
const RETRIEVAL_PATH = /^\/v1\/workspaces\/([0-9a-f-]+)\/artifacts\/([0-9a-f-]+)\/content$/;

export const RetainedOutputKind = z.enum([
  "tool_result",
  "assistant_completion",
  "internal_update",
  "event_media",
  "file",
]);
export type RetainedOutputKind = z.infer<typeof RetainedOutputKind>;

export const RetainedOutputUnavailableReason = z.enum([
  "not_retained",
  "pending",
  "failed",
  "expired",
  "deleted",
  "missing_storage",
  "storage_write_failed",
  "unsupported",
]);
export type RetainedOutputUnavailableReason = z.infer<typeof RetainedOutputUnavailableReason>;

const RetainedOutputUnavailableEvidenceSchema = z
  .object({
    available: z.literal(false),
    reason: RetainedOutputUnavailableReason,
  })
  .strict();

export const RetainedArtifactReferenceSchema = z
  .object({
    available: z.literal(true),
    artifactId: z.string().regex(LOWERCASE_UUID),
    kind: RetainedOutputKind,
    contentType: z.string().max(127).regex(CANONICAL_MEDIA_TYPE),
    originalBytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(LOWERCASE_SHA256),
    retainedAt: z.string().datetime({ offset: true }),
    retention: z
      .object({
        policy: z.literal("workspace_file"),
        expiresAt: z.null(),
      })
      .strict(),
    retrieval: z
      .object({
        method: z.literal("GET"),
        path: z.string().max(256),
        acceptRanges: z.literal("bytes"),
        maxRangeBytes: z.number().int().positive().max(RETAINED_OUTPUT_MAX_PAGE_BYTES),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const match = RETRIEVAL_PATH.exec(value.retrieval.path);
    if (!match || !LOWERCASE_UUID.test(match[1] ?? "") || match[2] !== value.artifactId) {
      ctx.addIssue({
        code: "custom",
        path: ["retrieval", "path"],
        message: "retrieval path must be a workspace API content path for this artifact",
      });
    }

    if (encoder.encode(JSON.stringify(value)).byteLength > RETAINED_OUTPUT_RECEIPT_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: "retained-output receipt exceeds its byte envelope",
      });
    }
  });

/**
 * Canonical evidence fact carried by bounded audit/NATS/SSE/UI previews.
 *
 * The available variant is intentionally provider-neutral and closed: no bucket,
 * object key, signed URL, arbitrary metadata, or producer-controlled labels can
 * cross this boundary.
 */
export const RetainedOutputEvidenceSchema = z.discriminatedUnion("available", [
  RetainedOutputUnavailableEvidenceSchema,
  RetainedArtifactReferenceSchema,
]);
export type RetainedOutputEvidence = z.infer<typeof RetainedOutputEvidenceSchema>;
export type RetainedArtifactReference = z.infer<typeof RetainedArtifactReferenceSchema>;
/** @deprecated use RetainedArtifactReference. */
export type RetainedOutputAvailableEvidence = RetainedArtifactReference;

export const RetainedArtifactUnavailableSchema = z
  .object({
    available: z.literal(false),
    artifactId: z.string().regex(LOWERCASE_UUID),
    reason: RetainedOutputUnavailableReason,
  })
  .strict();
export type RetainedArtifactUnavailable = z.infer<typeof RetainedArtifactUnavailableSchema>;

/** Authenticated metadata result for one opaque workspace file identity. */
export const RetainedArtifactMetadataSchema = z.union([
  RetainedArtifactReferenceSchema,
  RetainedArtifactUnavailableSchema,
]);
export type RetainedArtifactMetadata = z.infer<typeof RetainedArtifactMetadataSchema>;

export type RetainedArtifactFileInput = {
  id: string;
  workspaceId: string;
  status: string;
  contentType: string;
  sizeBytes: number;
  sha256: string | null;
  updatedAt: string;
};

/**
 * Convert a ready, integrity-addressed workspace file into the only available
 * retained-output receipt shape. Invalid, pending, or checksum-less files fail
 * closed instead of implying that full evidence is retrievable.
 */
export function retainedArtifactReferenceFromFile(
  file: RetainedArtifactFileInput,
  kind: RetainedOutputKind = "file",
): RetainedArtifactReference | null {
  if (file.status !== "ready" || !file.sha256) return null;
  const value = {
    available: true as const,
    artifactId: file.id,
    kind,
    contentType: canonicalRetainedContentType(file.contentType),
    originalBytes: file.sizeBytes,
    sha256: file.sha256,
    retainedAt: file.updatedAt,
    retention: {
      policy: "workspace_file" as const,
      expiresAt: null,
    },
    retrieval: {
      method: "GET" as const,
      path: `/v1/workspaces/${file.workspaceId}/artifacts/${file.id}/content`,
      acceptRanges: "bytes" as const,
      maxRangeBytes: RETAINED_OUTPUT_MAX_PAGE_BYTES,
    },
  };
  const parsed = RetainedArtifactReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function canonicalRetainedContentType(value: string): string {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return CANONICAL_MEDIA_TYPE.test(mediaType) ? mediaType : "application/octet-stream";
}

/** Parse and clone a trusted server receipt; invalid/untrusted data fails closed. */
export function validateRetainedOutputEvidence(value: unknown): RetainedOutputEvidence | null {
  const parsed = RetainedOutputEvidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function retainedOutputUnavailable(
  reason: RetainedOutputUnavailableReason = "not_retained",
): RetainedOutputEvidence {
  return { available: false, reason };
}

export type RetainedOutputResolvedRange = {
  kind: "range";
  start: number;
  end: number;
  length: number;
  totalBytes: number;
  status: 200 | 206;
  contentRange: string | null;
  acceptRanges: "bytes";
};

export type RetainedOutputRangeResolution =
  | RetainedOutputResolvedRange
  | {
      kind: "empty";
      length: 0;
      totalBytes: 0;
      status: 200;
      contentRange: null;
      acceptRanges: "bytes";
    }
  | {
      kind: "invalid";
      reason: "malformed" | "multipart_not_supported" | "numeric_overflow" | "range_too_large";
      maxPageBytes: number;
    }
  | {
      kind: "unsatisfiable";
      reason: "empty_artifact" | "start_out_of_bounds" | "end_before_start" | "zero_suffix";
      totalBytes: number;
      contentRange: string;
    };

/**
 * Resolve one RFC-style bytes range without ever licensing a response larger
 * than `maxPageBytes`. Multipart ranges and oversized explicit/suffix requests
 * fail closed. An omitted or open-ended range becomes one resumable bounded page.
 */
export function resolveRetainedOutputRange(
  rangeHeader: string | null | undefined,
  totalBytes: number,
  maxPageBytes = RETAINED_OUTPUT_DEFAULT_PAGE_BYTES,
): RetainedOutputRangeResolution {
  assertRangeInputs(totalBytes, maxPageBytes);

  if (rangeHeader === null || rangeHeader === undefined || rangeHeader === "") {
    if (totalBytes === 0) {
      return {
        kind: "empty",
        length: 0,
        totalBytes: 0,
        status: 200,
        contentRange: null,
        acceptRanges: "bytes",
      };
    }
    const end = Math.min(totalBytes - 1, maxPageBytes - 1);
    const partial = end + 1 < totalBytes;
    return resolvedRange(0, end, totalBytes, partial ? 206 : 200);
  }

  if (rangeHeader.length > 128 || /[^\x20-\x7e]/.test(rangeHeader)) {
    return invalidRange("malformed", maxPageBytes);
  }
  if (rangeHeader.includes(",")) {
    return invalidRange("multipart_not_supported", maxPageBytes);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) {
    return invalidRange("malformed", maxPageBytes);
  }

  const first = parseRangeInteger(match[1]);
  const second = parseRangeInteger(match[2]);
  if (first === "overflow" || second === "overflow") {
    return invalidRange("numeric_overflow", maxPageBytes);
  }

  if (first === null) {
    const suffixLength = second;
    if (suffixLength === null) return invalidRange("malformed", maxPageBytes);
    if (suffixLength === 0) return unsatisfiableRange("zero_suffix", totalBytes);
    if (suffixLength > maxPageBytes) return invalidRange("range_too_large", maxPageBytes);
    if (totalBytes === 0) return unsatisfiableRange("empty_artifact", totalBytes);
    const length = Math.min(suffixLength, totalBytes);
    return resolvedRange(totalBytes - length, totalBytes - 1, totalBytes, 206);
  }

  if (totalBytes === 0) return unsatisfiableRange("empty_artifact", totalBytes);
  if (first >= totalBytes) return unsatisfiableRange("start_out_of_bounds", totalBytes);

  if (second === null) {
    const end = Math.min(totalBytes - 1, first + maxPageBytes - 1);
    return resolvedRange(first, end, totalBytes, 206);
  }
  if (second < first) return unsatisfiableRange("end_before_start", totalBytes);
  if (second - first >= maxPageBytes) {
    return invalidRange("range_too_large", maxPageBytes);
  }
  return resolvedRange(first, Math.min(second, totalBytes - 1), totalBytes, 206);
}

function assertRangeInputs(totalBytes: number, maxPageBytes: number): void {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new RangeError("totalBytes must be a nonnegative safe integer");
  }
  if (
    !Number.isSafeInteger(maxPageBytes) ||
    maxPageBytes <= 0 ||
    maxPageBytes > RETAINED_OUTPUT_MAX_PAGE_BYTES
  ) {
    throw new RangeError(
      `maxPageBytes must be an integer between 1 and ${RETAINED_OUTPUT_MAX_PAGE_BYTES}`,
    );
  }
}

function parseRangeInteger(value: string | undefined): number | null | "overflow" {
  if (!value) return null;
  // Avoid both precision loss and work proportional to an adversarial digit run.
  if (value.length > 16) return "overflow";
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "overflow";
}

function resolvedRange(
  start: number,
  end: number,
  totalBytes: number,
  status: 200 | 206,
): RetainedOutputResolvedRange {
  return {
    kind: "range",
    start,
    end,
    length: end - start + 1,
    totalBytes,
    status,
    contentRange: status === 206 ? `bytes ${start}-${end}/${totalBytes}` : null,
    acceptRanges: "bytes",
  };
}

function invalidRange(
  reason: Extract<RetainedOutputRangeResolution, { kind: "invalid" }>["reason"],
  maxPageBytes: number,
): RetainedOutputRangeResolution {
  return { kind: "invalid", reason, maxPageBytes };
}

function unsatisfiableRange(
  reason: Extract<RetainedOutputRangeResolution, { kind: "unsatisfiable" }>["reason"],
  totalBytes: number,
): RetainedOutputRangeResolution {
  return {
    kind: "unsatisfiable",
    reason,
    totalBytes,
    contentRange: `bytes */${totalBytes}`,
  };
}
