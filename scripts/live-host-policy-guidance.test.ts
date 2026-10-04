import { expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

test("setup guide preserves stock ownership and first-try evidence", async () => {
  const setup = await Bun.file(new URL(".agents/skills/opengeni-setup/SKILL.md", root)).text();
  const prose = setup.replaceAll(/\s+/g, " ");
  for (const phrase of [
    "1440px",
    "390px",
    "light/dark",
    "React/CSS",
    "first-try",
    "coordinator captures",
    "coding-agent handoff",
  ])
    expect(prose).toContain(phrase);
  expect(setup).toContain("not a passed UI");
  // The public page keeps only the developer-facing stock-styling promise.
  const primary = await Bun.file(new URL("docs-site/integrate/conversation-ui.mdx", root)).text();
  expect(primary).toContain("no extra cosmetic host CSS");
});

test("public error-formatter guidance preserves neutral host copy without changing diagnostics", async () => {
  const primary = await Bun.file(new URL("docs-site/integrate/conversation-ui.mdx", root)).text();
  const prose = primary.replaceAll(/\s+/g, " ");
  for (const phrase of [
    "formatErrorMessage(error, fallback?)",
    "ErrorMessageFormatter",
    "defaultMessage: string",
    "string | undefined",
    "empty string",
    "throwing callback",
    "original error",
  ])
    expect(prose).toContain(phrase);
});
