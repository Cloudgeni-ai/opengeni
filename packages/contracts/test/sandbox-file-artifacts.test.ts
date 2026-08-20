import { describe, expect, test } from "bun:test";

import {
  SANDBOX_FILE_ARTIFACT_MAX_BYTES,
  SandboxFileArtifactReceipt,
} from "../src/sandbox-file-artifacts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const artifactId = "33333333-3333-4333-8333-333333333333";

function receipt() {
  return {
    type: "sandbox_file" as const,
    sandboxPath: "/workspace/reports/summary.pdf",
    filename: "summary.pdf",
    artifact: {
      available: true as const,
      artifactId,
      kind: "file" as const,
      contentType: "application/pdf",
      originalBytes: 1_024,
      sha256: "a".repeat(64),
      retainedAt: "2026-08-17T00:00:00.000Z",
      retention: { policy: "workspace_file" as const, expiresAt: null },
      retrieval: {
        method: "GET" as const,
        path: `/v1/workspaces/${workspaceId}/artifacts/${artifactId}/content`,
        acceptRanges: "bytes" as const,
        maxRangeBytes: 1024 * 1024,
      },
    },
  };
}

describe("sandbox-file artifact receipt", () => {
  test("accepts one closed permanent workspace-file receipt", () => {
    expect(SandboxFileArtifactReceipt.parse(receipt())).toEqual(receipt());
  });

  test("rejects non-canonical paths, filename mismatches, and other artifact kinds", () => {
    expect(() =>
      SandboxFileArtifactReceipt.parse({
        ...receipt(),
        sandboxPath: "/workspace/reports/../summary.pdf",
      }),
    ).toThrow();
    expect(() =>
      SandboxFileArtifactReceipt.parse({ ...receipt(), filename: "different.pdf" }),
    ).toThrow();
    expect(() =>
      SandboxFileArtifactReceipt.parse({
        ...receipt(),
        artifact: { ...receipt().artifact, kind: "tool_result" },
      }),
    ).toThrow();
  });

  test("rejects files above the binary-safe publication ceiling", () => {
    expect(() =>
      SandboxFileArtifactReceipt.parse({
        ...receipt(),
        artifact: {
          ...receipt().artifact,
          originalBytes: SANDBOX_FILE_ARTIFACT_MAX_BYTES + 1,
        },
      }),
    ).toThrow();
  });
});
