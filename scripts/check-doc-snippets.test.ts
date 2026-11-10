import { describe, expect, test } from "bun:test";

import { checkDocSnippets, extractDocSnippets } from "./check-doc-snippets";

const check = (file: string, text: string) =>
  checkDocSnippets(extractDocSnippets(file, text)).findings;

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
        "",
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
        'createSessionProxyHandler(og, { resolve, chats: "sharedd" });',
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
      { line: 8, code: 2820 },
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
    const stale = check("sdk.mdx", table(["resolve()", "sandboxFiles", "chats"]));
    expect(stale.map(({ line, code }) => ({ line, code }))).toEqual([{ line: 6, code: 2345 }]);
    // `complete` also requires every option to be listed.
    const partial = check("sdk.mdx", table(["resolve", "chats"], " complete"));
    expect(partial).toHaveLength(1);
    expect(partial[0]!.line).toBe(1);
    for (const name of ["afterForward", "basePath", "heartbeatMs", "toolServer"]) {
      expect(partial[0]!.message).toContain(name);
    }
  }, 60_000);

  test("fails instead of passing when nothing could be checked", () => {
    expect(() => checkDocSnippets([], "/nonexistent-root")).toThrow();
  });

  test("checks marked object excerpts and multi-element TSX samples", () => {
    const findings = check(
      "agent.mdx",
      [
        '{/* doc-snippets: excerpt CreateSessionRequest from "@opengeni/sdk" */}',
        "",
        "<CodeGroup>",
        "```ts",
        "agent: {",
        '  identity: "You help customers.",',
        '  capabilities: { from: "none", webSerch: true },',
        "},",
        "```",
        "</CodeGroup>",
        "",
        "```tsx",
        'import { SessionConversation } from "@opengeni/react/session-ui";',
        "",
        '<SessionConversation baseUrl="/api/opengeni" sessionId={id} />',
        "<SessionConversation sessionId={id} agentSignal={false} />",
        "```",
      ].join("\n"),
    );
    expect(findings.map(({ line, code }) => ({ line, code }))).toEqual([
      { line: 7, code: 2561 },
      { line: 16, code: 2322 },
    ]);
  }, 60_000);
});
