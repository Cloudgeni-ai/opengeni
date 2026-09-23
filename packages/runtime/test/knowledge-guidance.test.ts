import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, coreInstructions } from "../src";

test.each([undefined, "CUSTOM PERSONA", "CUSTOM {{core}} PERSONA"])(
  "behavior storage routing is present without existing governance (template=%s)",
  (instructionsTemplate) => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      instructionsTemplate,
    });
    const prompt = agent.instructions;
    expect(typeof prompt).toBe("string");
    for (const guidance of [
      "for future sessions",
      "instruction_policy_get",
      "instruction_policy_save",
      "Keep replies concise",
      "Do not save behavioral preferences as Knowledge",
      "Skill description",
      "personal Skill",
      "pending review",
      "Do not bypass",
    ]) {
      expect(prompt).toContain(guidance);
    }
    expect((prompt as string).split("Choose durable storage by purpose")).toHaveLength(2);
  },
);

test("behavior routing precedes Knowledge retention and preserves instruction edit safety", () => {
  const core = coreInstructions().join(" ");
  expect(core.indexOf("Choose durable storage by purpose")).toBeGreaterThan(-1);
  expect(core.indexOf("Choose durable storage by purpose")).toBeLessThan(
    core.indexOf("Use knowledge_search"),
  );
  expect(core).toContain("preserve unrelated rules");
  expect(core).toContain("localized exact anchored edit");
  expect(core).toContain("Agents cannot replace the complete instruction");
  expect(core).toContain("Do not promise future behavior from a Knowledge save");
});

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
  expect(skill.replace(/\s+/g, " ")).toContain("behavioral preferences");
  expect(skill).toContain("Skill description");
  expect(skill).toContain("not Knowledge");
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
  ]) {
    const text = await readFile(new URL(path, root), "utf8");
    expect(text, path).not.toMatch(/memory_(save|correct|search|propose)/);
    expect(text, path).not.toMatch(
      /memoryEnabled:\s*true|disables? Memory tools|Memory is enabled/,
    );
  }
});
