import { describe, expect, test } from "bun:test";

describe("host-export package entrypoint", () => {
  test("does not import Temporal's native worker graph", async () => {
    const result = await Bun.build({
      entrypoints: [new URL("../src/host-export.ts", import.meta.url).pathname],
      target: "bun",
      packages: "external",
      metafile: true,
      write: false,
    });

    expect(result.success).toBe(true);
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    expect(inputs.some((path) => path.includes("@temporalio/"))).toBe(false);
    expect(inputs.some((path) => path.endsWith("apps/worker/src/index.ts"))).toBe(false);
  });
});
