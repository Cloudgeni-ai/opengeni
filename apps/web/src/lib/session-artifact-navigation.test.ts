import { describe, expect, test } from "bun:test";
import { artifactReturnSearch } from "./routes";
import { sessionArtifactFromHref } from "./session-artifact-navigation";

const workspace = "11111111-1111-4111-8111-111111111111";
const artifact = "22222222-2222-4222-8222-222222222222";
const origin = "https://console.example";
const path = `/workspaces/${workspace}/artifacts/${artifact}`;

describe("session artifact navigation", () => {
  test("recognizes canonical relative and absolute Site and editor links", () => {
    for (const href of [path, `${origin}${path}`]) {
      expect(sessionArtifactFromHref(href, origin, workspace)).toEqual({
        id: artifact,
        editable: false,
      });
    }
    expect(
      sessionArtifactFromHref(
        path.replace("/artifacts/", "/artifacts/editable/"),
        origin,
        workspace,
      ),
    ).toEqual({ id: artifact, editable: true });
  });
  test("leaves foreign, malformed, download, and version-specific destinations alone", () => {
    for (const href of [
      `https://other.example${path}`,
      `//other.example${path}`,
      path.replace(workspace, artifact),
      `${path}/content`,
      `${path}?version=1`,
      `${path}#section`,
      path.replace(artifact, "invalid"),
      "javascript:alert(1)",
      "/workspace/report.html",
    ])
      expect(sessionArtifactFromHref(href, origin, workspace)).toBeNull();
  });
  test("accepts only a session ID as return context, never an arbitrary URL", () => {
    expect(artifactReturnSearch({ fromSession: workspace })).toEqual({ fromSession: workspace });
    for (const fromSession of [
      "https://evil.example",
      "../sessions",
      "",
      12,
      [workspace],
      undefined,
    ]) {
      expect(artifactReturnSearch({ fromSession })).toEqual({});
    }
  });
});
