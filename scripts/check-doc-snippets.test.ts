import { describe, expect, test } from "bun:test";

import { checkDocSnippets, extractDocSnippets } from "./check-doc-snippets";

const check = (file: string, text: string) => checkDocSnippets(extractDocSnippets(file, text));

describe("doc snippet drift check", () => {
  test("extracts indented MDX fences and honors the skip marker", () => {
    const snippets = extractDocSnippets(
      "guide.mdx",
      [
        "<Steps>",
        "  ```ts route.ts",
        "  const a = 1;",
        "  ```",
        "{/* doc-snippets: skip */}",
        "```tsx",
        "<Broken",
        "```",
        "```bash",
        "echo hi",
        "```",
      ].join("\n"),
    );
    expect(snippets).toEqual([{ file: "guide.mdx", line: 3, lang: "ts", code: "const a = 1;" }]);
  });

  test("reports removed SDK options, unknown exports and wrong shapes at their source lines", () => {
    const findings = check(
      "proxy.md",
      [
        "```ts",
        'import { createSessionProxyHandler, removedExport } from "@opengeni/sdk";',
        "",
        "export const handler = createSessionProxyHandler(og, {",
        "  resolve: async () => ({ user: userId }),",
        "  sandboxFiles: true,",
        "});",
        "```",
        "",
        "Excerpts that are not statements are left alone:",
        "",
        "```ts",
        'capabilities: "none"',
        "```",
      ].join("\n"),
    );
    expect(findings.map(({ line, code }) => ({ line, code }))).toEqual([
      { line: 2, code: 2305 },
      { line: 6, code: 2353 },
    ]);
  }, 60_000);

  test("checks marked option tables against the type they document", () => {
    const table = (rows: string[], complete = "") =>
      [
        `{/* doc-snippets: keys SessionProxyHandlerOptions from "@opengeni/sdk"${complete} */}`,
        "",
        "| Option | Purpose |",
        "| ------ | ------- |",
        ...rows.map((name) => `| \`${name}\` | ... |`),
      ].join("\n");
    // A stale table (it once listed `sandboxFiles`) points at the stale row.
    const stale = check("sdk.mdx", table(["resolve", "sandboxFiles", "chats"]));
    expect(stale.map(({ line, code }) => ({ line, code }))).toEqual([{ line: 6, code: 2345 }]);
    // `complete` also requires every option to be listed.
    const partial = check("sdk.mdx", table(["resolve", "chats"], " complete"));
    expect(partial).toHaveLength(1);
    expect(partial[0]!.line).toBe(1);
    expect(partial[0]!.message).toContain("afterForward");
  }, 60_000);
});
