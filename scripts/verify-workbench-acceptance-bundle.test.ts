import { describe, expect, test } from "bun:test";

import {
  NUMERIC_PERFORMANCE_BUDGETS,
  REAL_DEVICE_REQUIREMENTS,
  TIMING_SENSITIVE_REQUIREMENTS,
  WORKBENCH_ACCEPTANCE_REQUIREMENTS,
} from "./workbench-acceptance-contract";
import {
  validateWorkbenchAcceptanceBundle,
  type AcceptanceResult,
  type WorkbenchAcceptanceBundle,
} from "./verify-workbench-acceptance-bundle";
import { buildReleaseCandidateReceipt, type ReleaseImageRole } from "./release-candidate";

const sourceSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const artifactHash = "c".repeat(64);
const stagingEvidenceUrl = "https://evidence.example/staging.json";
const productionEvidenceUrl = "https://evidence.example/production.json";
const canaryEvidenceUrl = "https://evidence.example/canary.json";
const candidateReceiptUrl =
  "https://github.com/example/opengeni/releases/download/opengeni-candidate-a/release-candidate.json";
const candidateReceiptSha256 = "d".repeat(64);
const candidateReceipt = buildReleaseCandidateReceipt({
  sourceSha,
  packages: [{ name: "@opengeni/sdk", version: "0.18.0" }],
  imageDigests: {
    api: digest,
    worker: digest,
    web: digest,
    relay: digest,
    sandbox: digest,
  } satisfies Record<ReleaseImageRole, string>,
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
    ...(TIMING_SENSITIVE_REQUIREMENTS.has(requirementId)
      ? { repetitions: 100, seed: "acceptance-seed-1" }
      : {}),
    ...(REAL_DEVICE_REQUIREMENTS.has(requirementId)
      ? {
          device: {
            real: true,
            name: "owned acceptance device",
            os: "test-os",
            osVersion: "1",
            browser: "test-browser",
            browserVersion: "1",
            viewport: "390x844@3",
            input: "touch and keyboard",
          },
        }
      : {}),
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
  const visualPasses = (kind: string) =>
    Array.from({ length: 10 }, (_, index) => ({
      pass: index + 1,
      observedAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      reviewer: "acceptance-reviewer",
      resolvedDefects: [`${kind} defect ${index + 1} resolved`],
      before: evidence(`${kind}-${index + 1}-before`),
      after: evidence(`${kind}-${index + 1}-after`),
    }));
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-16T00:00:00.000Z",
    candidate: {
      sourceSha,
      imageDigests: images(),
      receipt: {
        url: candidateReceiptUrl,
        sha256: candidateReceiptSha256,
        artifact: "release-candidate.json",
      },
    },
    staging: {
      sourceSha,
      imageDigests: images(),
      deploymentUrl: "https://staging.example",
      evidenceUrl: stagingEvidenceUrl,
    },
    production: {
      sourceSha,
      imageDigests: images(),
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
    visualPasses: { desktop: visualPasses("desktop"), mobile: visualPasses("mobile") },
    results: WORKBENCH_ACCEPTANCE_REQUIREMENTS.flatMap((requirement) =>
      requirement.environments.map((environment) => validResult(requirement.id, environment)),
    ),
  };
}

function validate(bundle: WorkbenchAcceptanceBundle) {
  return validateWorkbenchAcceptanceBundle(bundle, {
    sourceSha,
    candidateReceipt,
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

  test("rejects emulated hardware, fewer than ten passes, and timing shortcuts", () => {
    const emulated = validBundle();
    const hardware = emulated.results.find((item) =>
      REAL_DEVICE_REQUIREMENTS.has(item.requirementId),
    )!;
    hardware.device!.real = false;
    expect(() => validate(emulated)).toThrow("emulation is insufficient");

    const visual = validBundle();
    visual.visualPasses.mobile.pop();
    expect(() => validate(visual)).toThrow("at least 10 passes");

    const timing = validBundle();
    const repeated = timing.results.find((item) =>
      TIMING_SENSITIVE_REQUIREMENTS.has(item.requirementId),
    )!;
    repeated.repetitions = 99;
    expect(() => validate(timing)).toThrow("at least 100 consecutive repetitions");
  });

  test("rejects rubber-stamped visual passes and repeated attempts", () => {
    const noDefect = validBundle();
    noDefect.visualPasses.desktop[0]!.resolvedDefects = [];
    expect(() => validate(noDefect)).toThrow("at least one resolved defect");

    const sameEvidence = validBundle();
    sameEvidence.visualPasses.mobile[0]!.after = sameEvidence.visualPasses.mobile[0]!.before;
    expect(() => validate(sameEvidence)).toThrow("must reference distinct evidence");

    const repeated = validBundle();
    repeated.results[0]!.attempts = 2;
    expect(() => validate(repeated)).toThrow("attempts must be exactly 1");
  });

  test("rejects extra environment rows and impossible measurement distributions", () => {
    const extra = validBundle();
    extra.results.push(validResult("functional.capture-absence", "production"));
    expect(() => validate(extra)).toThrow(
      "unexpected acceptance result functional.capture-absence@production",
    );

    const unordered = validBundle();
    const capture = unordered.results.find(
      (item) => item.requirementId === "performance.capture-api-response",
    )!;
    capture.measurement!.p75 = capture.measurement!.p50 - 1;
    expect(() => validate(unordered)).toThrow("are not ordered for a maximum budget");

    const negative = validBundle();
    const fps = negative.results.find(
      (item) => item.requirementId === "performance.tree-scroll-resize",
    )!;
    fps.measurement!.worst = -1;
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
