import { describe, expect, test } from "bun:test";

import { parseKnowledgeSearch } from "@/lib/knowledge-route";

async function source(path: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${path}`).text();
}

describe("Knowledge surface", () => {
  test("one /state page; Memory, Documents and Agent learning links redirect into it", async () => {
    const app = await source("App.tsx");
    expect(app).toContain('path: "state"');
    expect(app).toContain('import("@/routes/workspace-state")');
    expect(app).toContain("parseKnowledgeSearch(search)");
    // Old Memory and Documents links open Knowledge instead of rendering their own page.
    expect(app).not.toContain('import("@/routes/memory")');
    expect(app).not.toContain('import("@/routes/documents")');
    expect(app).toContain('search={{ page: "learning" }}');
  });

  test("parses tabs, pages and entries, and drops what it doesn't know", () => {
    expect(parseKnowledgeSearch({ view: "review" })).toEqual({ view: "review" });
    expect(parseKnowledgeSearch({ view: "memory", page: "delete" })).toEqual({});
    expect(
      parseKnowledgeSearch({
        entry: "8f2c1b9e-0d4a-4c1e-9b7a-1f2e3d4c5b6a",
        revision: "r1",
        page: "edit",
      }),
    ).toEqual({
      entry: "8f2c1b9e-0d4a-4c1e-9b7a-1f2e3d4c5b6a",
      revision: "r1",
      page: "edit",
    });
    // A revision means nothing without its entry.
    expect(parseKnowledgeSearch({ revision: "r1" })).toEqual({});
    expect(parseKnowledgeSearch({ entry: "../../etc" })).toEqual({});
    expect(parseKnowledgeSearch({ review: true })).toEqual({ review: true });
  });

  test("the page never shows the retired words", async () => {
    const files = await Promise.all(
      [
        "knowledge-page.tsx",
        "knowledge-library.tsx",
        "knowledge-entry.tsx",
        "knowledge-instructions.tsx",
        "knowledge-review.tsx",
        "knowledge-learning.tsx",
        "knowledge-upload.tsx",
        "knowledge-labels.ts",
        "agent-learning-settings.tsx",
      ].map((name) => source(`components/knowledge/${name}`)),
    );
    for (const text of files) {
      expect(text).not.toContain("Allow updates");
      expect(text).not.toContain('"Company"');
      expect(text).not.toMatch(/>\s*Memory\s*</u);
      expect(text).not.toContain("—");
    }
  });

  test("teaches agents the three durable destinations and shared instruction limit", async () => {
    const prompt = await source("routes/agent-brain-prompt.tsx");
    expect(prompt).toContain("normally 1–3 sentences");
    expect(prompt).toContain("Use the same size limit as the manual editor");
    expect(prompt).not.toContain("600 characters");
    expect(prompt).toContain("fact, decision, incident, bug fix, or outcome");
    expect(prompt).toContain("Describe a reusable skill");
    expect(prompt).toContain("one-sentence always-visible summary");
    expect(prompt).toContain("necessary prerequisites, executable steps, verification");
    expect(prompt).toContain("Automatic activates it");
    expect(prompt).toContain("discover the lazy skill_save tool");
    expect(prompt).toContain(
      "Review first leaves it pending in Knowledge > Review while the chat continues",
    );
    expect(prompt).not.toContain("call remember with lane=preference");
    expect(prompt).toContain("instruction_policy_get");
    expect(prompt).toContain("instruction_policy_save");
    expect(prompt).toContain("Preserve every unrelated existing command exactly");
    expect(prompt).toContain("editMode=append");
    expect(prompt).toContain("Agents cannot replace the complete instruction");
    expect(prompt).toContain("Off prevents agent authoring");
    expect(prompt).toContain("Report the actual receipt");
  });
});
