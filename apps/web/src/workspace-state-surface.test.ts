import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${path}`).text();
}

describe("read-only Workspace State surface", () => {
  test("registers a first-class workspace route and rail destination", async () => {
    const [app, navigation] = await Promise.all([
      source("App.tsx"),
      source("components/rail/workspace-nav.tsx"),
    ]);
    expect(app).toContain('path: "state"');
    expect(app).toContain('import("@/routes/workspace-state")');
    expect(navigation).toContain('to: "/workspaces/$workspaceId/state"');
    expect(navigation).toContain('label: "Workspace State"');
  });

  test("keeps the page read-only and explicit about loading, errors, bounds, and snapshot truth", async () => {
    const [route, loader] = await Promise.all([
      source("routes/workspace-state.tsx"),
      source("routes/workspace-state-loader.ts"),
    ]);
    for (const required of [
      "Loading workspace state",
      "Couldn't load workspace state",
      "No instruction-policy revisions exist yet.",
      "No document bases are visible.",
      "No knowledge counts were disclosed.",
      "Current versus snapshot",
      "policy snapshots are not implemented",
      "Base list truncated",
      "Memory sample reached",
      "Open Documents",
      "Skills & capabilities",
      "Sessions & agents",
    ]) {
      expect(route).toContain(required);
    }
    expect(loader).toContain("getWorkspaceState");
    expect(`${route}\n${loader}`).not.toMatch(
      /createWorkspaceInstruction|activateWorkspaceInstruction|updateKnowledgeMemory/,
    );
    expect(route).not.toMatch(/method:\s*["'](?:POST|PATCH|PUT|DELETE)/);
  });
});
