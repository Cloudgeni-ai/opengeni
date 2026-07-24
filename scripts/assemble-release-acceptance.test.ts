import { describe, expect, test } from "bun:test";

import { assembleReleaseAcceptance } from "./assemble-release-acceptance";
import {
  buildReleaseCandidateReceipt,
  RELEASE_IMAGE_ROLES,
  type ReleaseImageRole,
} from "./release-candidate";
import { buildReleaseProducerMetadata, buildTrustedReleaseArtifact } from "./release-provenance";
import type {
  AcceptanceBundleExpectations,
  WorkbenchAcceptanceBundle,
} from "./verify-workbench-acceptance-bundle";

const sourceSha = "a".repeat(40);
const sourceTreeSha = "b".repeat(40);
const candidateProducer = buildReleaseProducerMetadata({
  kind: "candidate",
  runId: 123,
  runAttempt: 2,
  sourceSha,
  sourceTreeSha,
});
const candidateReceipt = buildReleaseCandidateReceipt({
  sourceSha,
  sourceTreeSha,
  packages: [{ name: "@opengeni/sdk", version: "1.2.3" }],
  imageDigests: Object.fromEntries(
    RELEASE_IMAGE_ROLES.map((role, index) => [role, `sha256:${String(index + 1).repeat(64)}`]),
  ) as Record<ReleaseImageRole, string>,
  chart: {
    version: "1.2.3",
    bytesSha256: "8".repeat(64),
    artifact: "opengeni-1.2.3.tgz",
  },
  producer: candidateProducer,
});
const candidateArtifact = buildTrustedReleaseArtifact({
  kind: "candidate",
  sourceSha,
  runId: candidateProducer.runId,
  now: Date.parse("2026-07-24T00:00:00Z"),
  artifact: {
    id: 456,
    name: `release-candidate-${sourceSha}`,
    digest: `sha256:${"9".repeat(64)}`,
    expires_at: "2099-01-01T00:00:00Z",
  },
});

describe("assemble release acceptance", () => {
  test("replaces operator-supplied authority with verified public provenance", () => {
    let observed: { bundle: unknown; expected: AcceptanceBundleExpectations } | undefined;
    const operatorBundle = {
      schemaVersion: 2,
      generatedAt: "2026-07-24T00:00:00Z",
      producer: { untrusted: true },
      candidate: { untrusted: true },
      staging: { retained: true },
    };
    const bundle = assembleReleaseAcceptance({
      operatorBundle,
      sourceSha,
      candidateReceipt,
      candidateReceiptSha256: "c".repeat(64),
      candidateProvenance: { producer: candidateProducer, artifact: candidateArtifact },
      acceptanceRunId: 789,
      acceptanceRunAttempt: 3,
      validate(value, expected) {
        observed = { bundle: value, expected };
        return value as WorkbenchAcceptanceBundle;
      },
    });

    expect(bundle.staging).toEqual({ retained: true } as any);
    expect(bundle.producer).toEqual(
      buildReleaseProducerMetadata({
        kind: "acceptance",
        runId: 789,
        runAttempt: 3,
        sourceSha,
        sourceTreeSha,
      }),
    );
    expect(bundle.candidate).toEqual({
      sourceSha,
      sourceTreeSha,
      imageDigests: {
        api: candidateReceipt.images.api.digest,
        migration: candidateReceipt.images.api.digest,
        worker: candidateReceipt.images.worker.digest,
        web: candidateReceipt.images.web.digest,
        relay: candidateReceipt.images.relay.digest,
        sandbox: candidateReceipt.images.sandbox.digest,
      },
      chart: candidateReceipt.chart,
      producer: candidateProducer,
      receipt: {
        url: candidateArtifact.url,
        sha256: "c".repeat(64),
        artifact: "release-candidate.json",
      },
    });
    expect(observed?.expected.acceptanceProducer).toEqual(bundle.producer);
    expect(operatorBundle).toEqual({
      schemaVersion: 2,
      generatedAt: "2026-07-24T00:00:00Z",
      producer: { untrusted: true },
      candidate: { untrusted: true },
      staging: { retained: true },
    });
  });

  test("rejects candidate provenance or receipt drift before assembly", () => {
    const input = {
      operatorBundle: {},
      sourceSha,
      candidateReceipt,
      candidateReceiptSha256: "c".repeat(64),
      candidateProvenance: { producer: candidateProducer, artifact: candidateArtifact },
      acceptanceRunId: 789,
      acceptanceRunAttempt: 3,
      validate: (() => {
        throw new Error("must not validate");
      }) as any,
    };
    expect(() =>
      assembleReleaseAcceptance({
        ...input,
        candidateProvenance: {
          producer: { ...candidateProducer, sourceSha: "d".repeat(40) },
          artifact: candidateArtifact,
        },
      }),
    ).toThrow("source SHA");
    expect(() =>
      assembleReleaseAcceptance({
        ...input,
        candidateReceipt: { ...candidateReceipt, sourceTreeSha: "e".repeat(40) },
      }),
    ).toThrow("source tree");
  });
});
