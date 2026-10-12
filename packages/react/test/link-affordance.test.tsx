import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type AtRule, type Declaration } from "postcss";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "../src/components/markdown";

const styles = join(import.meta.dir, "..", "styles");

function classOf(html: string, tag: "a" | "button", text: string): string {
  const match = new RegExp(`<${tag}[^>]*class="([^"]*)"[^>]*>${text}`).exec(html);
  if (!match) throw new Error(`no <${tag}> for ${text} in ${html}`);
  return match[1]!;
}

/** Declarations that apply at rest: not nested under :hover / :focus-visible. */
function restingDeclarations(rule: AtRule): Map<string, string> {
  const resting = new Map<string, string>();
  for (const node of rule.nodes ?? []) {
    if (node.type === "decl") resting.set((node as Declaration).prop, (node as Declaration).value);
  }
  return resting;
}

describe("links are recognisable at rest", () => {
  test("chat markdown links use the shared link style for every link kind", () => {
    const html = renderToStaticMarkup(
      <Markdown artifactHref={(id) => `https://files.example/${id}`} onSandboxFile={() => {}}>
        {[
          "[release notes](https://example.com/notes)",
          "[export](artifact:33333333-3333-4333-8333-333333333333)",
          "[app.py](sandbox:/workspace/app.py:12)",
        ].join("\n\n")}
      </Markdown>,
    );
    for (const [tag, text] of [
      ["a", "release notes"],
      ["a", "export"],
      ["button", "app.py"],
    ] as const) {
      const classes = classOf(html, tag, text).split(/\s+/);
      expect(classes).toContain("og-link");
      expect(classes).not.toContain("hover:underline");
    }
  });

  test("og-link underlines at rest and strengthens the underline on hover", () => {
    const root = postcss.parse(readFileSync(join(styles, "index.css"), "utf8"));
    let utility: AtRule | undefined;
    root.walkAtRules("utility", (rule) => {
      if (rule.params === "og-link") utility = rule;
    });
    expect(utility).toBeDefined();
    const resting = restingDeclarations(utility!);
    expect(resting.get("text-decoration-line")).toBe("underline");
    expect(resting.get("color")).toBe("var(--og-color-accent-strong)");
    expect(resting.get("text-decoration-color")).toContain("currentColor");
    expect(utility!.toString()).toMatch(/&:hover\s*\{\s*text-decoration-color:\s*currentColor/);
    expect(utility!.toString()).toMatch(/&:focus-visible\s*\{[^}]*outline:/);
  });

  test("the precompiled stylesheet ships the link utility for non-Tailwind hosts", () => {
    const compiled = readFileSync(join(styles, "compiled.css"), "utf8");
    expect(compiled).toMatch(/\.og-link\s*\{[^}]*text-decoration-line:\s*underline/);
  });
});
