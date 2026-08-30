import { describe, expect, test } from "bun:test";
import {
  AppFilePath,
  AppBuildManifest,
  AppToolDescriptor,
  CreateAppLaunchRequest,
  CreateWorkspaceAppRequest,
  WORKSPACE_APP_BUILD_FILE_MAX_BYTES,
  WorkspaceAppListQuery,
  normalizeWorkspaceAppSlug,
} from "../src";

const digest = "a".repeat(64);

describe("OpenGeni Apps contracts", () => {
  test("normalizes slugs while keeping Apps separate from HTML artifacts", () => {
    expect(normalizeWorkspaceAppSlug("  Quarterly Operations Console!  ")).toBe(
      "quarterly-operations-console",
    );
    expect(
      CreateWorkspaceAppRequest.parse({
        title: "Quarterly Operations Console",
        idempotencyKey: "create-app-1",
      }),
    ).not.toHaveProperty("html");
  });

  test("accepts only normalized, traversal-safe portable paths", () => {
    expect(AppFilePath.parse("assets/app.js")).toBe("assets/app.js");
    for (const unsafePath of ["/index.html", "../index.html", "a/../index.html", "a\\b.js", "a//b"])
      expect(AppFilePath.safeParse(unsafePath).success).toBe(false);
  });

  test("pins a manifest to unique files, a real entry point, and exact byte totals", () => {
    const manifest = {
      version: "opengeni.app-build.v1",
      entryPath: "index.html",
      files: [
        {
          path: "index.html",
          contentType: "text/html; charset=utf-8",
          contentSha256: digest,
          sizeBytes: 12,
        },
      ],
      totalBytes: 12,
    };
    expect(AppBuildManifest.safeParse(manifest).success).toBe(true);
    expect(
      AppBuildManifest.safeParse({ ...manifest, entryPath: "missing.html" }).success,
    ).toBe(false);
    expect(AppBuildManifest.safeParse({ ...manifest, totalBytes: 11 }).success).toBe(false);
    expect(
      AppBuildManifest.safeParse({
        ...manifest,
        files: [manifest.files[0], manifest.files[0]],
        totalBytes: 24,
      }).success,
    ).toBe(false);
    expect(
      AppBuildManifest.safeParse({
        ...manifest,
        files: [{ ...manifest.files[0], sizeBytes: WORKSPACE_APP_BUILD_FILE_MAX_BYTES + 1 }],
        totalBytes: WORKSPACE_APP_BUILD_FILE_MAX_BYTES + 1,
      }).success,
    ).toBe(false);
  });

  test("fails closed unless the canonical runtime tool is closed-world and replay-safe", () => {
    const descriptor = {
      identity: { serverId: "status", toolName: "read" },
      modelName: "status__read",
      programmaticPath: ["status", "read"],
      description: "Read status",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object" },
      source: "mcp",
      effect: "read",
      replaySafety: "safe",
      openWorld: false,
      approval: "none",
      supportedSurfaces: ["app"],
      requiredPermissions: ["apps:run"],
    };
    expect(AppToolDescriptor.safeParse(descriptor).success).toBe(true);
    expect(AppToolDescriptor.safeParse({ ...descriptor, effect: "write" }).success).toBe(false);
    expect(AppToolDescriptor.safeParse({ ...descriptor, openWorld: true }).success).toBe(false);
  });

  test("bounds list pages and launch lifetimes", () => {
    expect(WorkspaceAppListQuery.parse({})).toEqual({ limit: 50 });
    expect(WorkspaceAppListQuery.safeParse({ limit: 101 }).success).toBe(false);
    expect(CreateAppLaunchRequest.safeParse({ ttlSeconds: 901 }).success).toBe(false);
  });
});