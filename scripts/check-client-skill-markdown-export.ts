import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const publishedUrl = "https://docs.opengeni.ai/reference/opengeni-client-skill.md";
const localMirror = fileURLToPath(
  new URL("../docs-site/reference/opengeni-client-skill.mdx", import.meta.url),
);

/** Parse the generated mirror's heading + outer-fence protocol, not arbitrary Markdown. */
export function parseClientSkillSections(markdown: string): Map<string, string> {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const sections = new Map<string, string>();
  for (let index = 0; index < lines.length; index++) {
    const heading = /^## `([^`]+)`\s*$/.exec(lines[index]!);
    if (!heading) continue;
    const path = heading[1]!;
    if (
      !/^[\w.-]+(?:\/[\w.-]+)*$/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error(`Unsafe Skill section path: ${path}`);
    }
    if (sections.has(path)) throw new Error(`Duplicate Skill section: ${path}`);
    while (lines[index + 1]?.trim() === "") index++;
    const opening = /^(`{3,})[^`]*$/.exec(lines[++index] ?? "");
    if (!opening) throw new Error(`Missing outer fence: ${path}`);
    const markerLength = opening[1]!.length;
    const start = ++index;
    while (index < lines.length) {
      const closing = /^(`{3,})\s*$/.exec(lines[index]!);
      if (closing && closing[1]!.length >= markerLength) break;
      index++;
    }
    if (index === lines.length) throw new Error(`Unclosed outer fence: ${path}`);
    // Docs exporters may normalize trailing newlines, never interior text/fences.
    sections.set(path, lines.slice(start, index).join("\n").replace(/\n+$/, ""));
  }
  if (!sections.has("SKILL.md")) throw new Error("Export has no SKILL.md section");
  return sections;
}

/** Opt-in HTTP check; unit tests use a local server and need no docs deployment. */
export async function checkClientSkillMarkdownExport(
  url: string,
  expected: Map<string, string>,
): Promise<number> {
  const response = await fetch(url, {
    headers: { Accept: "text/markdown" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Skill Markdown export returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^text\/(?:markdown|x-markdown|plain)(?:\s*;|$)/i.test(contentType)) {
    throw new Error(`Expected Markdown, received ${contentType || "no Content-Type"}`);
  }
  const actual = parseClientSkillSections(await response.text());
  const missing = [...expected.keys()].filter((path) => !actual.has(path));
  const extra = [...actual.keys()].filter((path) => !expected.has(path));
  const changed = [...expected]
    .filter(([path, text]) => actual.has(path) && actual.get(path) !== text)
    .map(([path]) => path);
  if (missing.length || extra.length || changed.length) {
    throw new Error(
      `Skill export mismatch: missing=[${missing}], extra=[${extra}], changed=[${changed}]. Check the docs deployment revision before attributing this to export corruption.`,
    );
  }
  return actual.size;
}

if (import.meta.main) {
  let url = publishedUrl;
  let expectedPath = localMirror;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    const value = args[++index];
    if (!value || (option !== "--url" && option !== "--expected")) {
      throw new Error(
        "Usage: bun scripts/check-client-skill-markdown-export.ts [--url <Markdown URL>] [--expected <matching MDX mirror>]",
      );
    }
    if (option === "--url") url = value;
    else expectedPath = value;
  }
  const expected = parseClientSkillSections(await readFile(expectedPath, "utf8"));
  const count = await checkClientSkillMarkdownExport(url, expected);
  console.log(`Skill Markdown export matches all ${count} expected files.`);
}
