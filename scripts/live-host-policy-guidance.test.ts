import { expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

test("setup/public UI expectations preserve stock ownership and first-try evidence", async () => {
  const setup = await Bun.file(new URL(".agents/skills/opengeni-setup/SKILL.md", root)).text();
  const primary = await Bun.file(new URL("docs-site/integrate/conversation-ui.mdx", root)).text();
  for (const text of [setup, primary]) {
    const prose = text.replaceAll(/\s+/g, " ");
    expect(prose).toContain("1440px");
    expect(prose).toContain("390px");
    expect(prose).toContain("light/dark");
    expect(prose).toContain("React/CSS");
    expect(prose).toContain("first-try");
    expect(prose).toContain("coordinator captures");
    expect(prose).toContain("coding-agent handoff");
  }
  expect(primary).toContain("no extra cosmetic host CSS");
  expect(setup).toContain("not a passed UI");
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
    "interrupt delivery-state settlement",
    "original error",
    "retry policy",
    "older installed/published package",
  ])
    expect(prose).toContain(phrase);
});
