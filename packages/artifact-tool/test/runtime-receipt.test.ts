import { describe, expect, test } from "bun:test";

import { validateArtifactKernelBuildReceipt } from "../src/runtime-receipt";

const currentReceipt = Object.freeze({
  schemaVersion: 2,
  producer: "opengeni-artifact-kernel-smoke-v2",
  target: "darwin-arm64",
  kind: "native",
  buildIdentity: "fixture-build",
  capabilities: Object.freeze({ bytes: 1, sha256: `sha256:${"a".repeat(64)}` }),
  spreadsheetFormulaProjectionCorpusSha256: `sha256:${"b".repeat(64)}`,
  runtimeFiles: Object.freeze([
    Object.freeze({
      path: "opengeni_artifact_kernel.node",
      bytes: 1,
      sha256: `sha256:${"c".repeat(64)}`,
    }),
  ]),
});

describe("artifact kernel build receipt", () => {
  test("accepts only the current receipt protocol", () => {
    expect(validateArtifactKernelBuildReceipt(currentReceipt)).toEqual(currentReceipt);
    expect(() =>
      validateArtifactKernelBuildReceipt({
        ...currentReceipt,
        schemaVersion: 1,
        producer: "opengeni-artifact-kernel-smoke-v1",
      }),
    ).toThrow("schema/producer is invalid");
  });
});
