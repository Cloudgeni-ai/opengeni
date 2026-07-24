import { describe, expect, test } from "bun:test";

import {
  buildReleaseCandidateReceipt,
  deploymentImageDigests,
  RELEASE_IMAGE_NAMES,
  RELEASE_IMAGE_ROLES,
  releaseBomImages,
  validateReleaseCandidateReceipt,
  type ReleaseCandidateReceipt,
  type ReleaseImageRole,
} from "./release-candidate";
import { buildReleaseProducerMetadata } from "./release-provenance";

const sourceSha = "a".repeat(40);
const sourceTreeSha = "f".repeat(40);
const packages = [
  { name: "@opengeni/react", version: "0.18.0" },
  { name: "@opengeni/sdk", version: "0.18.0" },
];
const imageDigests = Object.fromEntries(
  RELEASE_IMAGE_ROLES.map((role, index) => [role, `sha256:${String(index + 1).repeat(64)}`]),
) as Record<ReleaseImageRole, string>;
const chart = {
  version: "0.18.0",
  bytesSha256: "8".repeat(64),
  artifact: "opengeni-0.18.0.tgz",
};
const producer = buildReleaseProducerMetadata({
  kind: "candidate",
  runId: 123,
  runAttempt: 1,
  sourceSha,
  sourceTreeSha,
});

describe("release candidate receipt", () => {
  test("uses the product chart version independently of the npm package plan", () => {
    const receipt = buildReleaseCandidateReceipt({
      sourceSha,
      sourceTreeSha,
      packages: [],
      imageDigests,
      chart,
      producer,
    });
    expect(receipt.releaseVersion).toBe(chart.version);
    expect(receipt.packages).toEqual([]);
    expect(validateReleaseCandidateReceipt(receipt, { packages: [] })).toEqual(receipt);
  });

  test("normalizes the exact package and physical image inventory", () => {
    const receipt = buildReleaseCandidateReceipt({
      sourceSha,
      sourceTreeSha,
      packages: [...packages].reverse(),
      imageDigests,
      chart,
      producer,
    });

    expect(receipt).toEqual({
      schemaVersion: 2,
      sourceSha,
      sourceTreeSha,
      releaseVersion: "0.18.0",
      packages,
      images: Object.fromEntries(
        RELEASE_IMAGE_ROLES.map((role) => [
          role,
          { name: RELEASE_IMAGE_NAMES[role], digest: imageDigests[role] },
        ]),
      ) as ReleaseCandidateReceipt["images"],
      chart,
      producer,
      aliases: { migration: "api" },
    });
    expect(deploymentImageDigests(receipt)).toEqual({
      api: imageDigests.api,
      migration: imageDigests.api,
      worker: imageDigests.worker,
      web: imageDigests.web,
      relay: imageDigests.relay,
      sandbox: imageDigests.sandbox,
    });
    expect(releaseBomImages(receipt)).toEqual(
      RELEASE_IMAGE_ROLES.map((role) => ({
        name: RELEASE_IMAGE_NAMES[role],
        digest: imageDigests[role],
      })),
    );
  });

  test("rejects missing, extra, mutable, or provider-drifted image identities", () => {
    const valid = buildReleaseCandidateReceipt({
      sourceSha,
      sourceTreeSha,
      packages,
      imageDigests,
      chart,
      producer,
    });

    const missing = structuredClone(valid) as any;
    delete missing.images.relay;
    expect(() => validateReleaseCandidateReceipt(missing)).toThrow("exactly");

    const extra = structuredClone(valid) as any;
    extra.images.desktop = {
      name: "ghcr.io/example/desktop",
      digest: imageDigests.api,
    };
    expect(() => validateReleaseCandidateReceipt(extra)).toThrow("exactly");

    const mutable = structuredClone(valid) as any;
    mutable.images.api.digest = "latest";
    expect(() => validateReleaseCandidateReceipt(mutable)).toThrow("exact sha256 digest");

    const drifted = structuredClone(valid) as any;
    drifted.images.worker.name = "ghcr.io/example/worker";
    expect(() => validateReleaseCandidateReceipt(drifted)).toThrow(RELEASE_IMAGE_NAMES.worker);

    const prematurelyPublishedChart = structuredClone(valid) as any;
    prematurelyPublishedChart.chart.reference = "oci://ghcr.io/cloudgeni-ai/charts/opengeni";
    prematurelyPublishedChart.chart.manifestDigest = `sha256:${"9".repeat(64)}`;
    expect(() => validateReleaseCandidateReceipt(prematurelyPublishedChart)).toThrow("exactly");
  });

  test("binds source, package plan, release version, and migration alias", () => {
    const valid = buildReleaseCandidateReceipt({
      sourceSha,
      sourceTreeSha,
      packages,
      imageDigests,
      chart,
      producer,
    });
    expect(
      validateReleaseCandidateReceipt(valid, {
        sourceSha,
        sourceTreeSha,
        packages,
        producer,
      }),
    ).toEqual(valid);

    expect(() =>
      validateReleaseCandidateReceipt(valid, {
        sourceSha: "b".repeat(40),
        sourceTreeSha,
        packages,
        producer,
      }),
    ).toThrow("does not match");
    expect(() =>
      validateReleaseCandidateReceipt(valid, {
        sourceSha,
        packages: [{ name: "@opengeni/sdk", version: "0.19.0" }],
      }),
    ).toThrow("package plan");

    const wrongVersion = structuredClone(valid) as any;
    wrongVersion.releaseVersion = "0.19.0";
    expect(() => validateReleaseCandidateReceipt(wrongVersion)).toThrow("chart version");

    const wrongAlias = structuredClone(valid) as any;
    wrongAlias.aliases.migration = "worker";
    expect(() => validateReleaseCandidateReceipt(wrongAlias)).toThrow("alias the API");

    const chartDrift = structuredClone(valid) as any;
    chartDrift.chart.version = "0.19.0";
    chartDrift.chart.artifact = "opengeni-0.19.0.tgz";
    expect(() => validateReleaseCandidateReceipt(chartDrift)).toThrow("chart version");
  });
});
