import { describe, expect, test } from "bun:test";
import { openGeniConsolePath, parseOpenGeniLink } from "../src/index";

const WS = "11111111-1111-4111-8111-111111111111";
const EDITABLE = "0123456789ABCDEF0123456789abcdef";
const UUID = "22222222-2222-4222-8222-222222222222";

describe("parseOpenGeniLink", () => {
  test("classifies every agent-authored OpenGeni object link", () => {
    expect(parseOpenGeniLink(`artifact:${UUID}`)).toEqual({
      kind: "file",
      fileId: UUID,
      workspaceId: null,
    });
    expect(parseOpenGeniLink(`/workspaces/${WS}/artifacts/editable/${EDITABLE}`)).toEqual({
      kind: "editable-artifact",
      artifactId: EDITABLE.toLowerCase(),
      workspaceId: WS,
    });
    expect(parseOpenGeniLink(`/workspaces/${WS}/artifacts/${UUID}?fromSession=${UUID}`)).toEqual({
      kind: "site",
      artifactId: UUID,
      workspaceId: WS,
    });
    expect(parseOpenGeniLink(`/workspaces/${WS}/artifacts/files/${UUID}`)).toEqual({
      kind: "file",
      fileId: UUID,
      workspaceId: WS,
    });
    expect(parseOpenGeniLink("sandbox:reports/weekly%20report.pdf:3")).toEqual({
      kind: "sandbox-file",
      path: "reports/weekly report.pdf",
      line: 3,
    });
    expect(parseOpenGeniLink("/workspace/out.csv")).toEqual({
      kind: "sandbox-file",
      path: "/workspace/out.csv",
      line: null,
    });
  });

  test("leaves ordinary and ambiguous links alone", () => {
    for (const href of [
      undefined,
      "",
      "https://example.test/workspaces/x/artifacts/editable/" + EDITABLE,
      "mailto:a@example.test",
      `/workspaces/${WS}/artifacts`,
      `/workspaces/${WS}/artifacts/editable/not-hex`,
      `/workspaces/${WS}/artifacts/${UUID}?version=2`,
      `/workspaces/${WS}/artifacts/${UUID}#top`,
      `/workspaces/../artifacts/${UUID}`,
      "artifact:not-an-id",
      "sandbox:",
    ]) {
      expect(parseOpenGeniLink(href)).toBeNull();
    }
  });

  test("round-trips console paths", () => {
    for (const href of [
      `/workspaces/${WS}/artifacts/editable/${EDITABLE.toLowerCase()}`,
      `/workspaces/${WS}/artifacts/${UUID}`,
      `/workspaces/${WS}/artifacts/files/${UUID}`,
    ]) {
      expect(openGeniConsolePath(parseOpenGeniLink(href)!, "fallback")).toBe(href);
    }
    expect(openGeniConsolePath(parseOpenGeniLink(`artifact:${UUID}`)!, WS)).toBe(
      `/workspaces/${WS}/artifacts/files/${UUID}`,
    );
  });
});
