import { describe, expect, test } from "bun:test";
import {
  renderToolGroupDirectory,
  TOOL_GROUP_DIRECTORY_MAX_BYTES,
} from "../src/tool-group-directory";

describe("tool group directory", () => {
  test("uses literal browsable prefixes and deterministic examples, never schemas", () => {
    const tools = [
      { name: "slack__send", description: "Send a message" },
      { name: "browser_open", description: "Open a page" },
      { name: "slack__read", description: "Read a message" },
      { name: "codex_apps__gmail__search", description: "Search mail" },
    ];
    const text = renderToolGroupDirectory(tools, false);
    expect(text).toBe(renderToolGroupDirectory([...tools].reverse(), false));
    expect(text).toContain('"namePrefix":"slack__","example":"slack__read"');
    expect(text).toContain('"namePrefix":"browser_"');
    expect(text).toContain('"namePrefix":"codex_apps__gmail__"');
    expect(text).toContain("tool_list({namePrefix:");
    expect(text).toContain("tool_search({query: '', names:");
  });

  test("bounds multibyte catalogs and points omitted groups to exhaustive listing", () => {
    const tools = Array.from({ length: 200 }, (_, i) => ({
      name: `group${i}__read`,
      description: "🧭".repeat(200),
    }));
    const text = renderToolGroupDirectory(tools, true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TOOL_GROUP_DIRECTORY_MAX_BYTES);
    expect(text).toContain("additional groups omitted");
    expect(text).toContain("without namePrefix");
    expect(text).toContain("directory is partial");
    expect(text).toBe(renderToolGroupDirectory([...tools].reverse(), true));
  });

  test("escapes metadata, skips oversized names, and distinguishes loading from empty", () => {
    const text = renderToolGroupDirectory(
      [
        { name: "a".repeat(5000) + "__read", description: "too large" },
        { name: "z__read", description: 'Read\n"quoted" records' },
      ],
      false,
    );
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TOOL_GROUP_DIRECTORY_MAX_BYTES);
    expect(text).toContain('Read\\n\\"quoted\\" records');
    expect(text).toContain('"namePrefix":"z__"');
    expect(text).toContain("1 additional groups omitted");
    expect(renderToolGroupDirectory([], false)).toBe("");
    expect(renderToolGroupDirectory([], true)).toContain("preparation is still in progress");
  });
});
