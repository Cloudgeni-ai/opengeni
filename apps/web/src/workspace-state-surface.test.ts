import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${path}`).text();
}

describe("Agent Brain authority surface", () => {
  test("registers a first-class workspace route and rail destination", async () => {
    const [app, navigation] = await Promise.all([
      source("App.tsx"),
      source("components/rail/workspace-nav-data.ts"),
    ]);
    expect(app).toContain('path: "state"');
    expect(app).toContain('import("@/routes/workspace-state")');
    expect(navigation).toContain('to: "/workspaces/$workspaceId/state"');
    expect(navigation).toContain('label: "Agent Brain"');
    expect(navigation).toContain('description: "What agents always know and retrieve"');
  });

  test("makes four bounded authorities plain while preserving canonical governance APIs", async () => {
    const [route, overview, loader, preferences] = await Promise.all([
      source("routes/workspace-state.tsx"),
      source("routes/agent-brain-overview.tsx"),
      source("routes/workspace-state-loader.ts"),
      source("routes/preference-registry-admin.tsx"),
    ]);
    for (const required of [
      "Loading Agent Brain",
      "Couldn't load Agent Brain",
      "Four authorities, two ways agents use them",
      "Always known",
      "Retrieved when relevant",
      "Charter & policy",
      "Preference Registry",
      "Documents / RAG",
      "Memory",
      "Bounded descriptor metadata plus exact retrieval handle",
      "On demand; never loaded by this overview",
      "Not projected; no combined effective source is inferred",
      "No structured active heads",
      "Partial ·",
      "Unavailable · permission",
      "Empty sample",
      "Partial sample ·",
      "Searchable evidence",
      "Learned facts and decisions",
      "Pending changes",
      "History & rollback",
      "Advanced & diagnostics",
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
      expect(`${route}\n${overview}`).toContain(required);
    }
    expect(route.indexOf("<BrainOverview")).toBeLessThan(route.indexOf('id="brain-diagnostics"'));
    expect(overview).toContain("it is not another knowledge store and never merges or");
    expect(overview).toContain("the Brain never performs a cross-authority rollback");
    expect(overview).toContain("organization profile is not projected here");
    expect(overview).toContain("onOpenDiagnostics");
    expect(route).toContain("open={diagnosticsOpen}");
    expect(route.indexOf("<PreferenceRegistryAdministration")).toBeGreaterThan(
      route.indexOf('id="brain-diagnostics"'),
    );
    expect(overview).not.toMatch(/getPreferenceRegistry|preference_registry_get/);
    expect(loader).toContain("getWorkspaceState");
    expect(loader).toContain("listWorkspaceInstructionPolicyOnboardingProposals");
    expect(loader).toContain("listPreferenceRegistry");
    expect(loader).toContain("getPreferenceRegistry");
    expect(loader).toContain("listCompanyProfile");
    expect(route).toContain("CompanyProfileInventory");
    for (const required of [
      "Organization company profile",
      "Concise mandatory context shared across the organization",
      "Edit organization company profile",
      "Save and activate new revision",
      "Editing and rollback require direct organization account-admin authority",
      "Current revision",
      "Activation version",
      "History",
      "Activate",
      "Rollback",
    ]) {
      expect(route).toContain(required);
    }
    for (const operation of [
      "updateCompanyProfile",
      "activateCompanyProfileRevision",
      "rollbackCompanyProfile",
    ]) {
      expect(route).toContain(operation);
    }
    expect(route.indexOf("<CompanyProfileInventory")).toBeLessThan(
      route.indexOf('id="brain-diagnostics"'),
    );
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
    expect(`${route}\n${overview}\n${loader}\n${preferences}`).not.toMatch(
      /activateWorkspaceInstruction|updateKnowledgeMemory|createKnowledgeMemory/,
    );
    expect(route).not.toMatch(/method:\s*["'](?:POST|PATCH|PUT|DELETE)/);
    expect(route).not.toContain("policy snapshots are not implemented");
  });
});
