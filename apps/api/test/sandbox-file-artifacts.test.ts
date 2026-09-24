import { describe, expect, test } from "bun:test";
import { SandboxChannelAService } from "@opengeni/runtime/sandbox";

import {
  sandboxArtifactRelativePath,
  readSandboxArtifactFile,
  sandboxArtifactSafeFilename,
  sandboxFileContentType,
} from "../src/sandbox-file-artifacts";

describe("sandbox file artifact paths", () => {
  test.each(["/workspace", "/home/tester/project", "C:/work/project", "//server/share/project"])(
    "reads relative and absolute aliases through the same service root %s",
    async (root) => {
      const reads: string[] = [];
      const service = new SandboxChannelAService({
        workspaceRoot: root,
        providerPathMode: "workspace-relative",
        fileReadScope: "machine",
        session: {
          async readFile({ path }) {
            reads.push(path);
            return Buffer.from("synthetic fixture");
          },
        },
      });
      const relative = await readSandboxArtifactFile(service, "fixtures/upload.txt", 1024);
      const absolute = await readSandboxArtifactFile(service, `${root}/fixtures/upload.txt`, 1024);
      expect(absolute).toEqual(relative);
      expect(absolute.path).toBe("fixtures/upload.txt");
      expect(absolute.sandboxPath).toBe(`${root}/fixtures/upload.txt`);
      expect(Buffer.from(absolute.read.content, "base64").toString()).toBe("synthetic fixture");
      expect(reads).toEqual(["fixtures/upload.txt", "fixtures/upload.txt"]);
      await expect(readSandboxArtifactFile(service, "../secret.txt", 1024)).rejects.toThrow();
      expect(reads).toHaveLength(2);
    },
  );

  test("does not bypass a provider's final workspace-escape rejection", async () => {
    const service = new SandboxChannelAService({
      workspaceRoot: "/workspace",
      session: {
        async readFile() {
          throw new Error("path resolves outside workspace");
        },
      },
    });
    await expect(readSandboxArtifactFile(service, "link.txt", 1024)).rejects.toThrow();
  });

  test.each([
    ["/home/tester/project", "/home/tester/project/reports/final.pdf"],
    ["/Users/tester/project", "sandbox:/Users/tester/project/reports/final.pdf"],
    ["C:/work/project", "sandbox:C:\\work\\project\\reports\\final.pdf"],
    ["//server/share/project", "\\\\server\\share\\project\\reports\\final.pdf"],
  ])("uses the active host-native root %s", (root, path) => {
    expect(sandboxArtifactRelativePath(path, root)).toBe("reports/final.pdf");
    expect(sandboxArtifactRelativePath("reports/final.pdf", root)).toBe("reports/final.pdf");
  });

  test("rejects root aliases, siblings, traversal and cross-drive paths", () => {
    for (const path of [
      "/workspace/reports/final.pdf",
      "/home/tester/project-other/final.pdf",
      "/home/tester/project/../secret.txt",
      "../secret.txt",
      "/home/tester/project",
      "sandbox:/home/tester/project/",
    ]) {
      expect(() => sandboxArtifactRelativePath(path, "/home/tester/project")).toThrow();
    }
    for (const path of ["D:/work/project/file.txt", "C:secret.txt", "..\\secret.txt"]) {
      expect(() => sandboxArtifactRelativePath(path, "C:/work/project")).toThrow();
    }
  });

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
    expect(sandboxFileContentType("demo.MP4")).toBe("video/mp4");
    expect(sandboxFileContentType("voice.mp3")).toBe("audio/mpeg");
    expect(sandboxFileContentType("archive.zip")).toBe("application/zip");
    expect(sandboxFileContentType("unknown.custom")).toBe("application/octet-stream");
    // Writer MIME must remain replay-compatible with the rolling base binary.
    expect(sandboxFileContentType("diagram.SVG")).toBe("application/octet-stream");
    expect(sandboxFileContentType("animation.gif")).toBe("application/octet-stream");
    expect(sandboxFileContentType("screenshot.avif")).toBe("application/octet-stream");
  });
});
