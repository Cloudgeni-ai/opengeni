import { describe, expect, test } from "bun:test";

import {
  sandboxArtifactRelativePath,
  sandboxArtifactSafeFilename,
  sandboxFileContentType,
} from "../src/sandbox-file-artifacts";

describe("sandbox file artifact paths", () => {
  test("accepts workspace-relative, absolute workspace, and sandbox-link paths", () => {
    expect(sandboxArtifactRelativePath("reports/final.pdf")).toBe("reports/final.pdf");
    expect(sandboxArtifactRelativePath("/workspace/reports/final.pdf")).toBe("reports/final.pdf");
    expect(sandboxArtifactRelativePath("sandbox:/workspace/reports//final.pdf")).toBe(
      "reports/final.pdf",
    );
  });

  test("rejects the workspace root and paths that escape it", () => {
    for (const path of [
      "",
      "/workspace",
      "/etc/passwd",
      "/workspace/../../etc/passwd",
      "reports/",
    ]) {
      expect(() => sandboxArtifactRelativePath(path)).toThrow();
    }
  });

  test("bounds the canonical absolute path before reading the sandbox", () => {
    expect(sandboxArtifactRelativePath("a".repeat(4_085))).toHaveLength(4_085);
    expect(() => sandboxArtifactRelativePath("a".repeat(4_086))).toThrow();
  });

  test("bounds the provider-facing filename independently of the user filename", () => {
    expect(sandboxArtifactSafeFilename("a".repeat(1_024))).toHaveLength(200);
    expect(sandboxArtifactSafeFilename(" report?.pdf ")).toBe("report_.pdf");
  });

  test("uses stable MIME types with an opaque fallback", () => {
    expect(sandboxFileContentType("report.PDF")).toBe("application/pdf");
    expect(sandboxFileContentType("archive.zip")).toBe("application/zip");
    expect(sandboxFileContentType("unknown.custom")).toBe("application/octet-stream");
  });
});
