import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${path}`).text();
}

describe("Agent Knowledge surface", () => {
  test("registers the renamed workspace destination with only focused subviews", async () => {
    const [app, navigation] = await Promise.all([
      source("App.tsx"),
      source("components/rail/workspace-nav-data.ts"),
    ]);
    expect(app).toContain('path: "state"');
    expect(app).toContain('import("@/routes/workspace-state")');
    expect(app).toContain('search.view === "instructions" || search.view === "skills"');
    expect(navigation).toContain('to: "/workspaces/$workspaceId/state"');
    expect(navigation).toContain('label: "Agent Knowledge"');
    expect(navigation).toContain('description: "Knowledge, instructions, and skills"');
  });

  test("routes organization profile and instruction and Skill autonomy to settings", async () => {
    const [organization, shell, workspaceSettings, learning, memory] = await Promise.all([
      source("routes/org-settings.tsx"),
      source("components/settings/organization-settings-shell.tsx"),
      source("routes/workspace-settings.tsx"),
      source("routes/workspace-learning-admin.tsx"),
      source("components/knowledge/knowledge-browser.tsx"),
    ]);
    expect(shell).toContain('id: "knowledge"');
    expect(shell).toContain('title: "Knowledge"');
    expect(organization).toContain('section === "knowledge"');
    expect(organization).toContain("OrganizationKnowledgePrompt");
    expect(organization).toContain("Organization identity");
    expect(organization).toContain("Open documents");
    expect(workspaceSettings).toContain("WorkspaceLearningAdministration");
    expect(workspaceSettings).not.toContain("resolveWorkspaceMemoryEnabled");
    expect(learning).toContain("Agent learning");
    expect(workspaceSettings).not.toContain("editable on Documents");
    expect(learning).toContain("AgentLearningSettingsEditor");
    expect(memory).toContain("KnowledgeOriginalFile");
    expect(memory).toContain("Workspace instructions");
    expect(memory).toContain("Skills");
  });

  test("teaches agents the three durable destinations and compact instruction budget", async () => {
    const prompt = await source("routes/agent-brain-prompt.tsx");
    expect(prompt).toContain("normally 1–3 sentences and no more than 600 characters");
    expect(prompt).toContain("fact, decision, incident, bug fix, or outcome");
    expect(prompt).toContain("Describe a reusable skill");
    expect(prompt).toContain("one-sentence always-visible summary");
    expect(prompt).toContain("necessary prerequisites, executable steps, verification");
    expect(prompt).toContain("Automatic activates it");
    expect(prompt).toContain("discover the lazy skill_save tool");
    expect(prompt).toContain(
      "Review first leaves it pending in Knowledge > Needs review while the chat continues",
    );
    expect(prompt).not.toContain("call remember with lane=preference");
    expect(prompt).toContain("instruction_policy_get");
    expect(prompt).toContain("instruction_policy_save");
    expect(prompt).toContain("Off prevents agent authoring");
    expect(prompt).toContain("Report the actual receipt");
  });
});
