import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

test("the native Svelte package has no React runtime boundary", () => {
  const root = resolve(import.meta.dir, "../src");
  const queue = [root];
  const sources: string[] = [];
  while (queue.length > 0) {
    const directory = queue.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (/\.(?:ts|svelte)$/u.test(entry.name)) sources.push(readFileSync(path, "utf8"));
    }
  }
  expect(sources.join("\n")).not.toMatch(/(?:from|import\()\s*["'](?:react|@opengeni\/react)/u);
});

test("native policy and human-input surfaces preserve host authority", () => {
  const components = resolve(import.meta.dir, "../src/components");
  const mcpPolicy = readFileSync(join(components, "McpApprovalPolicySurface.svelte"), "utf8");
  const humanInput = readFileSync(join(components, "HumanInputForm.svelte"), "utf8");

  expect(mcpPolicy).toContain('<option value="selected" disabled>');
  expect(mcpPolicy).not.toContain('event.currentTarget.value === "never" ? false : []');
  expect(humanInput).toContain("{#if question.allowOther}");
});

test("native composer submission and owning examples close their lifecycle", () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const composer = readFileSync(join(packageRoot, "src/components/SessionComposer.svelte"), "utf8");
  const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
  const frameworkGuide = readFileSync(resolve(packageRoot, "../../docs/framework-ui.md"), "utf8");

  expect(composer).toContain("submitSessionComposer(controller, attachments, delivery)");
  expect(composer).not.toContain("void controller.submit(delivery");
  expect(readme).toContain("onDestroy(() => events.destroy())");
  expect(frameworkGuide).toContain("onDestroy(() => events.destroy())");
});
