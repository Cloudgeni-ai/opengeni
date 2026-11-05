import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const POLICY = "api-compatibility-policy.md";

// Maintainer and integration guidance summarize one canonical policy. These
// summaries must link it and must not reintroduce the retired rule that a new
// major release permits a breaking change.
const SUMMARIES = [
  "AGENTS.md",
  ".agents/skills/opengeni/SKILL.md",
  ".agents/skills/opengeni-client/references/versions-and-upgrades.md",
  ".github/pull_request_template.md",
  "docs/architecture.md",
  "packages/sdk/README.md",
  "docs-site/integrate/production.mdx",
];

test("compatibility summaries link the canonical policy", () => {
  for (const path of SUMMARIES)
    expect({ path, links: read(path).includes(POLICY) }).toEqual({ path, links: true });
  expect(read(".agents/skills/opengeni-client/SKILL.md")).toContain(
    "references/versions-and-upgrades.md",
  );
});

test("no summary reintroduces major-version breaking changes", () => {
  const retired = [
    /within (?:a|the same) major/i,
    /breaking changes? (?:need|ships? only in) a new major/i,
    /at least 90 days/i,
  ];
  for (const path of [
    ...SUMMARIES,
    "docs-site/reference/sdk.mdx",
    "docs-site/reference/http-api.mdx",
  ]) {
    const text = read(path);
    for (const pattern of retired)
      expect({ path, pattern: String(pattern), found: pattern.test(text) }).toEqual({
        path,
        pattern: String(pattern),
        found: false,
      });
  }
});
