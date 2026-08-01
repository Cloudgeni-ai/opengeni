import { describe, expect, test } from "bun:test";
import {
  CreateWorkspaceArtifactRequest,
  WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES,
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

  test("enforces the UTF-8 payload ceiling rather than only character count", () => {
    const multibyte = "😀".repeat(Math.floor(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES / 4) + 1);
    expect(WorkspaceArtifactHtml.safeParse(multibyte).success).toBe(false);
    expect(
      WorkspaceArtifactHtml.safeParse("a".repeat(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES)).success,
    ).toBe(true);
  });

  test("bounds list pages and makes truncation explicit", () => {
    expect(WorkspaceArtifactListQuery.parse({})).toEqual({ limit: 50 });
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
});
