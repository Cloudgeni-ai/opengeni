import { describe, expect, test } from "bun:test";

import {
  NUMERIC_PERFORMANCE_BUDGETS,
  WORKBENCH_ACCEPTANCE_REQUIREMENTS,
} from "./workbench-acceptance-contract";
import {
  validateWorkbenchAcceptanceBundle,
  type AcceptanceResult,
  type WorkbenchAcceptanceBundle,
} from "./verify-workbench-acceptance-bundle";
import {
  buildReleaseCandidateReceipt,
  type ReleaseChartCandidate,
  type ReleaseImageRole,
} from "./release-candidate";
import { buildReleaseProducerMetadata } from "./release-provenance";

const sourceSha = "a".repeat(40);
const sourceTreeSha = "f".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const artifactHash = "c".repeat(64);
const stagingEvidenceUrl = "https://evidence.example/staging.json";
const productionEvidenceUrl = "https://evidence.example/production.json";
const canaryEvidenceUrl = "https://evidence.example/canary.json";
const candidateReceiptUrl =
  "https://github.com/example/opengeni/releases/download/opengeni-candidate-a/release-candidate.json";
const candidateReceiptSha256 = "d".repeat(64);
const chart: ReleaseChartCandidate = {
  version: "0.18.0",
  bytesSha256: "8".repeat(64),
  artifact: "opengeni-0.18.0.tgz",
};
const candidateProducer = buildReleaseProducerMetadata({
  kind: "candidate",
  runId: 123,
  runAttempt: 1,
  sourceSha,
  sourceTreeSha,
});
const acceptanceProducer = buildReleaseProducerMetadata({
  kind: "acceptance",
  runId: 456,
  runAttempt: 1,
  sourceSha,
  sourceTreeSha,
});
const candidateReceipt = buildReleaseCandidateReceipt({
  sourceSha,
  sourceTreeSha,
  packages: [{ name: "@opengeni/sdk", version: "0.18.0" }],
  imageDigests: {
    api: digest,
    worker: digest,
    web: digest,
    relay: digest,
    sandbox: digest,
  } satisfies Record<ReleaseImageRole, string>,
  chart,
  producer: candidateProducer,
});

function evidence(name: string) {
  return [{ url: `https://evidence.example/${name}.json`, sha256: artifactHash, artifact: name }];
}

function validResult(
  requirementId: string,
  environment: AcceptanceResult["environment"],
): AcceptanceResult {
  const budget = NUMERIC_PERFORMANCE_BUDGETS[requirementId];
  return {
    requirementId,
    environment,
    status: "passed",
    observedAt: "2026-07-01T00:00:00.000Z",
    detail: "verified against the exact deployed candidate",
    attempts: 1,
    retries: 0,
    skipped: 0,
    evidence: evidence(`${requirementId}-${environment}`),
    ...(budget
      ? {
          measurement: {
            unit: budget.unit,
            sampleCount: 100,
            p50: budget.direction === "maximum" ? budget.limit * 0.5 : budget.limit * 1.2,
            p75: budget.direction === "maximum" ? budget.limit * 0.6 : budget.limit * 1.15,
            p95: budget.direction === "maximum" ? budget.limit * 0.8 : budget.limit,
            p99: budget.direction === "maximum" ? budget.limit * 0.9 : budget.limit,
            worst: budget.direction === "maximum" ? budget.limit : budget.limit,
          },
        }
      : {}),
  };
}

function validBundle(): WorkbenchAcceptanceBundle {
  const images = () => ({
    api: digest,
    worker: digest,
    web: digest,
    relay: digest,
    migration: digest,
    sandbox: digest,
  });
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-16T00:00:00.000Z",
    producer: acceptanceProducer,
    candidate: {
      sourceSha,
      sourceTreeSha,
      imageDigests: images(),
      chart,
      producer: candidateProducer,
      receipt: {
        url: candidateReceiptUrl,
        sha256: candidateReceiptSha256,
        artifact: "release-candidate.json",
      },
    },
    staging: {
      sourceSha,
      sourceTreeSha,
      imageDigests: images(),
      chart,
      deploymentUrl: "https://staging.example",
      evidenceUrl: stagingEvidenceUrl,
    },
    production: {
      sourceSha,
      sourceTreeSha,
      imageDigests: images(),
      chart,
      deploymentUrl: "https://production.example",
      evidenceUrl: productionEvidenceUrl,
    },
    productionCanary: {
      sourceSha,
      startedAt: "2026-07-01T00:00:00.000Z",
      endedAt: "2026-07-04T00:00:00.000Z",
      expectedCycles: 72,
      passedCycles: 72,
      failedCycles: 0,
      skippedCycles: 0,
      missingCycles: 0,
      lateCycles: 0,
      sloBreaches: 0,
      evidenceUrl: canaryEvidenceUrl,
      evidence: evidence("canary"),
    },
    knownDefects: [],
    results: WORKBENCH_ACCEPTANCE_REQUIREMENTS.flatMap((requirement) =>
      requirement.environments.map((environment) => validResult(requirement.id, environment)),
    ),
  };
}

function validate(bundle: WorkbenchAcceptanceBundle) {
  return validateWorkbenchAcceptanceBundle(bundle, {
    sourceSha,
    candidateReceipt,
    candidateProducer,
    acceptanceProducer,
    candidateReceiptUrl,
    candidateReceiptSha256,
    stagingEvidenceUrl,
    productionEvidenceUrl,
    productionCanaryEvidenceUrl: canaryEvidenceUrl,
  });
}

describe("workbench acceptance bundle", () => {
  test("accepts a complete exact-artifact, zero-gap bundle", () => {
    const bundle = validBundle();
    expect(validate(bundle)).toBe(bundle);
  });

  test("fails closed on a missing row, retry, or known defect", () => {
    const missing = validBundle();
    missing.results.shift();
    expect(() => validate(missing)).toThrow("missing acceptance result");

    const retried = validBundle();
    (retried.results[0] as any).retries = 1;
    expect(() => validate(retried)).toThrow("retries must be 0");

    const defect = validBundle();
    (defect as any).knownDefects = [{ id: "WB-1", status: "open" }];
    expect(() => validate(defect)).toThrow("knownDefects must be an empty array");
  });

  test("rejects artifact drift and an undersized canary window", () => {
    const drift = validBundle();
    drift.production.imageDigests.web = `sha256:${"d".repeat(64)}`;
    expect(() => validate(drift)).toThrow("image digests differ");

    const short = validBundle();
    short.productionCanary.endedAt = "2026-07-03T23:59:59.000Z";
    expect(() => validate(short)).toThrow("at least 72 hours");

    const chartDrift = validBundle();
    chartDrift.production.chart.bytesSha256 = "e".repeat(64);
    expect(() => validate(chartDrift)).toThrow("chart bytesSha256 differs");

    const chartBytesDrift = validBundle();
    chartBytesDrift.staging.chart.bytesSha256 = "f".repeat(64);
    expect(() => validate(chartBytesDrift)).toThrow("chart bytesSha256 differs");
  });

  test("fails closed on candidate-receipt drift, missing/extra roles, or migration drift", () => {
    const changed = validBundle();
    changed.candidate.imageDigests.api = `sha256:${"e".repeat(64)}`;
    changed.candidate.imageDigests.migration = changed.candidate.imageDigests.api;
    expect(() => validate(changed)).toThrow("candidate receipt and acceptance candidate");

    const missing = validBundle() as any;
    delete missing.candidate.imageDigests.sandbox;
    expect(() => validate(missing)).toThrow("must contain exactly");

    const extra = validBundle() as any;
    extra.candidate.imageDigests.desktop = digest;
    expect(() => validate(extra)).toThrow("must contain exactly");

    const migration = validBundle();
    migration.production.imageDigests.migration = `sha256:${"f".repeat(64)}`;
    expect(() => validate(migration)).toThrow("migration must equal");
  });

  test("rejects repeated attempts and insufficient live measurement samples", () => {
    const repeated = validBundle();
    repeated.results[0]!.attempts = 2;
    expect(() => validate(repeated)).toThrow("attempts must be exactly 1");

    const insufficient = validBundle();
    const capture = insufficient.results.find(
      (item) => item.requirementId === "performance.capture-api-response",
    )!;
    capture.measurement!.sampleCount = 99;
    expect(() => validate(insufficient)).toThrow("at least 100 samples");
  });

  test("rejects extra environment rows and impossible measurement distributions", () => {
    const extra = validBundle();
    extra.results.push(validResult("functional.desktop-framebuffer", "production"));
    expect(() => validate(extra)).toThrow(
      "unexpected acceptance result functional.desktop-framebuffer@production",
    );

    const unordered = validBundle();
    const capture = unordered.results.find(
      (item) => item.requirementId === "performance.capture-api-response",
    )!;
    capture.measurement!.p75 = capture.measurement!.p50 - 1;
    expect(() => validate(unordered)).toThrow("are not ordered for a maximum budget");

    const negative = validBundle();
    const captureWithNegative = negative.results.find(
      (item) => item.requirementId === "performance.capture-usable-workbench",
    )!;
    captureWithNegative.measurement!.worst = -1;
    expect(() => validate(negative)).toThrow("must be finite and nonnegative");
  });

  test("rejects evidence URL fragments", () => {
    const fragment = validBundle();
    fragment.results[0]!.evidence[0]!.url += "#mutable-view";
    expect(() => validate(fragment)).toThrow("query parameters, or fragments");
  });

  test("enforces numeric budgets and rejects secret-bearing evidence", () => {
    const slow = validBundle();
    const capture = slow.results.find(
      (item) => item.requirementId === "performance.capture-api-response",
    )!;
    capture.measurement!.p95 = 201;
    expect(() => validate(slow)).toThrow("exceeds 200 ms");

    const secret = validBundle() as any;
    secret.cookie = "session=not-allowed";
    expect(() => validate(secret)).toThrow("forbidden secret field");
  });
});
