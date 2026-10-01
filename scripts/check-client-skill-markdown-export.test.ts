import { describe, expect, test } from "bun:test";

import {
  checkClientSkillMarkdownExport,
  parseClientSkillSections,
} from "./check-client-skill-markdown-export";
import { renderClientSkillDocsPage } from "./sync-client-skill";

const skill = new Map([
  ["SKILL.md", "# Skill\n\n```ts\nconst text = `nested`;\n```\n"],
  ["references/guide.md", "# Guide\n\n````markdown\n```js\nmodule.exports = {};\n```\n````\n"],
  ["agents/openai.yaml", "interface:\n  display_name: OpenGeni client\n"],
]);
const mirror = renderClientSkillDocsPage(skill);
const expected = parseClientSkillSections(mirror);

async function serve(body: string, contentType = "text/markdown", status = 200) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(body, { status, headers: { "Content-Type": contentType } }),
  });
  try {
    return await checkClientSkillMarkdownExport(server.url.toString(), expected);
  } finally {
    server.stop(true);
  }
}

describe("client Skill HTTP Markdown export", () => {
  test("preserves every file and nested fences through the HTTP export", async () => {
    const exported = mirror.replace(
      /^(## `[^`]+`\n\n)(\x60{3,})(markdown|yaml|text)$/gm,
      "$1$2$3 theme={null}",
    );
    expect(await serve(exported)).toBe(skill.size);
    for (const [path, text] of skill) {
      expect(parseClientSkillSections(exported).get(path)).toBe(text.replace(/\n+$/, ""));
    }
  });

  test("detects truncated, missing, extra and changed files", async () => {
    const missing = new Map(skill);
    missing.delete("references/guide.md");
    await expect(serve(renderClientSkillDocsPage(missing))).rejects.toThrow(
      "missing=[references/guide.md]",
    );
    const changed = new Map(skill);
    changed.set("references/guide.md", "# Changed\n");
    await expect(serve(renderClientSkillDocsPage(changed))).rejects.toThrow(
      "changed=[references/guide.md]",
    );
    const extra = new Map(skill);
    extra.set("extra.md", "unexpected");
    await expect(serve(renderClientSkillDocsPage(extra))).rejects.toThrow("extra=[extra.md]");
    await expect(serve(mirror.slice(0, mirror.lastIndexOf("\n`````")))).rejects.toThrow(
      "Unclosed outer fence",
    );
  });

  test("rejects duplicate sections, unsafe paths and malformed fences", () => {
    expect(() => parseClientSkillSections(`${mirror}\n${mirror}`)).toThrow(
      "Duplicate Skill section",
    );
    expect(() => parseClientSkillSections("## `../SKILL.md`\n\n```markdown\ntext\n```\n")).toThrow(
      "Unsafe Skill section path",
    );
    expect(() => parseClientSkillSections("## `SKILL.md`\n\ntext\n")).toThrow(
      "Missing outer fence",
    );
  });

  test("rejects failed HTTP and HTML responses", async () => {
    await expect(serve("unavailable", "text/plain", 503)).rejects.toThrow("HTTP 503");
    await expect(serve("<html>sign in</html>", "text/html")).rejects.toThrow("Expected Markdown");
    await expect(serve("<html>sign in</html>", "text/plain")).rejects.toThrow(
      "no SKILL.md section",
    );
  });
});
