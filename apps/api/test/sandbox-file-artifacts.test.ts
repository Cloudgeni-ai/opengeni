import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessGrant } from "@opengeni/contracts";
import { SandboxChannelAService } from "@opengeni/runtime/sandbox";

import {
  sandboxArtifactPath,
  sandboxArtifactPathScope,
  readSandboxArtifactFile,
  sandboxArtifactSafeFilename,
  sandboxFileContentType,
} from "../src/sandbox-file-artifacts";

const workspace = mkdtempSync(join(tmpdir(), "opengeni-publish-root-"));
const scratch = mkdtempSync(join(tmpdir(), "opengeni-publish-tmp-"));
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("publishing a file the session's shell can read", () => {
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const grant = (overrides: Partial<AccessGrant>) =>
    ({
      accountId: "account",
      workspaceId: "workspace",
      subjectId: "subject",
      permissions: ["files:read", "files:upload"],
      ...overrides,
    }) as AccessGrant;
  const attempt = (forSession: string) =>
    grant({
      principalKind: "agent_attempt",
      metadata: {
        sessionId: forSession,
        turnId: "turn",
        attemptId: "attempt",
        executionGeneration: 1,
      },
    });

  test("the session's own agent, or someone allowed its terminal, may use any shell path", () => {
    expect(sandboxArtifactPathScope(attempt(sessionId), sessionId)).toBe("shell");
    expect(
      sandboxArtifactPathScope(
        grant({ permissions: ["files:read", "files:upload", "terminal:attach"] }),
        sessionId,
      ),
    ).toBe("shell");
    // Without the session's shell a caller keeps the workspace scope.
    expect(sandboxArtifactPathScope(grant({}), sessionId)).toBe("workspace");
    expect(
      sandboxArtifactPathScope(attempt("00000000-0000-4000-8000-000000000002"), sessionId),
    ).toBe("workspace");
  });

  test("names a file outside the workspace by its absolute path", () => {
    expect(sandboxArtifactPath("/tmp/out/report.pdf", "/workspace", "shell")).toBe(
      "/tmp/out/report.pdf",
    );
    expect(sandboxArtifactPath("../tmp/report.pdf", "/workspace", "shell")).toBe("/tmp/report.pdf");
    expect(sandboxArtifactPath("C:/Temp/report.pdf", "C:/work/project", "shell")).toBe(
      "C:/Temp/report.pdf",
    );
    // A workspace file keeps its relative name, and so its artifact identity.
    expect(sandboxArtifactPath("/workspace/reports/final.pdf", "/workspace", "shell")).toBe(
      "reports/final.pdf",
    );
  });

  test("a managed sandbox publishes a temp file through its shell", async () => {
    writeFileSync(join(scratch, "chart.png"), "png bytes");
    const service = new SandboxChannelAService({
      workspaceRoot: workspace,
      session: {
        // The provider's native read only reaches the workspace.
        async readFile() {
          throw new Error("path resolves outside workspace");
        },
        async exec({ cmd }) {
          const result = spawnSync("bash", ["--noprofile", "--norc", "-c", cmd], {
            encoding: "utf8",
          });
          return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
        },
      },
    });
    const path = join(scratch, "chart.png");
    await expect(readSandboxArtifactFile(service, path, 1024)).rejects.toThrow(
      /copy the file into the workspace/,
    );
    const published = await readSandboxArtifactFile(service, path, 1024, "shell");
    expect(published.path).toBe(path);
    expect(published.sandboxPath).toBe(path);
    expect(Buffer.from(published.read.content, "base64").toString()).toBe("png bytes");
  });

  test("a Connected Machine publishes a temp file at its host path", async () => {
    const reads: string[] = [];
    const service = new SandboxChannelAService({
      workspaceRoot: "/home/user/project",
      providerPathMode: "workspace-relative",
      fileReadScope: "machine",
      session: {
        async readFile({ path }) {
          reads.push(path);
          return Buffer.from("machine bytes");
        },
      },
    });
    const published = await readSandboxArtifactFile(service, "/tmp/out.csv", 1024, "shell");
    expect(published.path).toBe("/tmp/out.csv");
    expect(Buffer.from(published.read.content, "base64").toString()).toBe("machine bytes");
    expect(reads).toEqual(["/tmp/out.csv"]);
  });
});

describe("sandbox file artifact paths", () => {
  test.each(["/workspace", "/home/user/project", "C:/work/project", "//server/share/project"])(
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
    ["/home/user/project", "/home/user/project/reports/final.pdf"],
    ["/Users/user/project", "sandbox:/Users/user/project/reports/final.pdf"],
    ["C:/work/project", "sandbox:C:\\work\\project\\reports\\final.pdf"],
    ["//server/share/project", "\\\\server\\share\\project\\reports\\final.pdf"],
  ])("uses the active host-native root %s", (root, path) => {
    expect(sandboxArtifactPath(path, root)).toBe("reports/final.pdf");
    expect(sandboxArtifactPath("reports/final.pdf", root)).toBe("reports/final.pdf");
  });

  test("rejects root aliases, siblings, traversal and cross-drive paths", () => {
    for (const path of [
      "/workspace/reports/final.pdf",
      "/home/user/project-other/final.pdf",
      "/home/user/project/../secret.txt",
      "../secret.txt",
      "/home/user/project",
      "sandbox:/home/user/project/",
      "C:/other/file.txt",
      "C:\\other\\file.txt",
    ]) {
      expect(() => sandboxArtifactPath(path, "/home/user/project")).toThrow();
    }
    for (const path of ["D:/work/project/file.txt", "C:secret.txt", "..\\secret.txt"]) {
      expect(() => sandboxArtifactPath(path, "C:/work/project")).toThrow();
    }
    // A file elsewhere on the machine is named, with the way forward.
    expect(() => sandboxArtifactPath("/Users/me/Downloads/key.p8", "/Users/me/work")).toThrow(
      "sandbox artifact path must name a file inside this session's workspace root /Users/me/work; /Users/me/Downloads/key.p8 is outside it, so copy the file into the workspace first and use that path",
    );
  });

  test("accepts workspace-relative, absolute workspace, and sandbox-link paths", () => {
    expect(sandboxArtifactPath("reports/final.pdf")).toBe("reports/final.pdf");
    expect(sandboxArtifactPath("/workspace/reports/final.pdf")).toBe("reports/final.pdf");
    expect(sandboxArtifactPath("sandbox:/workspace/reports//final.pdf")).toBe("reports/final.pdf");
  });

  test("rejects the workspace root and paths that escape it", () => {
    for (const path of [
      "",
      "/workspace",
      "/etc/passwd",
      "/workspace/../../etc/passwd",
      "reports/",
    ]) {
      expect(() => sandboxArtifactPath(path)).toThrow();
    }
  });

  test("bounds the canonical absolute path before reading the sandbox", () => {
    expect(sandboxArtifactPath("a".repeat(4_085))).toHaveLength(4_085);
    expect(() => sandboxArtifactPath("a".repeat(4_086))).toThrow();
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
