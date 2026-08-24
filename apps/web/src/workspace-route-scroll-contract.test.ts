import { describe, expect, test } from "bun:test";

type ScrollContract =
  | { kind: "page"; source: string; scrollSource?: string }
  | { kind: "self-managed"; source: string }
  | { kind: "redirect" };

const workspaceRouteContracts = {
  workspaceIndexRoute: { kind: "redirect" },
  workspaceAgentRoute: { kind: "redirect" },
  workspaceAgentsRoute: { kind: "page", source: "routes/agents.tsx" },
  workspaceSessionsRoute: {
    kind: "self-managed",
    source: "routes/sessions-index.tsx",
  },
  workspaceSessionRoute: { kind: "self-managed", source: "routes/session.tsx" },
  workspaceVariableSetsRoute: {
    kind: "page",
    source: "routes/variable-sets.tsx",
  },
  workspaceEnvironmentsRoute: { kind: "redirect" },
  workspaceRigsRoute: { kind: "page", source: "routes/rigs.tsx" },
  workspaceRigDetailRoute: { kind: "page", source: "routes/rig-detail.tsx" },
  workspaceMachinesRoute: { kind: "page", source: "routes/machines.tsx" },
  workspaceInsightsRoute: { kind: "page", source: "routes/insights.tsx" },
  workspacePriorityRoute: {
    kind: "self-managed",
    source: "routes/priority.tsx",
  },
  workspacePacksRoute: { kind: "redirect" },
  workspaceCapabilitiesRoute: {
    kind: "self-managed",
    source: "routes/capabilities.tsx",
  },
  workspaceLegacyCapabilitiesRoute: { kind: "redirect" },
  workspaceSchedulesRoute: { kind: "page", source: "routes/schedules.tsx" },
  workspaceDocumentsRoute: { kind: "page", source: "routes/documents.tsx" },
  workspaceMemoryRoute: { kind: "page", source: "routes/memory.tsx" },
  workspaceStateRoute: { kind: "page", source: "routes/workspace-state.tsx" },
  workspaceArtifactsRoute: { kind: "page", source: "routes/artifacts.tsx" },
  workspaceArtifactDetailRoute: {
    kind: "page",
    source: "routes/artifacts.tsx",
  },
  workspaceEditableArtifactRoute: {
    kind: "self-managed",
    source: "routes/editable-artifact.tsx",
  },
  workspaceSettingsRoute: {
    kind: "page",
    source: "routes/workspace-settings.tsx",
    scrollSource: "components/settings/workspace-settings-shell.tsx",
  },
  workspaceOrganizationRoute: {
    kind: "self-managed",
    source: "components/settings/organization-settings-shell.tsx",
  },
  workspaceAccountRoute: { kind: "redirect" },
} satisfies Record<string, ScrollContract>;

async function source(path: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${path}`).text();
}

describe("workspace route scroll ownership", () => {
  test("classifies every route mounted inside the fixed app canvas", async () => {
    const app = await source("App.tsx");
    const workspaceChildren = app.match(/workspaceRoute\.addChildren\(\[([\s\S]*?)\n  \]\),/);
    const workspaceChildrenSource = workspaceChildren?.[1];
    expect(workspaceChildrenSource).toBeDefined();
    if (!workspaceChildrenSource) throw new Error("Workspace route children were not found");

    const registeredRoutes = Array.from(
      workspaceChildrenSource.matchAll(/^\s+(workspace[A-Z]\w+Route),$/gm),
      (match) => match[1],
    ).sort();

    expect(registeredRoutes).toEqual(Object.keys(workspaceRouteContracts).sort());
  });

  test("ordinary pages use ContentPage and workbenches declare self-managed overflow", async () => {
    const sources = new Map<string, string>();
    for (const contract of Object.values(workspaceRouteContracts)) {
      if (contract.kind === "redirect" || sources.has(contract.source)) continue;
      sources.set(contract.source, await source(contract.source));
      const scrollSource =
        contract.kind === "page" && "scrollSource" in contract ? contract.scrollSource : undefined;
      if (scrollSource && !sources.has(scrollSource)) {
        sources.set(scrollSource, await source(scrollSource));
      }
    }

    for (const [route, contract] of Object.entries(workspaceRouteContracts)) {
      if (contract.kind === "redirect") continue;
      const routeSource = sources.get(contract.source)!;
      if (contract.kind === "page") {
        const explicitScrollSource = "scrollSource" in contract ? contract.scrollSource : undefined;
        const scrollSource = sources.get(explicitScrollSource ?? contract.source)!;
        expect(scrollSource, `${route} must render the canonical ContentPage scrollport`).toContain(
          "<ContentPage",
        );
      } else {
        expect(
          routeSource,
          `${route} must declare its intentional internal scroll model`,
        ).toContain('data-workspace-scroll-owner="self-managed"');
      }
    }
  });

  test("legacy max-width wrappers cannot return as route scroll owners", async () => {
    const legacyWrapper =
      'className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8"';
    for (const path of [
      "routes/schedules.tsx",
      "routes/rigs.tsx",
      "routes/rig-detail.tsx",
      "routes/machines.tsx",
    ]) {
      expect(await source(path), path).not.toContain(legacyWrapper);
    }
  });
});
