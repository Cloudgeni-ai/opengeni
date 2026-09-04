import { describe, expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/artifacts.tsx`).text();

describe("Site provenance navigation", () => {
  test("remounts detail state when navigating directly between Sites", () => {
    expect(source).toContain("key={`${workspaceId}:${artifactId}`}");
  });

  test("links immutable Site versions back to their source sessions", () => {
    expect(source).toContain("version.sourceSessionId");
    expect(source).toContain(
      'to="/workspaces/$workspaceId/sessions/$sessionId"',
    );
    expect(source).toContain('version.revision === 1');
    expect(source).toContain('"Creation session"');
    expect(source).toContain('"Publishing session"');
  });
});
