import { describe, expect, test } from "bun:test";
import type { SandboxFileArtifactReceipt } from "@opengeni/sdk";

import { downloadSandboxFileArtifact } from "./sandbox-artifact-download";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";

const receipt: SandboxFileArtifactReceipt = {
  type: "sandbox_file",
  sandboxPath: "/workspace/reports/summary.pdf",
  filename: "summary.pdf",
  artifact: {
    available: true,
    artifactId,
    kind: "file",
    contentType: "application/pdf",
    originalBytes: 4,
    sha256: "a".repeat(64),
    retainedAt: "2026-08-17T00:00:00.000Z",
    retention: { policy: "workspace_file", expiresAt: null },
    retrieval: {
      method: "GET",
      path: `/v1/workspaces/${workspaceId}/artifacts/${artifactId}/content`,
      acceptRanges: "bytes",
      maxRangeBytes: 1024 * 1024,
    },
  },
};

describe("sandbox artifact download", () => {
  test("publishes, validates, downloads, and saves one exact file", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const saved: Array<{ receipt: SandboxFileArtifactReceipt; bytes: Uint8Array }> = [];
    const result = await downloadSandboxFileArtifact(
      {
        publishSandboxFileArtifact: async (receivedWorkspaceId, receivedSessionId, request) => {
          expect(receivedWorkspaceId).toBe(workspaceId);
          expect(receivedSessionId).toBe(sessionId);
          expect(request).toEqual({ path: "reports/summary.pdf" });
          return receipt;
        },
        downloadRetainedArtifact: async (receivedWorkspaceId, artifact) => {
          expect(receivedWorkspaceId).toBe(workspaceId);
          expect(artifact).toEqual(receipt.artifact);
          return { artifact, bytes };
        },
      },
      workspaceId,
      sessionId,
      "reports/summary.pdf",
      (published, downloaded) => saved.push({ receipt: published, bytes: downloaded }),
    );

    expect(result).toEqual(receipt);
    expect(saved).toEqual([{ receipt, bytes }]);
  });

  test("fails closed before downloading an invalid or cross-workspace receipt", async () => {
    let downloads = 0;
    await expect(
      downloadSandboxFileArtifact(
        {
          publishSandboxFileArtifact: async () => ({
            ...receipt,
            artifact: {
              ...receipt.artifact,
              retrieval: {
                ...receipt.artifact.retrieval,
                path: `/v1/workspaces/44444444-4444-4444-8444-444444444444/artifacts/${artifactId}/content`,
              },
            },
          }),
          downloadRetainedArtifact: async () => {
            downloads += 1;
            return { artifact: receipt.artifact, bytes: new Uint8Array() };
          },
        },
        workspaceId,
        sessionId,
        "reports/summary.pdf",
        () => undefined,
      ),
    ).rejects.toThrow("invalid receipt");
    expect(downloads).toBe(0);
  });
});
