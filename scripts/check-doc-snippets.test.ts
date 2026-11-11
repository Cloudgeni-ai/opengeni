import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  test("fails instead of passing when a missing export goes unreported", () => {
    // A root whose `@opengeni/sdk` exports everything the canary asks for: the
    // canary's expected error is absent, so the check must refuse to pass.
    const root = mkdtempSync(join(tmpdir(), "doc-snippets-root-"));
    try {
      mkdirSync(join(root, "packages"));
      writeFileSync(join(root, "sdk.ts"), "export const __docSnippetsCanary = 1;\n");
      writeFileSync(
        join(root, "tsconfig.base.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            moduleResolution: "Bundler",
            module: "ESNext",
            paths: { "@opengeni/sdk": ["./sdk.ts"] },
          },
        }),
      );
      mkdirSync(join(root, "node_modules", "@types"), { recursive: true });
      const modules = join(process.cwd(), "node_modules");
      symlinkSync(join(modules, "tsrs"), join(root, "node_modules", "tsrs"));
      symlinkSync(join(modules, "@types", "bun"), join(root, "node_modules", "@types", "bun"));
      expect(() => checkDocSnippets([], root)).toThrow(/canary/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a marked excerpt that does not parse is reported, not skipped", () => {
    const findings = check(
      "agent.mdx",
      [
        '{/* doc-snippets: excerpt CreateSessionRequest from "@opengeni/sdk" */}',
        "```ts",
        'capabilities: "none"',
        'capabilities: "all"',
        "```",
      ].join("\n"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("does not parse");
  }, 60_000);

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
        "import {",
        "  SessionConversation,",
        '} from "@opengeni/react/session-ui";',
        '<SessionConversation baseUrl="/api/opengeni" sessionId={id} />',
        "<SessionConversation sessionId={id} agentSignal={false} />",
        "```",
      ].join("\n"),
    );
    expect(findings.map(({ line, code }) => ({ line, code }))).toEqual([
      { line: 7, code: 2561 },
      { line: 17, code: 2322 },
    ]);
  }, 60_000);
});
