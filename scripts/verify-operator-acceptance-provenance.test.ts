import { describe, expect, test } from "bun:test";

import {
  verifyOperatorAcceptanceProvenance,
  type OperatorAcceptanceApi,
} from "./verify-operator-acceptance-provenance";

const repository = "example/release-operator";
const workflowPath = ".github/workflows/publish-release-acceptance.yml";
const sourceSha = "a".repeat(40);
const headSha = "b".repeat(40);
const runId = 123;
const artifactId = 456;
const now = Date.parse("2026-07-24T00:00:00Z");

function api(overrides?: {
  run?: Record<string, unknown>;
  comparison?: Record<string, unknown>;
  artifacts?: unknown[];
}): OperatorAcceptanceApi {
  return {
    async get(path) {
      if (path.endsWith(`/actions/runs/${runId}`)) {
        return {
          id: runId,
          run_attempt: 2,
          path: workflowPath,
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
          head_sha: headSha,
          repository: { full_name: repository },
          head_repository: { full_name: repository },
          html_url: `https://github.com/${repository}/actions/runs/${runId}`,
          ...overrides?.run,
        };
      }
      if (path.endsWith(`/compare/${headSha}...main`)) {
        return {
          status: "ahead",
          merge_base_commit: { sha: headSha },
          ...overrides?.comparison,
        };
      }
      if (path.endsWith(`/actions/runs/${runId}/artifacts`)) {
        return {
          artifacts: overrides?.artifacts ?? [
            {
              id: artifactId,
              name: `release-acceptance-input-${sourceSha}`,
              digest: `sha256:${"c".repeat(64)}`,
              expired: false,
              expires_at: "2026-08-24T00:00:00Z",
              workflow_run: { id: runId },
            },
          ],
        };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

describe("operator acceptance provenance", () => {
  test("accepts one exact artifact from the configured main workflow", async () => {
    await expect(
      verifyOperatorAcceptanceProvenance({
        repository,
        workflowPath,
        sourceSha,
        runId,
        api: api(),
        now,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      repository,
      workflowPath,
      runId,
      runAttempt: 2,
      headSha,
      runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
      artifact: {
        id: artifactId,
        name: `release-acceptance-input-${sourceSha}`,
        digest: `sha256:${"c".repeat(64)}`,
        expiresAt: "2026-08-24T00:00:00Z",
        url: `https://github.com/${repository}/actions/runs/${runId}/artifacts/${artifactId}`,
        archiveDownloadUrl: `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`,
      },
    });
  });

  test("rejects branch, workflow, ancestry, artifact ownership, and expiry drift", async () => {
    const input = { repository, workflowPath, sourceSha, runId, now };
    await expect(
      verifyOperatorAcceptanceProvenance({
        ...input,
        api: api({ run: { head_branch: "feature" } }),
      }),
    ).rejects.toThrow("from main");
    await expect(
      verifyOperatorAcceptanceProvenance({
        ...input,
        api: api({ run: { path: ".github/workflows/other.yml" } }),
      }),
    ).rejects.toThrow("configured path");
    await expect(
      verifyOperatorAcceptanceProvenance({
        ...input,
        api: api({ comparison: { status: "diverged" } }),
      }),
    ).rejects.toThrow("ancestor");
    await expect(
      verifyOperatorAcceptanceProvenance({
        ...input,
        api: api({
          artifacts: [
            {
              id: artifactId,
              name: `release-acceptance-input-${sourceSha}`,
              digest: `sha256:${"c".repeat(64)}`,
              expired: false,
              expires_at: "2026-08-24T00:00:00Z",
              workflow_run: { id: 999 },
            },
          ],
        }),
      }),
    ).rejects.toThrow("not owned");
    await expect(
      verifyOperatorAcceptanceProvenance({
        ...input,
        api: api({
          artifacts: [
            {
              id: artifactId,
              name: `release-acceptance-input-${sourceSha}`,
              digest: `sha256:${"c".repeat(64)}`,
              expired: false,
              expires_at: "2026-07-23T00:00:00Z",
              workflow_run: { id: runId },
            },
          ],
        }),
      }),
    ).rejects.toThrow("expired");
  });

  test("rejects untrusted configured identifiers before any API call", async () => {
    const never: OperatorAcceptanceApi = {
      async get() {
        throw new Error("must not call");
      },
    };
    await expect(
      verifyOperatorAcceptanceProvenance({
        repository: "../private/repo",
        workflowPath,
        sourceSha,
        runId,
        api: never,
      }),
    ).rejects.toThrow("owner/name");
    await expect(
      verifyOperatorAcceptanceProvenance({
        repository,
        workflowPath: ".github/workflows/../other.yml",
        sourceSha,
        runId,
        api: never,
      }),
    ).rejects.toThrow("canonical workflow");
  });
});
