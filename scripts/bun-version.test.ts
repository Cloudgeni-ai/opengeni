import { describe, expect, test } from "bun:test";

import {
  canonicalBunVersion,
  verifyMuslAssetChecksums,
  verifyBunVersionContract,
  verifyWorkflowBunSetup,
} from "./bun-version";

describe("canonical Bun version contract", () => {
  test("keeps runtime, package, workflow, and container pins coherent", async () => {
    await expect(verifyBunVersionContract({ checkRuntime: false })).resolves.toBeUndefined();
    expect(await canonicalBunVersion()).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  test("requires every setup-bun step to consume .bun-version", () => {
    expect(() =>
      verifyWorkflowBunSetup(
        "valid.yml",
        [
          "steps:",
          "  - name: Set up Bun",
          "    uses: oven-sh/setup-bun@v2",
          "    with:",
          "      bun-version-file: .bun-version",
          "  - run: bun test",
        ].join("\n"),
      ),
    ).not.toThrow();
    expect(() =>
      verifyWorkflowBunSetup(
        "floating.yml",
        ["steps:", "  - uses: oven-sh/setup-bun@v2", "  - run: bun test"].join("\n"),
      ),
    ).toThrow("floating.yml setup-bun step must read the canonical .bun-version file");

    expect(() =>
      verifyWorkflowBunSetup(
        "mixed.yml",
        [
          "steps:",
          "  - uses: oven-sh/setup-bun@v2",
          "  - uses: oven-sh/setup-bun@v2",
          "    with:",
          "      bun-version-file: .bun-version",
        ].join("\n"),
      ),
    ).toThrow("mixed.yml setup-bun step must read the canonical .bun-version file");
  });

  test("binds musl release checksums to the canonical version", () => {
    const source = [
      "bun_archive: bun-linux-x64-musl.zip",
      `bun_sha256: ${"a".repeat(64)} # bun-v1.4.0`,
      "bun_archive: bun-linux-aarch64-musl.zip",
      `bun_sha256: ${"b".repeat(64)} # bun-v1.4.0`,
    ].join("\n");
    expect(() => verifyMuslAssetChecksums("1.4.0", source)).not.toThrow();
    expect(() => verifyMuslAssetChecksums("1.4.1", source)).toThrow(
      "checksum must be annotated for canonical bun-v1.4.1",
    );
  });
});
