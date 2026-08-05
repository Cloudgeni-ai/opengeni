import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${path}`).text();
}

describe("Workspace State authority surface", () => {
  test("registers a first-class workspace route and rail destination", async () => {
    const [app, navigation] = await Promise.all([
      source("App.tsx"),
      source("components/rail/workspace-nav-data.ts"),
    ]);
    expect(app).toContain('path: "state"');
    expect(app).toContain('import("@/routes/workspace-state")');
    expect(navigation).toContain('to: "/workspaces/$workspaceId/state"');
    expect(navigation).toContain('label: "Workspace State"');
  });

  test("keeps inventory read-only while bounding admin onboarding proposals", async () => {
    const [route, loader] = await Promise.all([
      source("routes/workspace-state.tsx"),
      source("routes/workspace-state-loader.ts"),
    ]);
    for (const required of [
      "Loading workspace state",
      "Couldn't load workspace state",
      "No instruction-policy revisions exist yet.",
      "Preference authority inventory",
      "Company documents",
      "Workspace documents",
      "Personal documents",
      "No document bases are visible.",
      "No knowledge counts were disclosed.",
      "Current versus snapshot",
      "Accepted snapshot",
      "Current authority",
      "Deterministic drift compares stable IDs",
      "Base list truncated",
      "Memory sample reached",
      "Open Documents",
      "Skills & capabilities",
      "Sessions & agents",
      "Create draft proposal",
      "Proposals never activate themselves",
      "Inactive proposal",
    ]) {
      expect(route).toContain(required);
    }
    expect(loader).toContain("getWorkspaceState");
    expect(loader).toContain("listWorkspaceInstructionPolicyOnboardingProposals");
    expect(route).toContain("createWorkspaceInstructionPolicyOnboardingProposal");
    expect(`${route}\n${loader}`).not.toMatch(
      /activateWorkspaceInstruction|updateKnowledgeMemory|createKnowledgeMemory/,
    );
    expect(route).not.toMatch(/method:\s*["'](?:POST|PATCH|PUT|DELETE)/);
    expect(route).not.toContain("policy snapshots are not implemented");
  });
});
