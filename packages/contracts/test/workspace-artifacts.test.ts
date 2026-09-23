import { describe, expect, test } from "bun:test";
import {
  CreateWorkspaceArtifactRequest,
  WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES,
  WorkspaceArtifactRequestedTools,
  WorkspaceArtifactSourceBundle,
  WorkspaceArtifactHtml,
  WorkspaceArtifactListQuery,
  WorkspaceArtifactListResponse,
  normalizeWorkspaceArtifactSlug,
} from "../src";

describe("workspace artifact contracts", () => {
  test("keeps the product primitive generic and normalizes generated slugs", () => {
    expect(normalizeWorkspaceArtifactSlug("  Quarterly Video Gallery!  ")).toBe(
      "quarterly-video-gallery",
    );
    const parsed = CreateWorkspaceArtifactRequest.parse({
      title: "Quarterly Video Gallery",
      html: "<!doctype html><h1>Videos</h1>",
      idempotencyKey: "attempt-1",
    });
    expect(parsed).not.toHaveProperty("kind");
    expect(parsed).not.toHaveProperty("type");
  });

  test("allows large HTML and optional-source upload references without allocating the storage ceiling", () => {
    expect(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES).toBe(5_000_000_000);
    expect(WorkspaceArtifactHtml.safeParse("😀".repeat(1_100_000)).success).toBe(true);
    const input = {
      title: "Uploaded Site",
      idempotencyKey: "upload",
      uploadId: crypto.randomUUID(),
    };
    expect(CreateWorkspaceArtifactRequest.safeParse(input).success).toBe(true);
    expect(
      CreateWorkspaceArtifactRequest.safeParse({ ...input, html: "<h1>Conflicting input</h1>" })
        .success,
    ).toBe(false);
    expect(
      CreateWorkspaceArtifactRequest.safeParse({ title: "Missing HTML", idempotencyKey: "missing" })
        .success,
    ).toBe(false);
  });

  test("bounds list pages and makes truncation explicit", () => {
    expect(WorkspaceArtifactListQuery.parse({})).toEqual({ limit: 50 });
    expect(WorkspaceArtifactListQuery.parse({ status: "active" })).toEqual({
      limit: 50,
      status: "active",
    });
    expect(WorkspaceArtifactListQuery.safeParse({ status: "deleted" }).success).toBe(false);
    expect(WorkspaceArtifactListQuery.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      WorkspaceArtifactListResponse.safeParse({
        artifacts: [],
        nextCursor: null,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(WorkspaceArtifactListResponse.safeParse({ artifacts: [] }).success).toBe(false);
  });

  test("retains traversal-free source bundles and unique requested tool identities", () => {
    expect(
      WorkspaceArtifactSourceBundle.parse({
        entrypoint: "src/index.tsx",
        files: [
          { path: "src/index.tsx", content: "export {};" },
          { path: "src/styles.css", content: ":root{}" },
        ],
      }),
    ).toMatchObject({ entrypoint: "src/index.tsx" });
    expect(
      WorkspaceArtifactSourceBundle.safeParse({
        entrypoint: "../index.tsx",
        files: [{ path: "../index.tsx", content: "" }],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceArtifactRequestedTools.safeParse([
        { serverId: "docs", toolName: "search" },
        { serverId: "docs", toolName: "search" },
      ]).success,
    ).toBe(false);
  });
});
