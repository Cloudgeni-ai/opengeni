import { describe, expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/artifacts.tsx`).text();

describe("Site provenance navigation", () => {
  test("links immutable Site versions back to their source sessions", () => {
    expect(source).toContain("version.sourceSessionId");
    expect(source).toContain('to="/workspaces/$workspaceId/sessions/$sessionId"');
    expect(source).toContain('version.revision === 1 ? "Creation session" : "Publishing session"');
  });
});
