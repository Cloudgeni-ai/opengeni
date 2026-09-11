import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { coreInstructions } from "../src";

test("agent guidance teaches canonical authoring, proposal reuse, and publication boundaries", async () => {
  const core = coreInstructions().join(" ");
  for (const concept of [
    "knowledge_save",
    "knowledge_get",
    "view=needs_review",
    "unapproved",
    "current version",
    "operationId",
    "task_note_save",
    "source revision",
  ])
    expect(core).toContain(concept);
  expect(core).not.toMatch(/memory_(save|correct|search|propose)/);
  const skill = await readFile(
    new URL("../src/bundled_management_skills/opengeni-skills/SKILL.md", import.meta.url),
    "utf8",
  );
  expect(skill).toContain("knowledge_save");
  expect(skill).toContain("pending");
  expect(skill).not.toMatch(/memory_(save|correct|search|propose)/);
});

test("shipped knowledge and integration guidance never sends users to retired writers or toggles", async () => {
  const root = new URL("../../../", import.meta.url);
  for (const path of [
    "README.md",
    "AGENTS.md",
    ".agents/skills/opengeni/SKILL.md",
    ".agents/skills/opengeni-client/SKILL.md",
    "docs/knowledge.md",
    "docs/company-brain-write-routing.md",
    "docs/hierarchical-memory.md",
    "docs/workspace-learning-policy.md",
    "docs/mcp-surfaces.md",
    "docs/product-integration.md",
    "docs-site/concepts/memory-and-knowledge.mdx",
    "docs-site/guides/integrate-your-product.mdx",
    "docs-site/reference/sdk.mdx",
    "packages/core/src/domain/product-integration-skill.gen.ts",
  ]) {
    const text = await readFile(new URL(path, root), "utf8");
    expect(text, path).not.toMatch(/memory_(save|correct|search|propose)/);
    expect(text, path).not.toMatch(
      /memoryEnabled:\s*true|disables? Memory tools|Memory is enabled/,
    );
  }
});
