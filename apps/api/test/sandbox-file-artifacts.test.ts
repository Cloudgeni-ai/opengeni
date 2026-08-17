import { describe, expect, test } from "bun:test";

import { sandboxArtifactRelativePath, sandboxFileContentType } from "../src/sandbox-file-artifacts";

describe("sandbox file artifact paths", () => {
  test("accepts workspace-relative, absolute workspace, and sandbox-link paths", () => {
    expect(sandboxArtifactRelativePath("reports/final.pdf")).toBe("reports/final.pdf");
    expect(sandboxArtifactRelativePath("/workspace/reports/final.pdf")).toBe("reports/final.pdf");
    expect(sandboxArtifactRelativePath("sandbox:/workspace/reports//final.pdf")).toBe(
      "reports/final.pdf",
    );
  });

  test("rejects the workspace root and paths that escape it", () => {
    for (const path of ["", "/workspace", "/etc/passwd", "/workspace/../../etc/passwd"]) {
      expect(() => sandboxArtifactRelativePath(path)).toThrow();
    }
  });

  test("uses stable MIME types with an opaque fallback", () => {
    expect(sandboxFileContentType("report.PDF")).toBe("application/pdf");
    expect(sandboxFileContentType("archive.zip")).toBe("application/zip");
    expect(sandboxFileContentType("unknown.custom")).toBe("application/octet-stream");
  });
});
