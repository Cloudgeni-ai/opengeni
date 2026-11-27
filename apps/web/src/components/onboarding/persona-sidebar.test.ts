import { describe, expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { SidebarLayoutResponse, UpdateSidebarLayoutRequest } from "@opengeni/sdk";
import { SIDEBAR_NAV_ENTRIES } from "@opengeni/contracts";

import { applyPersonaSidebar, PERSONA_PRESETS, personaSidebarGroup } from "./persona-sidebar";
import { guidedSetupByKey } from "../get-started/guided-setups";

function templateKeys(folder: string, suffix: string): string[] {
  const dir = new URL(`../../../../../packages/core/src/${folder}/`, import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => name.slice(0, -suffix.length));
}

function layout(personal: Partial<SidebarLayoutResponse["personal"]>): SidebarLayoutResponse {
  return {
    items: [],
    hidden: [],
    personal: { available: true, revision: 0, customized: false, ...personal },
    workspace: { revision: 3, canEdit: true },
  };
}

function fakeClient(initial: SidebarLayoutResponse) {
  let current = initial;
  const updates: UpdateSidebarLayoutRequest[] = [];
  return {
    updates,
    getSidebarLayout: mock(async () => current),
    updateSidebarLayout: mock(async (_workspaceId: string, request: UpdateSidebarLayoutRequest) => {
      updates.push(request);
      current = layout({ revision: current.personal.revision + 1, customized: true });
      return current;
    }),
  };
}

describe("persona first run", () => {
  test("an engineer gets an Engineering group: PR reviews, two agents, Work summary and Connect", () => {
    const group = personaSidebarGroup("cloud", { origin: "https://app.example", workspaceId: "w" });
    expect(group).toMatchObject({ type: "group", label: "Engineering" });
    const items = group && group.type === "group" ? (group.items ?? []) : [];
    expect(items.map((item) => (item.type === "link" ? item.url : null))).toEqual([
      "https://app.example/workspaces/w/get-started?setup=pr-reviews",
      "https://app.example/workspaces/w/agents/ready-made/bug-fixer",
      "https://app.example/workspaces/w/agents/ready-made/dependency-updater",
      "https://app.example/workspaces/w/enable?app=work-summary",
      "https://app.example/workspaces/w/plugins",
    ]);
    expect(items.at(-1)).toMatchObject({ label: "Connect GitHub, Slack and Linear" });
    const everyday = personaSidebarGroup("everyday", { origin: "https://a", workspaceId: "w" });
    expect(everyday).toMatchObject({ label: "Your work" });
    const everydayItems = everyday && everyday.type === "group" ? (everyday.items ?? []) : [];
    expect(everydayItems.map((item) => item.label)).toEqual([
      "Work summary",
      "Feedback board",
      "Connect Slack, Google Drive and more",
    ]);
    expect(everydayItems.at(-1)).toMatchObject({ label: "Connect Slack, Google Drive and more" });
    expect(personaSidebarGroup("embed", { origin: "https://a", workspaceId: "w" })).toBeNull();
    expect(
      personaSidebarGroup("cloud", { origin: "http://localhost", workspaceId: "w" }),
    ).toBeNull();
  });

  test("every suggested ready-made and setup exists", () => {
    const agents = templateKeys("agent-templates", ".agent.json");
    const apps = templateKeys("app-templates", ".app.json");
    for (const preset of Object.values(PERSONA_PRESETS)) {
      for (const agent of preset.agents) expect(agents).toContain(agent.key);
      for (const app of preset.apps) expect(apps).toContain(app.key);
      if (preset.setup) expect(guidedSetupByKey(preset.setup.key)).not.toBeNull();
    }
  });

  test("writes the person's own sidebar once, never the workspace default", async () => {
    const client = fakeClient(layout({}));
    expect(await applyPersonaSidebar(client, "w", "cloud", "https://app.example")).toBe("applied");
    expect(await applyPersonaSidebar(client, "w", "cloud", "https://app.example")).toBe("skipped");
    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]).toMatchObject({ scope: "personal", expectedRevision: 0 });
    expect(client.updates.some((update) => update.scope === "workspace")).toBe(false);
    // The engineer's rail order: Agents, Inbox and Apps up front.
    expect(client.updates[0]?.changes).toContainEqual({
      op: "options",
      navOrder: ["new_session", "agents", "inbox", "apps", "setup"],
      navSetup: ["automations", "knowledge", "artifacts", "meetings"],
    });
  });

  test("each preset's rail order names only entries the rail can order", () => {
    const known = new Set<string>([...SIDEBAR_NAV_ENTRIES, "new_session", "setup"]);
    for (const preset of Object.values(PERSONA_PRESETS)) {
      for (const key of [...preset.rail.top, ...preset.rail.setup]) expect(known).toContain(key);
      expect(preset.rail.top).toContain("setup");
    }
  });

  test("leaves a sidebar the person already changed, or one they can't have", async () => {
    const changed = fakeClient(layout({ customized: true, revision: 4 }));
    expect(await applyPersonaSidebar(changed, "w", "everyday", "https://a")).toBe("skipped");
    const service = fakeClient(layout({ available: false }));
    expect(await applyPersonaSidebar(service, "w", "everyday", "https://a")).toBe("skipped");
    expect(changed.updates).toHaveLength(0);
    expect(service.updates).toHaveLength(0);
  });
});
