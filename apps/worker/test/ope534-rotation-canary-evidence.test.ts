import { describe, expect, test } from "bun:test";
import {
  assertRotationEvidence,
  canaryConfiguration,
  type RotationEvidence,
} from "./ope534-rotation-canary-evidence";

const env = {
  OPENGENI_OPE534_CANARY: "1",
  OPENGENI_OPE534_CANARY_AUTHORIZATION: "ISOLATED_MODAL_CANARY_ONLY",
  OPENGENI_OPE534_SOURCE_SHA: "a".repeat(40),
  OPENGENI_OPE534_IMAGE_REF: `example.invalid/sandbox@sha256:${"b".repeat(64)}`,
  OPENGENI_OPE534_MODAL_ENVIRONMENT: "ope534-canary-12345678",
  MODAL_TOKEN_ID: "test-only",
  MODAL_TOKEN_SECRET: "test-only",
};
const valid = (): RotationEvidence => ({
  cycle: 1,
  predecessor: "old",
  successor: "new",
  predecessorEpoch: 1,
  successorEpoch: 2,
  providerCreatedAt: 1_000,
  providerDeadlineAt: 601_000,
  rotationRequestedAt: 421_000,
  rotationReason: "provider_deadline",
  completedAt: 460_000,
  rotationLeadMs: 180_000,
  processState: "exited",
  processProof: "exited",
  processSettledAt: 422_000,
  remainingProcessHolders: 0,
  baselineGeneration: 1,
  writtenGeneration: 3,
  publishedGeneration: 3,
  checkpointArtifactId: "artifact",
  checkpointVerified: true,
  checkpointCapturedAt: 423_000,
  captureReleased: true,
  expectedHashes: { baseline: "a".repeat(64), later: "b".repeat(64) },
  restoredHashes: { baseline: "a".repeat(64), later: "b".repeat(64) },
});

describe("OPE534 isolated canary admission", () => {
  test("accepts only explicit isolated immutable configuration", () => {
    expect(canaryConfiguration(env).sourceSha).toBe(env.OPENGENI_OPE534_SOURCE_SHA);
  });
  for (const patch of [
    { OPENGENI_OPE534_CANARY: "0" },
    { OPENGENI_OPE534_CANARY_AUTHORIZATION: "" },
    { OPENGENI_OPE534_SOURCE_SHA: "main" },
    { OPENGENI_OPE534_IMAGE_REF: "sandbox:latest" },
    { OPENGENI_OPE534_MODAL_ENVIRONMENT: "staging" },
    { OPENGENI_TEST_POSTGRES_ADMIN_URL: "postgres://localhost/shared" },
    { OPENGENI_TEST_POSTGRES_APP_URL: "postgres://localhost/shared" },
    { MODAL_TOKEN_SECRET: "" },
    { DOCKER_HOST: "ssh://shared-host" },
    { DOCKER_CONTEXT: "staging" },
  ])
    test(`rejects ${Object.keys(patch)[0]}`, () => {
      expect(() => canaryConfiguration({ ...env, ...patch })).toThrow("OPE534 canary:");
    });
});

describe("OPE534 rotation acceptance", () => {
  test("accepts a timely positively settled and restored rotation", () => {
    expect(() => assertRotationEvidence(valid())).not.toThrow();
  });
  const cases: Array<[string, Partial<RotationEvidence>]> = [
    ["hard expiry", { completedAt: 601_000 }],
    ["forced early", { rotationRequestedAt: 420_999 }],
    ["operator rotation", { rotationReason: "operator" }],
    ["lost server", { processState: "lost", processProof: "lost" }],
    ["unproved exit", { processProof: null }],
    ["early cancellation", { processSettledAt: 400_000 }],
    ["remaining blocker", { remainingProcessHolders: 1 }],
    ["stale snapshot", { publishedGeneration: 2 }],
    ["missing publication", { checkpointArtifactId: null }],
    ["unverified publication", { checkpointVerified: false }],
    ["capture before quiescence", { checkpointCapturedAt: 421_999 }],
    ["held capture", { captureReleased: false }],
    ["same instance", { successor: "old" }],
    ["same epoch", { successorEpoch: 1 }],
    ["no later write", { writtenGeneration: 1 }],
    ["missing restored file", { restoredHashes: {} }],
    ["NaN clock", { processSettledAt: NaN }],
    ["missing second-cycle marker", { cycle: 2 }],
  ];
  for (const [name, patch] of cases)
    test(`rejects ${name}`, () => {
      expect(() => assertRotationEvidence({ ...valid(), ...patch })).toThrow("OPE534 canary:");
    });
});
