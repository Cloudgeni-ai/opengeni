import { describe, expect, test } from "bun:test";
import {
  RETAINED_OUTPUT_DEFAULT_PAGE_BYTES,
  RETAINED_OUTPUT_MAX_PAGE_BYTES,
  RetainedArtifactMetadataSchema,
  RetainedArtifactReferenceSchema,
  RetainedOutputEvidenceSchema,
  retainedArtifactReferenceFromFile,
  resolveRetainedOutputRange,
  validateRetainedOutputEvidence,
} from "../src/retained-output";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";

function receipt() {
  return {
    available: true as const,
    artifactId: ARTIFACT_ID,
    kind: "tool_result" as const,
    contentType: "application/json",
    originalBytes: 3 * 1024 * 1024,
    sha256: "a".repeat(64),
    retainedAt: "2026-07-21T00:00:00.000Z",
    retention: {
      policy: "workspace_file" as const,
      expiresAt: null,
    },
    retrieval: {
      method: "GET" as const,
      path: `/v1/workspaces/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}/content`,
      acceptRanges: "bytes" as const,
      maxRangeBytes: RETAINED_OUTPUT_MAX_PAGE_BYTES,
    },
  };
}

describe("retained-output evidence", () => {
  test("accepts one closed provider-neutral available receipt", () => {
    expect(RetainedOutputEvidenceSchema.parse(receipt())).toEqual(receipt());
    expect(RetainedOutputEvidenceSchema.parse({ available: false, reason: "expired" })).toEqual({
      available: false,
      reason: "expired",
    });
  });

  test("rejects malformed identity, hash, MIME, expiry, and retrieval paths", () => {
    const invalid = [
      { ...receipt(), artifactId: "not-a-uuid" },
      { ...receipt(), sha256: "A".repeat(64) },
      { ...receipt(), contentType: "text/plain\r\nx-provider-secret: yes" },
      { ...receipt(), retrieval: { ...receipt().retrieval, path: "https://storage.test/key" } },
      {
        ...receipt(),
        retrieval: {
          ...receipt().retrieval,
          path: `/v1/workspaces/${WORKSPACE_ID}/artifacts/44444444-4444-4444-8444-444444444444/content`,
        },
      },
    ];
    for (const value of invalid) {
      expect(validateRetainedOutputEvidence(value)).toBeNull();
    }
  });

  test("rejects provider locations and arbitrary producer metadata", () => {
    expect(
      validateRetainedOutputEvidence({
        ...receipt(),
        bucket: "secret-bucket",
        objectKey: "workspaces/private/object",
      }),
    ).toBeNull();
    expect(
      validateRetainedOutputEvidence({
        ...receipt(),
        retrieval: { ...receipt().retrieval, signedUrl: "https://storage.test/credential" },
      }),
    ).toBeNull();
    expect(
      validateRetainedOutputEvidence({ ...receipt(), labels: { tool: "attacker" } }),
    ).toBeNull();
  });

  test("mints a receipt only for a ready integrity-addressed workspace file", () => {
    const file = {
      id: ARTIFACT_ID,
      workspaceId: WORKSPACE_ID,
      status: "ready",
      contentType: "Text/Plain; charset=utf-8",
      sizeBytes: 3 * 1024 * 1024,
      sha256: "a".repeat(64),
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    const reference = retainedArtifactReferenceFromFile(file, "tool_result");
    if (!reference) throw new Error("expected a ready file to mint a retained artifact reference");
    expect(reference).toMatchObject({
      available: true,
      artifactId: ARTIFACT_ID,
      kind: "tool_result",
      contentType: "text/plain",
      retention: { policy: "workspace_file", expiresAt: null },
    });
    expect(RetainedArtifactReferenceSchema.parse(reference)).toEqual(reference);
    expect(retainedArtifactReferenceFromFile({ ...file, status: "pending_upload" })).toBeNull();
    expect(retainedArtifactReferenceFromFile({ ...file, sha256: null })).toBeNull();
    expect(retainedArtifactReferenceFromFile({ ...file, sha256: "A".repeat(64) })).toBeNull();
  });

  test("represents authenticated unavailable artifact metadata without a provider location", () => {
    expect(
      RetainedArtifactMetadataSchema.parse({
        available: false,
        artifactId: ARTIFACT_ID,
        reason: "missing_storage",
      }),
    ).toEqual({
      available: false,
      artifactId: ARTIFACT_ID,
      reason: "missing_storage",
    });
  });
});

describe("retained-output single byte ranges", () => {
  test("returns a full small object and a bounded first page for a large object", () => {
    expect(resolveRetainedOutputRange(null, 100)).toMatchObject({
      kind: "range",
      start: 0,
      end: 99,
      length: 100,
      status: 200,
      contentRange: null,
    });
    expect(resolveRetainedOutputRange(null, RETAINED_OUTPUT_DEFAULT_PAGE_BYTES + 1)).toMatchObject({
      kind: "range",
      start: 0,
      end: RETAINED_OUTPUT_DEFAULT_PAGE_BYTES - 1,
      length: RETAINED_OUTPUT_DEFAULT_PAGE_BYTES,
      status: 206,
      contentRange: `bytes 0-${RETAINED_OUTPUT_DEFAULT_PAGE_BYTES - 1}/${RETAINED_OUTPUT_DEFAULT_PAGE_BYTES + 1}`,
    });
  });

  test("resolves prefix, clipped, open-ended, and suffix ranges exactly", () => {
    expect(resolveRetainedOutputRange("bytes=10-19", 100, 20)).toMatchObject({
      kind: "range",
      start: 10,
      end: 19,
      length: 10,
      contentRange: "bytes 10-19/100",
    });
    expect(resolveRetainedOutputRange("bytes=95-110", 100, 20)).toMatchObject({
      kind: "range",
      start: 95,
      end: 99,
      length: 5,
      contentRange: "bytes 95-99/100",
    });
    expect(resolveRetainedOutputRange("bytes=25-", 100, 20)).toMatchObject({
      kind: "range",
      start: 25,
      end: 44,
      length: 20,
      contentRange: "bytes 25-44/100",
    });
    expect(resolveRetainedOutputRange("bytes=-12", 100, 20)).toMatchObject({
      kind: "range",
      start: 88,
      end: 99,
      length: 12,
      contentRange: "bytes 88-99/100",
    });
  });

  test("distinguishes unsatisfiable, malformed, oversized, overflow, and multipart input", () => {
    expect(resolveRetainedOutputRange("bytes=100-", 100)).toEqual({
      kind: "unsatisfiable",
      reason: "start_out_of_bounds",
      totalBytes: 100,
      contentRange: "bytes */100",
    });
    expect(resolveRetainedOutputRange("bytes=20-10", 100)).toMatchObject({
      kind: "unsatisfiable",
      reason: "end_before_start",
    });
    expect(resolveRetainedOutputRange("bytes=-0", 100)).toMatchObject({
      kind: "unsatisfiable",
      reason: "zero_suffix",
    });
    expect(resolveRetainedOutputRange("bytes=0-1,4-5", 100)).toMatchObject({
      kind: "invalid",
      reason: "multipart_not_supported",
    });
    expect(resolveRetainedOutputRange("items=0-1", 100)).toMatchObject({
      kind: "invalid",
      reason: "malformed",
    });
    expect(resolveRetainedOutputRange("bytes=0-20", 100, 20)).toMatchObject({
      kind: "invalid",
      reason: "range_too_large",
    });
    expect(resolveRetainedOutputRange("bytes=99999999999999999-", 100)).toMatchObject({
      kind: "invalid",
      reason: "numeric_overflow",
    });
  });

  test("handles zero-length artifacts without manufacturing byte zero", () => {
    expect(resolveRetainedOutputRange(null, 0)).toEqual({
      kind: "empty",
      length: 0,
      totalBytes: 0,
      status: 200,
      contentRange: null,
      acceptRanges: "bytes",
    });
    expect(resolveRetainedOutputRange("bytes=0-", 0)).toEqual({
      kind: "unsatisfiable",
      reason: "empty_artifact",
      totalBytes: 0,
      contentRange: "bytes */0",
    });
  });

  test("rejects unsafe artifact sizes and page caps", () => {
    expect(() => resolveRetainedOutputRange(null, Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() =>
      resolveRetainedOutputRange(null, 10, RETAINED_OUTPUT_MAX_PAGE_BYTES + 1),
    ).toThrow();
  });
});
