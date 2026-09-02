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
    expect(navigation).toContain('description: "Instructions, skills, documents, and memory"');
  });

  test("keeps the default page to four understandable destinations", async () => {
    const [route, overview, preferences] = await Promise.all([
      source("routes/workspace-state.tsx"),
      source("routes/agent-brain-overview.tsx"),
      source("routes/preference-registry-admin.tsx"),
    ]);
    for (const required of [
      "Agent Knowledge",
      "Loading Agent Knowledge",
      "Couldn't load Agent Knowledge",
      "Back to Agent Knowledge",
      "Workspace instructions",
      "Current instruction",
      "Loading current instruction",
      "Edit manually",
      "Skills",
      "Documents",
      "Memory",
      "How agents work",
      "What agents can find",
    ]) {
      expect(`${route}\n${overview}`).toContain(required);
    }
    for (const removed of [
      "Always followed",
      "Available when needed",
      "Needs attention",
      "Recent changes",
      "Learning & autonomy",
      "Company profile & goals",
      "Advanced & diagnostics",
      "LazyCompanyBrainInspector",
      "CompanyBrainExportButton",
    ]) {
      expect(`${route}\n${overview}`).not.toContain(removed);
    }
    expect(overview).toContain('view="instructions"');
    expect(overview).toContain('view="skills"');
    expect(route).toContain("compact");
    expect(preferences).toContain("Add skill manually");
    expect(preferences).toContain("Save skill");
    expect(preferences).toContain("Skill instructions");
    expect(preferences).toContain("SkillSummary");
    expect(route).toContain("Your Agent Knowledge");
    expect(overview).toContain("Your personal workspace");
    expect(overview).toContain("Personal workspace instructions");
    expect(preferences).toContain("Your personal Skills");
    expect(preferences).toContain("Company and workspace Skills available here");
  });

  test("routes organization profile and instruction and Skill autonomy to settings", async () => {
    const [organization, shell, workspaceSettings, learning, memory] = await Promise.all([
      source("routes/org-settings.tsx"),
      source("components/settings/organization-settings-shell.tsx"),
      source("routes/workspace-settings.tsx"),
      source("routes/workspace-learning-admin.tsx"),
      source("components/knowledge/memory-pane.tsx"),
    ]);
    expect(shell).toContain('id: "knowledge"');
    expect(shell).toContain('title: "Knowledge"');
    expect(organization).toContain('section === "knowledge"');
    expect(organization).toContain("OrganizationKnowledgePrompt");
    expect(organization).toContain("Organization identity");
    expect(organization).toContain("Open documents");
    expect(workspaceSettings).toContain("WorkspaceLearningAdministration");
    expect(workspaceSettings).toContain("resolveWorkspaceMemoryEnabled");
    expect(workspaceSettings).toContain("Let agents autonomously save and correct durable facts");
    expect(workspaceSettings).not.toContain("editable on Documents");
    expect(learning).toContain("Workspace instruction &amp; Skill autonomy");
    expect(learning).toContain("Require approval");
    expect(memory).toContain('preference: "Legacy preference"');
    expect(memory).toContain('procedural: "Legacy procedure"');
    expect(memory).toContain('episodic: "Incident or outcome"');
  });

  test("teaches agents the three durable destinations and compact instruction budget", async () => {
    const [prompt, remember, governance] = await Promise.all([
      source("routes/agent-brain-prompt.tsx"),
      source("../../api/src/mcp/remember.ts"),
      source("../../api/src/mcp/company-brain-governed-writes.ts"),
    ]);
    expect(prompt).toContain("normally 1–3 sentences and no more than 600 characters");
    expect(prompt).toContain("fact, decision, incident, bug fix, or outcome");
    expect(prompt).toContain("Describe a reusable skill");
    expect(prompt).toContain("one-sentence always-visible summary");
    expect(prompt).toContain("necessary prerequisites, executable steps, verification");
    expect(prompt).toContain("Under Autonomous it may activate immediately");
    expect(remember).toContain("use it instead for ordinary durable facts");
    expect(remember).toContain("independent of Learning mode");
    expect(remember).toContain("lane=knowledge only when memory_save is unavailable");
    expect(remember).toContain("lane=preference creates a Skill");
    expect(governance).toContain("Use this only for a minimal universal rule");
    expect(governance).toContain("Autonomous may activate an eligible proposal");
    expect(governance).toContain("workspace Skill proposal");
  });
});
