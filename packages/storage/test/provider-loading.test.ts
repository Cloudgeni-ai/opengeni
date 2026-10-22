import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("object storage provider startup boundary", () => {
  for (const backend of ["disabled", "s3-compatible", "aws-s3", "azure-blob", "gcs"]) {
    test(`loads only ${backend} before constructing storage`, async () => {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "provider-loading.fixture.ts"), backend],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const result = JSON.parse(stdout);
      expect(result.before).toEqual([]);
      expect(result.prepared).toEqual(
        backend === "disabled" ? [] : [backend === "s3-compatible" ? "aws-s3" : backend],
      );
      expect(result.constructed).toEqual(result.prepared);
      expect(result.backend).toBe(backend === "disabled" ? null : backend);
    });
  }
});
