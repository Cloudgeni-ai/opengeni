import { describe, expect, mock, test } from "bun:test";
import type { SidebarLayoutResponse, UpdateSidebarLayoutRequest } from "@opengeni/sdk";

import { applyPersonaSidebar, personaSidebarGroup } from "./persona-sidebar";

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
  test("an engineer gets an Engineering group: one setup and two ready-made apps", () => {
    const group = personaSidebarGroup("cloud", { origin: "https://app.example", workspaceId: "w" });
    expect(group).toMatchObject({ type: "group", label: "Engineering" });
    const items = group && group.type === "group" ? (group.items ?? []) : [];
    expect(items.map((item) => (item.type === "link" ? item.url : null))).toEqual([
      "https://app.example/workspaces/w/get-started?setup=pr-reviews",
      "https://app.example/workspaces/w/enable?app=issue-tracker",
      "https://app.example/workspaces/w/enable?app=incident-log",
    ]);
    expect(
      personaSidebarGroup("everyday", { origin: "https://a", workspaceId: "w" }),
    ).toMatchObject({ label: "Your work" });
    expect(personaSidebarGroup("embed", { origin: "https://a", workspaceId: "w" })).toBeNull();
    expect(
      personaSidebarGroup("cloud", { origin: "http://localhost", workspaceId: "w" }),
    ).toBeNull();
  });

  test("writes the person's own sidebar once, never the workspace default", async () => {
    const client = fakeClient(layout({}));
    expect(await applyPersonaSidebar(client, "w", "cloud", "https://app.example")).toBe("applied");
    expect(await applyPersonaSidebar(client, "w", "cloud", "https://app.example")).toBe("skipped");
    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]).toMatchObject({ scope: "personal", expectedRevision: 0 });
    expect(client.updates.some((update) => update.scope === "workspace")).toBe(false);
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
