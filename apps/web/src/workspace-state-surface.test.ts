import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${path}`).text();
}

describe("Company Brain authority surface", () => {
  test("registers a first-class workspace route and rail destination", async () => {
    const [app, navigation] = await Promise.all([
      source("App.tsx"),
      source("components/rail/workspace-nav-data.ts"),
    ]);
    expect(app).toContain('path: "state"');
    expect(app).toContain('import("@/routes/workspace-state")');
    expect(navigation).toContain('to: "/workspaces/$workspaceId/state"');
    expect(navigation).toContain('label: "Company Brain"');
    expect(navigation).toContain('description: "Knowledge, rules, guides, review, and learning"');
  });

  test("keeps the default Company Brain simple while preserving canonical governance APIs", async () => {
    const [route, overview, prompt, loader, preferences, exportControl] = await Promise.all([
      source("routes/workspace-state.tsx"),
      source("routes/agent-brain-overview.tsx"),
      source("routes/agent-brain-prompt.tsx"),
      source("routes/workspace-state-loader.ts"),
      source("routes/preference-registry-admin.tsx"),
      source("routes/company-brain-export.tsx"),
    ]);
    for (const required of [
      "Loading Company Brain",
      "Couldn't load Company Brain",
      "Knowledge, rules, guides, review, and learning",
      "Always followed",
      "Company profile & goals",
      "Not configured",
      "Workspace instructions",
      "Not set",
      "Guides & preferences",
      "Short summaries are always known; full instructions are fetched when needed.",
      "Back to Company Brain",
      "Instructions for this workspace",
      "Save instructions",
      "Changes are versioned and can be audited or rolled back.",
      "Available when needed",
      "Needs attention",
      "Recent changes",
      "Export OKF",
      "Documents",
      "Memory",
      "Facts, decisions and observations learned across agent work.",
      "Advanced & diagnostics",
      "Technical details, audit history and administration.",
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
      "Create draft proposal",
      "Proposals never activate themselves",
      "Inactive proposal",
    ]) {
      expect(`${route}\n${overview}\n${exportControl}`).toContain(required);
    }
    expect(route.indexOf("<BrainOverview")).toBeLessThan(route.indexOf('id="brain-diagnostics"'));
    expect(overview).toContain("search={{ view }}");
    expect(overview).toContain('view="company"');
    expect(overview).toContain('view="instructions"');
    expect(overview).toContain('view="preferences"');
    expect(route).toContain("compact");
    expect(preferences).toContain("Write manually");
    expect(preferences).toContain("Save preference");
    expect(preferences).toContain("Always visible summary");
    expect(prompt).toContain("Tell OpenGeni what you want it to remember");
    expect(prompt).toContain("Tell OpenGeni how agents should work");
    expect(prompt).toContain("Tell OpenGeni about your company and goals");
    expect(prompt).toContain("show you the result before saving it");
    expect(prompt).toContain("context.startSession");
    expect(prompt).toContain("canonical durable-learning");
    expect(prompt).toContain("Never save the preference as ordinary Memory");
    expect(overview).not.toContain("workspace_instruction_policy_heads");
    expect(overview).not.toContain("Runtime composition");
    expect(overview).not.toContain("Four authorities, two ways agents use them");
    expect(route).not.toContain("Authoritative source surfaces");
    expect(route).not.toContain("Generated {formatDate(state.generatedAt)}");
    expect(route).toContain("open={diagnosticsOpen}");
    expect(route.lastIndexOf("<PreferenceRegistryAdministration")).toBeGreaterThan(
      route.indexOf('id="brain-diagnostics"'),
    );
    expect(overview).not.toMatch(/getPreferenceRegistry|preference_registry_get/);
    expect(loader).toContain("getWorkspaceState");
    expect(loader).toContain("listWorkspaceInstructionPolicyOnboardingProposals");
    expect(loader).toContain("listPreferenceRegistry");
    expect(loader).toContain("getPreferenceRegistry");
    expect(loader).toContain("listCompanyProfile");
    expect(route).toContain("CompanyProfileInventory");
    expect(route).toContain("inventory.response?.activeRevision");
    expect(route).not.toContain("inventory.response.revisions.find");
    for (const required of [
      "Organization company profile",
      "Concise mandatory context shared across the organization",
      "Edit organization company profile",
      "Save and activate new revision",
      "Pending proposals",
      "Only an organization owner or admin can activate this proposal.",
      "Editing, activation, and rollback require a direct organization owner or admin",
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
    expect(route).toContain("onReviewSummary={updatePreferenceReview}");
    expect(route).toContain("onReviewSummary={updateOnboardingReview}");
    expect(overview).toContain("deriveBrainAttention");
    expect(overview).toContain("Proposal review is still loading");
    expect(overview).toContain("Some learned memories await review");
    expect(overview).not.toContain("No review needed");
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
    expect(route).toContain("createWorkspaceInstructionPolicyDraft");
    expect(route).toContain("activateWorkspaceInstructionPolicyRevision");
    expect(`${route}\n${overview}\n${loader}\n${preferences}`).not.toMatch(
      /updateKnowledgeMemory|createKnowledgeMemory/,
    );
    expect(route).not.toMatch(/method:\s*["'](?:POST|PATCH|PUT|DELETE)/);
    expect(route).not.toContain("policy snapshots are not implemented");
  });
});
