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

  test("keeps inventory bounded while using canonical governance APIs", async () => {
    const [route, loader, preferences] = await Promise.all([
      source("routes/workspace-state.tsx"),
      source("routes/workspace-state-loader.ts"),
      source("routes/preference-registry-admin.tsx"),
    ]);
    for (const required of [
      "Loading workspace state",
      "Couldn't load workspace state",
      "No instruction-policy revisions exist yet.",
      "Preference authority inventory",
      "PreferenceRegistryAdministration",
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
    expect(loader).toContain("listPreferenceRegistry");
    expect(loader).toContain("getPreferenceRegistry");
    expect(route).toContain("createWorkspaceInstructionPolicyOnboardingProposal");
    for (const required of [
      "dedicated organization/workspace/personal registry",
      "not ordinary Memory",
      "Create structured preference proposal",
      "Organization",
      "Workspace",
      "Personal",
      "Full content stays on demand",
      "preference_registry_summary",
      "preference_registry_get",
      "Immutable revisions and rollback",
      "Create correction revision",
      "Retained head descriptor",
      "Supersede with replacement",
      "Refresh registry and detail",
      "correction immediately activates",
      "Immutable lifecycle audit",
      "automatic-activation seam",
    ]) {
      expect(preferences).toContain(required);
    }
    for (const operation of [
      "createPreferenceRegistryProposal",
      "activatePreferenceRegistryRevision",
      "correctPreferenceRegistry",
      "changePreferenceRegistryScope",
      "deactivatePreferenceRegistry",
      "supersedePreferenceRegistry",
      "rejectPreferenceRegistryProposal",
    ]) {
      expect(preferences).toContain(operation);
    }
    expect(`${route}\n${loader}\n${preferences}`).not.toMatch(
      /activateWorkspaceInstruction|updateKnowledgeMemory|createKnowledgeMemory/,
    );
    expect(route).not.toMatch(/method:\s*["'](?:POST|PATCH|PUT|DELETE)/);
    expect(route).not.toContain("policy snapshots are not implemented");
  });
});
