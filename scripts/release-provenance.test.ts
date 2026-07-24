import { describe, expect, test } from "bun:test";

import { verifyReleaseProvenance } from "./verify-release-provenance";
import {
  buildReleaseProducerMetadata,
  buildTrustedReleaseArtifact,
  RELEASE_REPOSITORY,
  validateReleaseProducerMetadata,
  validateTrustedReleaseArtifact,
} from "./release-provenance";

const sourceSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const run = {
  id: 123,
  run_attempt: 2,
  path: ".github/workflows/release-candidate.yml",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  head_sha: sourceSha,
  repository: { full_name: RELEASE_REPOSITORY },
  head_repository: { full_name: RELEASE_REPOSITORY },
  html_url: `https://github.com/${RELEASE_REPOSITORY}/actions/runs/123`,
};
const artifact = {
  id: 789,
  name: `release-candidate-${sourceSha}`,
  digest: `sha256:${"c".repeat(64)}`,
  expired: false,
  expires_at: "2099-01-01T00:00:00Z",
  workflow_run: { id: 123 },
};

function api(
  overrides: { run?: Record<string, unknown>; artifact?: Record<string, unknown> } = {},
) {
  return {
    async get(path: string): Promise<unknown> {
      if (path.endsWith("/actions/runs/123")) return { ...run, ...overrides.run };
      if (path.includes("/commits/")) {
        return { sha: path.split("/").at(-1), commit: { tree: { sha: treeSha } } };
      }
      if (path.endsWith("/actions/runs/123/artifacts")) {
        return { artifacts: [{ ...artifact, ...overrides.artifact }] };
      }
      throw new Error(`unexpected fixture path ${path}`);
    },
  };
}

describe("release producer provenance", () => {
  test("accepts only a completed canonical run and its owned immutable artifact", async () => {
    const result = await verifyReleaseProvenance({
      kind: "candidate",
      sourceSha,
      runId: 123,
      api: api(),
      now: Date.parse("2026-01-01T00:00:00Z"),
    });
    expect(result.producer).toEqual(
      buildReleaseProducerMetadata({
        kind: "candidate",
        runId: 123,
        runAttempt: 2,
        sourceSha,
        sourceTreeSha: treeSha,
      }),
    );
    expect(result.artifact).toEqual(
      buildTrustedReleaseArtifact({
        kind: "candidate",
        sourceSha,
        runId: 123,
        artifact,
        now: Date.parse("2026-01-01T00:00:00Z"),
      }),
    );
  });

  test("rejects arbitrary URL/hash substitution and wrong repository/run/source/workflow", async () => {
    await expect(
      verifyReleaseProvenance({
        kind: "candidate",
        sourceSha,
        runId: 123,
        api: api({ run: { repository: { full_name: "attacker/example" } } }),
      }),
    ).rejects.toThrow("repository");
    await expect(
      verifyReleaseProvenance({
        kind: "candidate",
        sourceSha,
        runId: 123,
        api: api({ run: { head_sha: "d".repeat(40) } }),
      }),
    ).rejects.toThrow("does not match");
    await expect(
      verifyReleaseProvenance({
        kind: "candidate",
        sourceSha,
        runId: 123,
        api: api({ run: { path: ".github/workflows/release.yml" } }),
      }),
    ).rejects.toThrow("canonical");
    await expect(
      verifyReleaseProvenance({
        kind: "candidate",
        sourceSha,
        runId: 123,
        api: api({ run: { id: 999 } }),
      }),
    ).rejects.toThrow("response ID");
    await expect(
      verifyReleaseProvenance({
        kind: "candidate",
        sourceSha,
        runId: 123,
        api: api({ run: { head_repository: undefined } }),
      }),
    ).rejects.toThrow("head repository");
  });

  test("rejects a canonical-looking producer URL for a different run", () => {
    expect(() =>
      buildReleaseProducerMetadata({
        kind: "candidate",
        runId: 123,
        runAttempt: 2,
        sourceSha,
        sourceTreeSha: treeSha,
        runUrl: `https://github.com/${RELEASE_REPOSITORY}/actions/runs/999`,
      }),
    ).toThrow("run id");
  });

  test("rejects extra fields in serialized producer metadata", () => {
    const producer = buildReleaseProducerMetadata({
      kind: "candidate",
      runId: 123,
      runAttempt: 2,
      sourceSha,
      sourceTreeSha: treeSha,
    });
    expect(() =>
      validateReleaseProducerMetadata(
        { ...producer, unexpected: "mutated" },
        { kind: "candidate", sourceSha, sourceTreeSha: treeSha },
      ),
    ).toThrow("must contain exactly");
  });

  test("rejects serialized trusted artifact URL substitution", () => {
    const producer = buildReleaseProducerMetadata({
      kind: "candidate",
      runId: 123,
      runAttempt: 2,
      sourceSha,
      sourceTreeSha: treeSha,
    });
    const trusted = buildTrustedReleaseArtifact({
      kind: "candidate",
      sourceSha,
      runId: producer.runId,
      artifact,
      now: Date.parse("2026-01-01T00:00:00Z"),
    });

    expect(() =>
      validateTrustedReleaseArtifact(
        { ...trusted, url: trusted.url.replace("/123/", "/999/") },
        {
          kind: "candidate",
          sourceSha,
          runId: producer.runId,
          now: Date.parse("2026-01-01T00:00:00Z"),
        },
      ),
    ).toThrow("URL is not canonical");
    expect(() =>
      validateTrustedReleaseArtifact(
        { ...trusted, digest: `sha256:${"d".repeat(64)}` },
        {
          kind: "candidate",
          sourceSha,
          runId: producer.runId,
          now: Date.parse("2026-01-01T00:00:00Z"),
        },
      ),
    ).not.toThrow();
  });

  test("accepts the provider-selected digest but rejects expired, duplicate, or foreign artifacts", async () => {
    await expect(
      verifyReleaseProvenance({
        kind: "candidate",
        sourceSha,
        runId: 123,
        api: api({ artifact: { digest: "sha256:" + "d".repeat(64) } }),
      }),
    ).resolves.toBeTruthy();
    await expect(
      verifyReleaseProvenance({
        kind: "candidate",
        sourceSha,
        runId: 123,
        api: api({ artifact: { expires_at: "2020-01-01T00:00:00Z" } }),
      }),
    ).rejects.toThrow("expired");
    await expect(
      verifyReleaseProvenance({
        kind: "candidate",
        sourceSha,
        runId: 123,
        api: api({ artifact: { workflow_run: { id: 999 } } }),
      }),
    ).rejects.toThrow("owned");
    await expect(
      verifyReleaseProvenance({
        kind: "candidate",
        sourceSha,
        runId: 123,
        api: api({ artifact: { expired: undefined } }),
      }),
    ).rejects.toThrow("exactly one");
  });
});
