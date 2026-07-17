import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { WorkspaceCaptureManifest } from "@opengeni/sdk";

import {
  assertFixtureCapture,
  assertDedicatedCanaryEmail,
  fixturePrompt,
  parseCookieHeader,
  parseLiveAcceptanceArgs,
  parseProtectedEmails,
  sanitizeDiagnostic,
} from "./workbench-live-acceptance";

describe("workbench live acceptance preflight", () => {
  test("rejects the protected manually used production account", () => {
    const protectedEmails = parseProtectedEmails("manually-used@example.com");
    expect(() =>
      assertDedicatedCanaryEmail(
        "manually-used@example.com",
        "manually-used@example.com",
        protectedEmails,
      ),
    ).toThrow("protected manually used account");
    expect(() =>
      assertDedicatedCanaryEmail(
        "acceptance@example.com",
        "manually-used@example.com",
        protectedEmails,
      ),
    ).toThrow("protected manually used account");
    expect(() => parseProtectedEmails("  ,  ")).toThrow("must list valid protected accounts");
  });

  test("requires the exact dedicated canary email", () => {
    const protectedEmails = parseProtectedEmails("manually-used@example.com");
    expect(
      assertDedicatedCanaryEmail(
        "acceptance@example.com",
        "acceptance@example.com",
        protectedEmails,
      ),
    ).toBe("acceptance@example.com");
    expect(() =>
      assertDedicatedCanaryEmail("other@example.com", "acceptance@example.com", protectedEmails),
    ).toThrow("does not match");
    expect(parseProtectedEmails(" First@example.com,SECOND@example.com ")).toEqual(
      new Set(["first@example.com", "second@example.com"]),
    );
  });

  test("enforces HTTPS, a full SHA, Modal, and at least 100 repetitions", () => {
    const base = [
      "--api-url",
      "https://api.example.com",
      "--web-url",
      "https://app.example.com",
      "--environment",
      "staging",
      "--source-sha",
      "a".repeat(40),
      "--run-id",
      "acceptance-001",
      "--model",
      "codex/model",
    ];
    expect(parseLiveAcceptanceArgs(base).repetitions).toBe(100);
    expect(() => parseLiveAcceptanceArgs([...base, "--repetitions", "99"])).toThrow(">= 100");
    expect(() => parseLiveAcceptanceArgs(base.with(1, "http://api.example.com"))).toThrow("HTTPS");
  });

  test("cookie parser preserves signed values and diagnostics strip URL credentials", () => {
    expect(parseCookieHeader("better-auth.session_token=a.b%3D; second=x=y")).toEqual([
      { name: "better-auth.session_token", value: "a.b%3D" },
      { name: "second", value: "x=y" },
    ]);
    const clean = sanitizeDiagnostic(
      "GET https://blob.example/file?signature=secret&token=also-secret Bearer abc.def",
    );
    expect(clean).toBe("GET https://blob.example/file Bearer [redacted]");
  });

  test("the fixture and its verifier fail closed across the documented boundary matrix", () => {
    const marker = "OPENGENI_WORKBENCH_ACCEPTANCE_001";
    const prompt = fixturePrompt(marker);
    for (const required of [
      "web-linked",
      "nested/deep/repo",
      "\\303\\274ber \\316\\273.txt",
      "server-link.ts",
      "external-link",
      "external-dir",
      "node_modules",
      "chmod +x",
    ]) {
      expect(prompt).toContain(required);
    }

    const manifest = fixtureManifest(marker);
    expect(() => assertFixtureCapture(manifest, marker)).not.toThrow();

    manifest.repos.find((repo) => repo.root === "web")!.status = manifest.repos
      .find((repo) => repo.root === "web")!
      .status.filter((item) => item.path !== "renamed.txt");
    expect(() => assertFixtureCapture(manifest, marker)).toThrow("renamed fixture status drifted");
  });
});

function fixtureManifest(marker: string): WorkspaceCaptureManifest {
  const content = new Map<string, Uint8Array>([
    [
      "api/server.ts",
      Buffer.from(`export const marker = "${marker}";\nexport const status = 204;\n`),
    ],
    ["api/notes.txt", Buffer.from(`untracked ${marker}\n`)],
    ["api/empty.txt", Buffer.alloc(0)],
    ["api/binary.dat", Buffer.from([0, 1, 254, 255])],
    ["api/signed-preview.txt", Buffer.alloc(307_200, "s")],
    ["api/run.sh", Buffer.from(`#!/bin/sh\necho ${marker}\n`)],
    [
      "api/server-link.ts",
      Buffer.from(`export const marker = "${marker}";\nexport const status = 204;\n`),
    ],
    ["api/über λ.txt", Buffer.from(`unicode ${marker}\n`)],
    ["web/app.js", Buffer.from(`console.log("staged and unstaged ${marker}");\n`)],
    ["web/renamed.txt", Buffer.from("rename me\n")],
    ["web-linked/worktree-marker.txt", Buffer.from(`linked ${marker}\n`)],
    ["nested/deep/repo/deep.txt", Buffer.from(`deep ${marker}\n`)],
  ]);
  const file = (
    path: string,
    status: WorkspaceCaptureManifest["files"][number]["status"] = "modified",
  ): WorkspaceCaptureManifest["files"][number] => {
    const bytes = content.get(path)!;
    return {
      path,
      status,
      hash: hash(bytes),
      baseHash: null,
      contentRef: `fixture/${encodeURIComponent(path)}`,
      sizeBytes: bytes.byteLength,
      isBinary: path === "api/binary.dat",
      tooLarge: false,
      deleted: false,
    };
  };
  const diff = (
    path: string,
    text: string,
  ): WorkspaceCaptureManifest["repos"][number]["diff"][number] => ({
    path,
    oldPath: null,
    status: path.startsWith("external-") ? "untracked" : "modified",
    isBinary: false,
    isImage: false,
    additions: 1,
    deletions: 0,
    truncated: false,
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        header: "@@ -0,0 +1 @@",
        lines: [{ type: "add", oldNo: null, newNo: 1, text }],
      },
    ],
  });
  const status = (
    path: string,
    index: WorkspaceCaptureManifest["repos"][number]["status"][number]["index"],
    worktree: WorkspaceCaptureManifest["repos"][number]["status"][number]["worktree"],
    oldPath: string | null = null,
  ) => ({ path, oldPath, index, worktree, isConflicted: false });
  const repo = (
    root: string,
    statuses: WorkspaceCaptureManifest["repos"][number]["status"],
    diffs: WorkspaceCaptureManifest["repos"][number]["diff"] = [],
  ): WorkspaceCaptureManifest["repos"][number] => ({
    root,
    head: "main",
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    status: statuses,
    diff: diffs,
  });
  const treeNode = (
    path: string,
    type: WorkspaceCaptureManifest["treeIndex"]["type"] = "file",
    mode = 0o644,
  ): WorkspaceCaptureManifest["treeIndex"] => ({
    name: path.split("/").at(-1)!,
    path,
    type,
    sizeBytes: type === "dir" ? null : 1,
    mtimeMs: 1,
    mode,
    truncated: false,
  });

  return {
    version: 1,
    revision: 1,
    capturedAt: "2026-07-16T00:00:00.000Z",
    turnId: null,
    leaseEpoch: 1,
    treeIndex: {
      ...treeNode("", "dir", 0o755),
      children: [
        treeNode("api/server-link.ts", "symlink"),
        treeNode("api/external-link", "symlink"),
        treeNode("api/external-dir", "symlink"),
        treeNode("api/run.sh", "file", 0o755),
        treeNode("api/über λ.txt"),
      ],
    },
    treeTruncated: false,
    repos: [
      repo(
        "api",
        [
          status("server.ts", null, "modified"),
          status("notes.txt", null, "untracked"),
          status("external-link", null, "untracked"),
          status("external-dir", null, "untracked"),
        ],
        [
          diff("server.ts", marker),
          diff("external-link", `/tmp/opengeni-${marker}`),
          diff("external-dir", `/tmp/opengeni-dir-${marker}`),
        ],
      ),
      repo("web", [
        status("app.js", "modified", "modified"),
        status("renamed.txt", "renamed", null, "old-name.txt"),
        status("deleted.txt", "deleted", null),
      ]),
      repo("web-linked", [status("worktree-marker.txt", null, "untracked")]),
      repo("nested/deep/repo", [status("deep.txt", null, "modified")]),
    ],
    files: [
      file("api/server.ts"),
      file("api/notes.txt", "untracked"),
      file("api/empty.txt", "untracked"),
      file("api/binary.dat", "untracked"),
      file("api/signed-preview.txt", "untracked"),
      {
        path: "api/too-large.bin",
        status: "untracked",
        hash: null,
        baseHash: null,
        contentRef: null,
        sizeBytes: 5 * 1024 * 1024,
        isBinary: true,
        tooLarge: true,
        deleted: false,
      },
      file("api/run.sh"),
      file("api/server-link.ts", "untracked"),
      file("api/über λ.txt", "untracked"),
      file("web/app.js"),
      file("web/renamed.txt", "renamed"),
      {
        path: "web/deleted.txt",
        status: "deleted",
        hash: null,
        baseHash: null,
        contentRef: null,
        sizeBytes: 0,
        isBinary: false,
        tooLarge: false,
        deleted: true,
      },
      file("web-linked/worktree-marker.txt", "untracked"),
      file("nested/deep/repo/deep.txt"),
    ],
    stats: {
      repoCount: 4,
      fileCount: 14,
      additions: 1,
      deletions: 1,
      totalBytes: 1,
      tooLargeCount: 1,
      binaryCount: 1,
      treeEntryCount: 4,
      treeTruncated: false,
      durationMs: 1,
    },
  };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
