import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_SIDEBAR_LAYOUT,
  EMPTY_SIDEBAR_LAYOUT,
  EMPTY_SIDEBAR_PERSONAL_CHANGES,
  SidebarLayoutChangeError,
  UpdateSidebarLayoutRequest,
  applyPersonalSidebarChanges,
  applyWorkspaceSidebarChanges,
  flattenSidebarItemsForMobile,
  isSidebarAppPath,
  isSidebarExternalUrl,
  mergeSidebarLayout,
  readResolvedSidebarItems,
  readStoredSidebarLayout,
  readStoredSidebarPersonalChanges,
  readWorkspaceSidebarLayout,
  sidebarItemsShown,
  sidebarLayoutIsOlder,
  sidebarLinkedAgentIds,
  sidebarLinkedAppIds,
  sidebarPersonalChangesCustomized,
  withoutGoneSidebarAgents,
  withoutGoneSidebarApps,
  knownSidebarItem,
  knownSidebarOptions,
  mergeSidebarOptions,
  readResolvedSidebarOptions,
  readStoredSidebarOptions,
  DEFAULT_SIDEBAR_LAYOUT_OPTIONS,
  ResolvedSidebarItem,
  SidebarLayoutResponse,
  SidebarLayoutOptions,
  type SidebarLayoutChange,
  type MergedSidebarGroup,
  type StoredSidebarPersonalChanges,
} from "../src/sidebar-layout";

const APP_A = "11111111-1111-4111-8111-111111111111";
const APP_B = "22222222-2222-4222-8222-222222222222";
const APP_C = "33333333-3333-4333-8333-333333333333";

function ids() {
  let next = 0;
  return () => `n${(next += 1)}`;
}

function parseChanges(changes: unknown[]): SidebarLayoutChange[] {
  return UpdateSidebarLayoutRequest.parse({ scope: "workspace", changes }).changes;
}

/** The acceptance layout: an Engineering group with three app links (one to a page) and a link. */
function engineering() {
  return applyWorkspaceSidebarChanges(
    EMPTY_SIDEBAR_LAYOUT,
    parseChanges([
      {
        op: "add",
        item: {
          id: "engineering",
          type: "group",
          label: "Engineering",
          items: [
            { id: "releases", type: "app", appId: APP_A, path: "/releases", label: "Releases" },
            { id: "reviews", type: "app", appId: APP_B },
            { id: "incidents", type: "app", appId: APP_C },
            { id: "status", type: "link", url: "https://status.example.com", label: "Status" },
          ],
        },
      },
    ]),
    ids(),
  );
}

describe("sidebar layout", () => {
  test("validates paths and outside links", () => {
    expect(isSidebarAppPath("/releases?tab=2#top")).toBe(true);
    expect(isSidebarAppPath("//evil.example")).toBe(false);
    expect(isSidebarAppPath("releases")).toBe(false);
    expect(isSidebarAppPath("/a b")).toBe(false);
    expect(isSidebarExternalUrl("https://example.com/x")).toBe(true);
    expect(isSidebarExternalUrl("http://example.com")).toBe(false);
    expect(isSidebarExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSidebarExternalUrl("https://user:pw@example.com")).toBe(false);
    expect(() =>
      parseChanges([{ op: "add", item: { type: "link", url: "http://x.y", label: "X" } }]),
    ).toThrow();
  });

  test("an admin's default and a member's own changes stay separate", () => {
    const workspace = engineering();
    expect(workspace.items).toHaveLength(1);
    const member = applyPersonalSidebarChanges(
      workspace,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([
        { op: "remove", itemId: "incidents" },
        { op: "add", item: { type: "link", url: "https://docs.example.com", label: "Docs" } },
      ]),
      ids(),
    );
    expect(member.hidden).toEqual(["incidents"]);
    expect(member.added).toHaveLength(1);
    const seen = mergeSidebarLayout(workspace, member);
    expect(seen.items.map((item) => item.id)).toEqual(["engineering", "my-link-n1"]);
    expect((seen.items[0] as MergedSidebarGroup).items.map((item) => item.id)).toEqual([
      "releases",
      "reviews",
      "status",
    ]);
    expect(seen.hidden.map((entry) => [entry.parentId, entry.item.id])).toEqual([
      ["engineering", "incidents"],
    ]);
    // Everyone else still sees the default.
    const other = mergeSidebarLayout(workspace, EMPTY_SIDEBAR_PERSONAL_CHANGES);
    expect((other.items[0] as MergedSidebarGroup).items).toHaveLength(4);
    expect(sidebarPersonalChangesCustomized(member)).toBe(true);
    const reset = applyPersonalSidebarChanges(
      workspace,
      member,
      parseChanges([{ op: "reset" }]),
      ids(),
    );
    expect(sidebarPersonalChangesCustomized(reset)).toBe(false);
  });

  test("people reorder their view, add into workspace groups and show hidden items", () => {
    const workspace = engineering();
    let member = applyPersonalSidebarChanges(
      workspace,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([
        { op: "move", itemId: "status", index: 0 },
        {
          op: "add",
          groupId: "engineering",
          index: 1,
          item: { id: "mine", type: "app", appId: APP_C },
        },
        { op: "remove", itemId: "reviews" },
      ]),
      ids(),
    );
    let seen = mergeSidebarLayout(workspace, member);
    expect((seen.items[0] as MergedSidebarGroup).items.map((item) => item.id)).toEqual([
      "status",
      "my-mine",
      "releases",
      "incidents",
    ]);
    member = applyPersonalSidebarChanges(
      workspace,
      member,
      parseChanges([{ op: "show", itemId: "reviews" }]),
      ids(),
    );
    seen = mergeSidebarLayout(workspace, member);
    expect((seen.items[0] as MergedSidebarGroup).items.map((item) => item.id)).toContain("reviews");
    expect(() =>
      applyPersonalSidebarChanges(
        workspace,
        member,
        parseChanges([{ op: "update", itemId: "releases", label: "R" }]),
        ids(),
      ),
    ).toThrow(SidebarLayoutChangeError);
    expect(() =>
      applyPersonalSidebarChanges(
        workspace,
        member,
        parseChanges([{ op: "move", itemId: "releases", groupId: null, index: 0 }]),
        ids(),
      ),
    ).toThrow(SidebarLayoutChangeError);
  });

  test("an app added on its own moves into a person's group, which stays editable", () => {
    const workspace = engineering();
    const apply = (member: StoredSidebarPersonalChanges, changes: unknown[]) =>
      applyPersonalSidebarChanges(workspace, member, parseChanges(changes), ids());
    let member = apply(EMPTY_SIDEBAR_PERSONAL_CHANGES, [
      { op: "add", item: { id: "favorites", type: "group", label: "Favorites", items: [] } },
      { op: "add", item: { id: "tracker", type: "app", appId: APP_C } },
    ]);
    member = apply(member, [{ op: "move", itemId: "my-tracker", groupId: "my-favorites" }]);
    const groupOf = (id: string) =>
      mergeSidebarLayout(workspace, member).items.find(
        (item) => item.type === "group" && item.items.some((child) => child.id === id),
      )?.id ?? null;
    expect(groupOf("my-tracker")).toBe("my-favorites");
    // Stored inside the group, as Add puts it.
    expect(member.added.map((entry) => entry.item.id)).toEqual(["my-favorites"]);
    member = apply(member, [
      { op: "update", itemId: "my-favorites", label: "Daily", icon: "star" },
      { op: "update", itemId: "my-tracker", label: "Tracker" },
    ]);
    const group = mergeSidebarLayout(workspace, member).items.find(
      (item) => item.id === "my-favorites",
    ) as MergedSidebarGroup;
    expect(group.label).toBe("Daily");
    expect(group.items.map((child) => child.label)).toEqual(["Tracker"]);
    // Into a workspace group and back out to the top level.
    member = apply(member, [{ op: "move", itemId: "my-tracker", groupId: "engineering" }]);
    expect(groupOf("my-tracker")).toBe("engineering");
    member = apply(member, [{ op: "move", itemId: "my-tracker", groupId: null }]);
    expect(groupOf("my-tracker")).toBeNull();
    member = apply(member, [{ op: "move", itemId: "my-tracker", groupId: "my-favorites" }]);
    member = apply(member, [{ op: "remove", itemId: "my-favorites" }]);
    expect(mergeSidebarLayout(workspace, member).items.map((item) => item.id)).toEqual([
      "engineering",
    ]);
    expect(() => apply(member, [{ op: "move", itemId: "releases", groupId: null }])).toThrow(
      SidebarLayoutChangeError,
    );
    // An item an older version stored beside its group goes with the group too.
    const older: StoredSidebarPersonalChanges = {
      ...EMPTY_SIDEBAR_PERSONAL_CHANGES,
      added: [
        { parentId: null, item: { id: "my-g", type: "group", label: "G", items: [] } },
        { parentId: "my-g", item: { id: "my-a", type: "app", appId: APP_C } },
      ],
    };
    const removed = apply(older, [{ op: "remove", itemId: "my-g" }]);
    expect(mergeSidebarLayout(workspace, removed).items.map((item) => item.id)).toEqual([
      "engineering",
    ]);
  });

  test("a deleted workspace group keeps a person's items visible", () => {
    let workspace = engineering();
    const member = applyPersonalSidebarChanges(
      workspace,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([
        { op: "add", groupId: "engineering", item: { id: "mine", type: "app", appId: APP_C } },
      ]),
      ids(),
    );
    workspace = applyWorkspaceSidebarChanges(
      workspace,
      parseChanges([{ op: "remove", itemId: "engineering" }]),
      ids(),
    );
    expect(mergeSidebarLayout(workspace, member).items.map((item) => item.id)).toEqual(["my-mine"]);
  });

  test("unknown item types are ignored by readers and kept by writers", () => {
    const stored = readStoredSidebarLayout({
      version: 2,
      items: [
        { id: "future", type: "kanban_board", board: "x" },
        {
          id: "g",
          type: "group",
          label: "G",
          items: [
            { id: "f2", type: "chart" },
            { id: "l", type: "link", url: "https://a.example", label: "A" },
          ],
        },
        { type: "app" },
        "junk",
      ],
    });
    expect(stored.items.map((item) => item.id)).toEqual(["future", "g"]);
    const merged = mergeSidebarLayout(stored, EMPTY_SIDEBAR_PERSONAL_CHANGES);
    expect(merged.items.map((item) => item.id)).toEqual(["g"]);
    expect((merged.items[0] as MergedSidebarGroup).items.map((item) => item.id)).toEqual(["l"]);
    const updated = applyWorkspaceSidebarChanges(
      stored,
      parseChanges([{ op: "add", item: { id: "x", type: "live_list", list: "recent_apps" } }]),
      ids(),
    );
    expect(updated.items.map((item) => item.id)).toEqual(["future", "g", "x"]);
    expect((updated.items[1]!.items as { id: string }[]).map((item) => item.id)).toEqual([
      "f2",
      "l",
    ]);
    expect(
      readResolvedSidebarItems([{ id: "z", type: "kanban_board", origin: "workspace" }, "x"]),
    ).toEqual([]);
    expect(
      readStoredSidebarPersonalChanges({
        hidden: ["a", 1, "a"],
        added: [{ item: { id: "b", type: "chart" } }],
      }),
    ).toEqual({
      version: 1,
      hidden: ["a"],
      added: [{ parentId: null, item: { id: "b", type: "chart" } }],
      order: {},
    });
  });

  test("duplicate ids and nested groups are refused", () => {
    const workspace = engineering();
    expect(() =>
      applyWorkspaceSidebarChanges(
        workspace,
        parseChanges([{ op: "add", item: { id: "releases", type: "app", appId: APP_A } }]),
        ids(),
      ),
    ).toThrow(SidebarLayoutChangeError);
    expect(() =>
      applyWorkspaceSidebarChanges(
        workspace,
        parseChanges([
          { op: "add", groupId: "engineering", item: { type: "group", label: "Inner" } },
        ]),
        ids(),
      ),
    ).toThrow(SidebarLayoutChangeError);
  });

  test("phones flatten groups and cap live lists", () => {
    const flat = flattenSidebarItemsForMobile([
      {
        id: "g",
        type: "group",
        label: "G",
        collapsed: false,
        origin: "workspace",
        items: [
          { id: "a", type: "app", appId: APP_A, path: null, label: "A", origin: "workspace" },
          {
            id: "r",
            type: "live_list",
            list: "recent_apps",
            label: "Recent apps",
            limit: 10,
            origin: "workspace",
            apps: [APP_A, APP_B, APP_C, APP_A].map((appId, index) => ({
              appId,
              title: `${index}`,
            })),
          },
        ],
      },
    ]);
    expect(flat.map((item) => item.id)).toEqual(["a", "r"]);
    expect(flat[1]!.type === "live_list" && flat[1]!.apps).toHaveLength(3);
  });
  test("moves name a neighbour, so items a reader can't see don't shift them", () => {
    // `reviews` is an App this reader can't open: their view is releases, incidents, status.
    const workspace = engineering();
    const moved = applyWorkspaceSidebarChanges(
      workspace,
      parseChanges([{ op: "move", itemId: "incidents", beforeId: "releases" }]),
      ids(),
    );
    const group = moved.items[0]!.items as { id: string }[];
    expect(group.map((item) => item.id)).toEqual(["incidents", "releases", "reviews", "status"]);
    const down = applyWorkspaceSidebarChanges(
      workspace,
      parseChanges([{ op: "move", itemId: "releases", afterId: "incidents" }]),
      ids(),
    );
    expect((down.items[0]!.items as { id: string }[]).map((item) => item.id)).toEqual([
      "reviews",
      "incidents",
      "releases",
      "status",
    ]);
    const member = applyPersonalSidebarChanges(
      workspace,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([{ op: "move", itemId: "status", beforeId: "incidents" }]),
      ids(),
    );
    const seen = mergeSidebarLayout(workspace, member).items[0] as MergedSidebarGroup;
    expect(seen.items.map((item) => item.id)).toEqual([
      "releases",
      "reviews",
      "status",
      "incidents",
    ]);
    expect(() =>
      applyWorkspaceSidebarChanges(
        workspace,
        parseChanges([{ op: "move", itemId: "releases", beforeId: "nowhere" }]),
        ids(),
      ),
    ).toThrow(SidebarLayoutChangeError);
  });

  test("a person's own ids can't collide with items an admin adds later", () => {
    const workspace = engineering();
    const member = applyPersonalSidebarChanges(
      workspace,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([
        { op: "add", item: { id: "docs", type: "link", url: "https://d.example.com", label: "D" } },
      ]),
      ids(),
    );
    expect(member.added[0]!.item.id).toBe("my-docs");
    const later = applyWorkspaceSidebarChanges(
      workspace,
      parseChanges([
        { op: "add", item: { id: "docs", type: "link", url: "https://e.example.com", label: "E" } },
      ]),
      ids(),
    );
    expect(mergeSidebarLayout(later, member).items.map((item) => item.id)).toEqual([
      "engineering",
      "docs",
      "my-docs",
    ]);
    expect(() =>
      applyWorkspaceSidebarChanges(
        workspace,
        parseChanges([
          {
            op: "add",
            item: { id: "my-x", type: "link", url: "https://x.example.com", label: "X" },
          },
        ]),
        ids(),
      ),
    ).toThrow(SidebarLayoutChangeError);
  });

  test("a person's items count toward a workspace group's limit", () => {
    const children = Array.from({ length: 50 }, (_, index) => ({
      id: `l${index}`,
      type: "link",
      url: "https://x.example.com",
      label: `L${index}`,
    }));
    const workspace = applyWorkspaceSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      parseChanges([{ op: "add", item: { id: "g", type: "group", label: "G", items: children } }]),
      ids(),
    );
    expect(() =>
      applyPersonalSidebarChanges(
        workspace,
        EMPTY_SIDEBAR_PERSONAL_CHANGES,
        parseChanges([
          {
            op: "add",
            groupId: "g",
            item: { type: "link", url: "https://y.example.com", label: "Y" },
          },
        ]),
        ids(),
      ),
    ).toThrow(SidebarLayoutChangeError);
  });

  test("fields from a newer version don't hide an item from older readers", () => {
    expect(knownSidebarItem({ id: "a", type: "app", appId: APP_A, accent: "red" })).toEqual({
      id: "a",
      type: "app",
      appId: APP_A,
    });
    const group = knownSidebarItem({
      id: "g",
      type: "group",
      label: "G",
      color: "blue",
      items: [{ id: "s", type: "link", url: "https://s.example.com", label: "S", badge: 2 }],
    });
    expect(group).toEqual({
      id: "g",
      type: "group",
      label: "G",
      items: [{ id: "s", type: "link", url: "https://s.example.com", label: "S" }],
    });
  });

  test("links to gone apps can be dropped", () => {
    const items = engineering().items;
    expect(sidebarLinkedAppIds(items).sort()).toEqual([APP_A, APP_B, APP_C].sort());
    const kept = withoutGoneSidebarApps(items, new Set([APP_A]));
    expect((kept[0]!.items as { id: string }[]).map((item) => item.id)).toEqual([
      "releases",
      "status",
    ]);
  });
});

describe("built-in default", () => {
  test("a workspace without a saved default gets the Pinned apps list; a saved one stays", () => {
    expect(readWorkspaceSidebarLayout(null)).toEqual(BUILT_IN_SIDEBAR_LAYOUT);
    expect(readWorkspaceSidebarLayout(undefined).items).toEqual([
      { id: "pinned-apps", type: "live_list", list: "pinned_apps" },
    ]);
    // A saved empty default is the admin's choice, not replaced.
    expect(readWorkspaceSidebarLayout({ layout: { version: 1, items: [] } }).items).toEqual([]);
    // Changing it never mutates the shared constant.
    const changed = applyWorkspaceSidebarChanges(
      readWorkspaceSidebarLayout(null),
      parseChanges([{ op: "remove", itemId: "pinned-apps" }]),
      ids(),
    );
    expect(changed.items).toEqual([]);
    expect(BUILT_IN_SIDEBAR_LAYOUT.items).toHaveLength(1);
  });

  test("the sidebar leaves out live lists with no apps", () => {
    const list = (apps: { appId: string; title: string }[]) => ({
      id: "pinned-apps",
      origin: "workspace" as const,
      type: "live_list" as const,
      list: "pinned_apps" as const,
      label: "Pinned apps",
      limit: 5,
      apps,
    });
    const link = {
      id: "s",
      origin: "workspace" as const,
      type: "link" as const,
      url: "https://status.example.com",
      label: "Status",
    };
    expect(sidebarItemsShown([list([])])).toEqual([]);
    expect(sidebarItemsShown([list([{ appId: APP_A, title: "A" }])])).toHaveLength(1);
    expect(
      sidebarItemsShown([
        {
          id: "g",
          origin: "workspace",
          type: "group",
          label: "G",
          collapsed: false,
          items: [list([]), link],
        },
      ]),
    ).toEqual([
      { id: "g", origin: "workspace", type: "group", label: "G", collapsed: false, items: [link] },
    ]);
    const group = (items: ReturnType<typeof list>[]) => ({
      id: "g",
      origin: "workspace" as const,
      type: "group" as const,
      label: "G",
      collapsed: false,
      items,
    });
    // A group with only empty lists goes; an empty group stays, to fill.
    expect(sidebarItemsShown([group([list([])])])).toEqual([]);
    expect(sidebarItemsShown([group([])])).toHaveLength(1);
  });
});

describe("placement and answer order", () => {
  const link = (id: string) => ({ id, type: "link", url: `https://${id}.example.com`, label: id });
  const start = { version: 1, items: [link("a"), link("b"), link("c")] };
  const place = (position: Record<string, unknown>) =>
    applyWorkspaceSidebarChanges(
      start,
      parseChanges([{ op: "add", item: link("x"), ...position }]),
      ids(),
    ).items.map((item) => item.id);

  test("beforeId wins over afterId, which wins over index; the end when none is given", () => {
    expect(place({ beforeId: "b", afterId: "c", index: 0 })).toEqual(["a", "x", "b", "c"]);
    expect(place({ afterId: "a", index: 3 })).toEqual(["a", "x", "b", "c"]);
    expect(place({ index: 0 })).toEqual(["x", "a", "b", "c"]);
    expect(place({ index: 99 })).toEqual(["a", "b", "c", "x"]);
    expect(place({})).toEqual(["a", "b", "c", "x"]);
    expect(() => place({ beforeId: "nope" })).toThrow(SidebarLayoutChangeError);
  });

  test("an older answer never replaces a newer one", () => {
    const at = (personal: number, workspace: number) => ({
      personal: { revision: personal },
      workspace: { revision: workspace },
    });
    expect(sidebarLayoutIsOlder(at(1, 1), null)).toBe(false);
    expect(sidebarLayoutIsOlder(at(1, 1), at(1, 1))).toBe(false);
    expect(sidebarLayoutIsOlder(at(2, 1), at(1, 1))).toBe(false);
    expect(sidebarLayoutIsOlder(at(1, 1), at(2, 1))).toBe(true);
    expect(sidebarLayoutIsOlder(at(3, 1), at(2, 2))).toBe(true);
  });
});

describe("agent links", () => {
  const AGENT = "44444444-4444-4444-8444-444444444444";
  const OTHER = "55555555-5555-4555-8555-555555555555";

  test("an agent link is added, merged and renamed like any link", () => {
    const added = applyWorkspaceSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      parseChanges([
        { op: "add", item: { type: "agent", agentId: AGENT } },
        { op: "add", item: { id: "g", type: "group", label: "Team" } },
        { op: "add", groupId: "g", item: { id: "helper", type: "agent", agentId: OTHER } },
      ]),
      ids(),
    );
    expect(added.items[0]).toEqual({ id: "agent-n1", type: "agent", agentId: AGENT });
    const merged = mergeSidebarLayout(added, EMPTY_SIDEBAR_PERSONAL_CHANGES).items;
    expect((merged[1] as MergedSidebarGroup).items).toEqual([
      { id: "helper", type: "agent", agentId: OTHER, origin: "workspace" },
    ]);
    const renamed = applyWorkspaceSidebarChanges(
      added,
      parseChanges([{ op: "update", itemId: "helper", label: "Helper" }]),
      ids(),
    );
    expect((renamed.items[1]!.items as { label?: string }[])[0]!.label).toBe("Helper");
    // Its own name again.
    const unnamed = applyWorkspaceSidebarChanges(
      renamed,
      parseChanges([{ op: "update", itemId: "helper", label: null }]),
      ids(),
    );
    expect((unnamed.items[1]!.items as { label?: string }[])[0]!.label).toBeUndefined();
    expect(() =>
      applyWorkspaceSidebarChanges(
        added,
        parseChanges([{ op: "update", itemId: "helper", path: "/x" }]),
        ids(),
      ),
    ).toThrow(SidebarLayoutChangeError);
    // A person's own agent link, in the default's group.
    const personal = applyPersonalSidebarChanges(
      added,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([{ op: "add", groupId: "g", item: { type: "agent", agentId: AGENT } }]),
      ids(),
    );
    const mine = mergeSidebarLayout(added, personal).items[1] as MergedSidebarGroup;
    expect(mine.items.map((item) => [item.id, item.origin])).toEqual([
      ["helper", "workspace"],
      ["my-agent-n1", "personal"],
    ]);
  });

  test("an agent link needs an agent id", () => {
    expect(() => parseChanges([{ op: "add", item: { type: "agent" } }])).toThrow();
    expect(() =>
      parseChanges([{ op: "add", item: { type: "agent", agentId: "not-an-id" } }]),
    ).toThrow();
    expect(() =>
      parseChanges([{ op: "add", item: { type: "agent", agentId: AGENT, path: "/x" } }]),
    ).toThrow();
  });

  test("renaming a group keeps its items", () => {
    const layout = engineering();
    const renamed = applyWorkspaceSidebarChanges(
      layout,
      parseChanges([{ op: "update", itemId: "engineering", label: "Build" }]),
      ids(),
    );
    expect(renamed.items[0]!.label).toBe("Build");
    expect(renamed.items[0]!.items).toEqual(layout.items[0]!.items);
    // A person renames their own group, not the default's.
    const personal = applyPersonalSidebarChanges(
      layout,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([
        { op: "add", item: { id: "mine", type: "group", label: "Mine" } },
        { op: "update", itemId: "my-mine", label: "Ours" },
      ]),
      ids(),
    );
    expect(personal.added[0]!.item.label).toBe("Ours");
    expect(() =>
      applyPersonalSidebarChanges(
        layout,
        EMPTY_SIDEBAR_PERSONAL_CHANGES,
        parseChanges([{ op: "update", itemId: "engineering", label: "Build" }]),
        ids(),
      ),
    ).toThrow(SidebarLayoutChangeError);
  });

  test("links to gone agents can be dropped", () => {
    const items = [
      { id: "a", type: "agent", agentId: AGENT },
      { id: "g", type: "group", label: "G", items: [{ id: "b", type: "agent", agentId: OTHER }] },
      { id: "app", type: "app", appId: APP_A },
    ];
    expect(sidebarLinkedAgentIds(items).sort()).toEqual([AGENT, OTHER]);
    expect(sidebarLinkedAppIds(items)).toEqual([APP_A]);
    const kept = withoutGoneSidebarAgents(items, new Set([OTHER]));
    expect(kept.map((item) => item.id)).toEqual(["g", "app"]);
    expect((kept[0]!.items as { id: string }[]).map((item) => item.id)).toEqual(["b"]);
  });

  test("readers keep resolved agent links, with the agent's name and avatar", () => {
    const agent = {
      id: "a",
      origin: "workspace",
      type: "agent",
      agentId: AGENT,
      label: "Helper",
      avatar: { kind: "letters", letters: "H", hue: 120 },
    };
    expect(ResolvedSidebarItem.safeParse(agent).success).toBe(true);
    const read = readResolvedSidebarItems([
      agent,
      { ...agent, id: "broken", avatar: undefined },
      { id: "g", origin: "personal", type: "group", label: "G", collapsed: false, items: [agent] },
    ]);
    expect(read.map((item) => item.id)).toEqual(["a", "g"]);
    expect(read[1]!.type === "group" && read[1]!.items.map((item) => item.id)).toEqual(["a"]);
    expect(flattenSidebarItemsForMobile(read).map((item) => item.type)).toEqual(["agent", "agent"]);
  });
});

describe("icons", () => {
  test("items take an icon from the set; null removes it; others are refused", () => {
    const workspace = applyWorkspaceSidebarChanges(
      engineering(),
      parseChanges([
        { op: "update", itemId: "engineering", icon: "code" },
        { op: "update", itemId: "releases", icon: "rocket" },
        { op: "update", itemId: "status", icon: "globe" },
      ]),
      ids(),
    );
    const group = mergeSidebarLayout(workspace, EMPTY_SIDEBAR_PERSONAL_CHANGES)
      .items[0] as MergedSidebarGroup;
    expect(group.icon).toBe("code");
    expect(group.items.map((item) => ("icon" in item ? item.icon : undefined))).toEqual([
      "rocket",
      undefined,
      undefined,
      "globe",
    ]);
    const cleared = applyWorkspaceSidebarChanges(
      workspace,
      parseChanges([{ op: "update", itemId: "releases", icon: null }]),
      ids(),
    );
    const releases = (
      cleared.items[0] as unknown as { items: Array<{ id: string; icon?: string }> }
    ).items[0];
    expect(releases?.icon).toBeUndefined();
    expect(() =>
      parseChanges([{ op: "update", itemId: "releases", icon: "not-an-icon" }]),
    ).toThrow();
    expect(() =>
      parseChanges([
        { op: "add", item: { type: "link", url: "https://a.example.com", label: "A", icon: "x" } },
      ]),
    ).toThrow();
  });

  test("an icon this version doesn't know is dropped, and the item still shows", () => {
    const stored = readStoredSidebarLayout({
      version: 1,
      items: [{ id: "a", type: "app", appId: APP_A, icon: "from-a-newer-version" }],
    });
    const item = knownSidebarItem(stored.items[0]!);
    expect(item?.id).toBe("a");
    expect(item && "icon" in item ? item.icon : undefined).toBeUndefined();
  });
});

describe("options", () => {
  test("unset options keep today's behaviour", () => {
    expect(mergeSidebarOptions(undefined, undefined)).toEqual(DEFAULT_SIDEBAR_LAYOUT_OPTIONS);
    expect(readResolvedSidebarOptions(undefined)).toEqual(DEFAULT_SIDEBAR_LAYOUT_OPTIONS);
    expect(DEFAULT_SIDEBAR_LAYOUT_OPTIONS).toEqual({
      sessionsShowApps: true,
      appsPlacement: "sessions",
      hiddenNavEntries: [],
      settingsMore: null,
    });
  });

  test("a person's own choice wins over the default's; null clears it", () => {
    const workspace = applyWorkspaceSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      parseChanges([{ op: "options", sessionsShowApps: false, hiddenNavEntries: ["meetings"] }]),
      ids(),
    );
    expect(workspace.options).toEqual({
      sessionsShowApps: false,
      appsPlacement: "hidden",
      hiddenNavEntries: ["meetings"],
    });
    const member = applyPersonalSidebarChanges(
      workspace,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([{ op: "options", hiddenNavEntries: [], settingsMore: ["workspace:general"] }]),
      ids(),
    );
    expect(sidebarPersonalChangesCustomized(member)).toBe(true);
    expect(mergeSidebarOptions(workspace.options, member.options)).toEqual({
      sessionsShowApps: false,
      appsPlacement: "hidden",
      hiddenNavEntries: [],
      settingsMore: ["workspace:general"],
    });
    const cleared = applyPersonalSidebarChanges(
      workspace,
      member,
      parseChanges([{ op: "options", hiddenNavEntries: null, settingsMore: null }]),
      ids(),
    );
    expect(cleared.options).toBeUndefined();
    expect(sidebarPersonalChangesCustomized(cleared)).toBe(false);
    expect(mergeSidebarOptions(workspace.options, cleared.options).hiddenNavEntries).toEqual([
      "meetings",
    ]);
  });

  test("reset clears options; stored options read leniently", () => {
    const workspace = applyWorkspaceSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      parseChanges([{ op: "options", sessionsShowApps: false }]),
      ids(),
    );
    const reset = applyWorkspaceSidebarChanges(workspace, parseChanges([{ op: "reset" }]), ids());
    expect(reset.options).toBeUndefined();
    const member = applyPersonalSidebarChanges(
      workspace,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([{ op: "options", sessionsShowApps: true }]),
      ids(),
    );
    expect(
      applyPersonalSidebarChanges(workspace, member, parseChanges([{ op: "reset" }]), ids())
        .options,
    ).toBeUndefined();
    // A value this version can't read stays stored, and isn't read as an option.
    const stored = readStoredSidebarOptions({
      sessionsShowApps: "no",
      hiddenNavEntries: ["knowledge", 3],
    });
    expect(stored).toEqual({ sessionsShowApps: "no", hiddenNavEntries: ["knowledge"] } as never);
    expect(knownSidebarOptions(stored)).toEqual({ hiddenNavEntries: ["knowledge"] });
    expect(mergeSidebarOptions(undefined, stored).sessionsShowApps).toBe(true);
    expect(
      readStoredSidebarPersonalChanges({
        ...EMPTY_SIDEBAR_PERSONAL_CHANGES,
        options: { sessionsShowApps: false },
      }).options,
    ).toEqual({ sessionsShowApps: false });
  });
});

describe("apps placement", () => {
  const personal = (options: Record<string, unknown>) =>
    readStoredSidebarPersonalChanges({ ...EMPTY_SIDEBAR_PERSONAL_CHANGES, options }).options;

  test("saved layouts from before it keep their meaning", () => {
    expect(mergeSidebarOptions(undefined, personal({ sessionsShowApps: false }))).toMatchObject({
      sessionsShowApps: false,
      appsPlacement: "hidden",
    });
    expect(mergeSidebarOptions(undefined, personal({ sessionsShowApps: true }))).toMatchObject({
      sessionsShowApps: true,
      appsPlacement: "sessions",
    });
    // An older server's answer has no appsPlacement.
    expect(
      readResolvedSidebarOptions({
        sessionsShowApps: false,
        hiddenNavEntries: [],
        settingsMore: null,
      }).appsPlacement,
    ).toBe("hidden");
  });

  test("setting it sets sessionsShowApps for older readers, and the other way round", () => {
    const section = applyPersonalSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([{ op: "options", appsPlacement: "section" }]),
      ids(),
    );
    expect(section.options).toEqual({ appsPlacement: "section", sessionsShowApps: true });
    expect(mergeSidebarOptions(undefined, section.options)).toMatchObject({
      appsPlacement: "section",
      sessionsShowApps: true,
    });
    const hidden = applyPersonalSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      section,
      parseChanges([{ op: "options", appsPlacement: "hidden" }]),
      ids(),
    );
    expect(hidden.options).toEqual({ appsPlacement: "hidden", sessionsShowApps: false });
    // An API caller using the older option moves the placement with it.
    const legacy = applyPersonalSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      section,
      parseChanges([{ op: "options", sessionsShowApps: false }]),
      ids(),
    );
    expect(legacy.options).toEqual({ appsPlacement: "hidden", sessionsShowApps: false });
    // In one change, appsPlacement wins.
    const both = applyPersonalSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([{ op: "options", sessionsShowApps: false, appsPlacement: "section" }]),
      ids(),
    );
    expect(both.options).toEqual({ appsPlacement: "section", sessionsShowApps: true });
    // Null on either clears both, back to the default's.
    for (const clear of [{ appsPlacement: null }, { sessionsShowApps: null }])
      expect(
        applyPersonalSidebarChanges(
          EMPTY_SIDEBAR_LAYOUT,
          section,
          parseChanges([{ op: "options", ...clear }]),
          ids(),
        ).options,
      ).toBeUndefined();
  });

  test("a person's own placement wins over the default's; unset follows it", () => {
    const workspace = applyWorkspaceSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      parseChanges([{ op: "options", appsPlacement: "section" }]),
      ids(),
    );
    expect(mergeSidebarOptions(workspace.options, undefined).appsPlacement).toBe("section");
    expect(
      mergeSidebarOptions(workspace.options, personal({ sessionsShowApps: false })).appsPlacement,
    ).toBe("hidden");
    expect(
      mergeSidebarOptions(
        workspace.options,
        personal({ appsPlacement: "sessions", sessionsShowApps: true }),
      ).appsPlacement,
    ).toBe("sessions");
  });

  test("an older version's later sessionsShowApps change wins over a stale placement", () => {
    // An older replica sets only sessionsShowApps and keeps appsPlacement as stored.
    expect(
      mergeSidebarOptions(
        undefined,
        personal({ appsPlacement: "section", sessionsShowApps: false }),
      ).appsPlacement,
    ).toBe("hidden");
    expect(
      mergeSidebarOptions(undefined, personal({ appsPlacement: "hidden", sessionsShowApps: true }))
        .appsPlacement,
    ).toBe("sessions");
    // An older version's clear of sessionsShowApps leaves appsPlacement alone: unset.
    expect(
      mergeSidebarOptions(
        personal({ appsPlacement: "hidden", sessionsShowApps: false }),
        personal({ appsPlacement: "section" }),
      ).appsPlacement,
    ).toBe("hidden");
    // A value a newer version added is read as unset and kept in storage.
    const stored = personal({ appsPlacement: "drawer", sessionsShowApps: true });
    expect(stored).toEqual({ appsPlacement: "drawer", sessionsShowApps: true } as never);
    expect(knownSidebarOptions(stored)).toEqual({ sessionsShowApps: true });
    expect(mergeSidebarOptions(undefined, stored).appsPlacement).toBe("sessions");
  });

  test("the request schema takes it, and refuses values it doesn't know", () => {
    const request = { scope: "personal", changes: [{ op: "options", appsPlacement: "section" }] };
    expect(UpdateSidebarLayoutRequest.parse(request)).toEqual(request as never);
    expect(
      UpdateSidebarLayoutRequest.safeParse({
        scope: "personal",
        changes: [{ op: "options", appsPlacement: "drawer" }],
      }).success,
    ).toBe(false);
  });

  test("a tab a preview saved is a section; changes take only the placements", () => {
    // Saved by the version that gave apps a tab beside Sessions.
    const saved = personal({ appsPlacement: "tab", sessionsShowApps: true });
    expect(saved).toEqual({ appsPlacement: "section", sessionsShowApps: true });
    expect(knownSidebarOptions({ appsPlacement: "tab", sessionsShowApps: true } as never)).toEqual({
      appsPlacement: "section",
      sessionsShowApps: true,
    });
    expect(mergeSidebarOptions(undefined, saved).appsPlacement).toBe("section");
    expect(
      readResolvedSidebarOptions({ appsPlacement: "tab", sessionsShowApps: true }).appsPlacement,
    ).toBe("section");
    // Saving anything else rewrites it as a section.
    const saved2 = applyPersonalSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      readStoredSidebarPersonalChanges({
        ...EMPTY_SIDEBAR_PERSONAL_CHANGES,
        options: { appsPlacement: "tab", sessionsShowApps: true },
      }),
      parseChanges([{ op: "options", hiddenNavEntries: ["inbox"] }]),
      ids(),
    );
    expect(saved2.options).toMatchObject({ appsPlacement: "section", sessionsShowApps: true });
    expect(
      UpdateSidebarLayoutRequest.safeParse({
        scope: "personal",
        changes: [{ op: "options", appsPlacement: "tab" }],
      }).success,
    ).toBe(false);
    // A saved tab beside a later Hidden from an older version reads as hidden.
    expect(
      mergeSidebarOptions(undefined, personal({ appsPlacement: "tab", sessionsShowApps: false }))
        .appsPlacement,
    ).toBe("hidden");
  });
});

describe("rolling deploy: this version writing what a newer one stored", () => {
  // What a newer API replica stored: an option, a top-level field and a
  // version this one doesn't know, beside ones it does.
  const NEWER_OPTIONS = {
    sessionsShowApps: false,
    settingsMore: ["workspace:usage"],
    railDensity: "compact",
    pinnedSections: { inbox: true },
  };
  const newerWorkspace = {
    version: 2,
    items: [{ id: "a", type: "app", appId: APP_A }],
    options: NEWER_OPTIONS,
    sections: [{ id: "s1" }],
  };
  const newerPersonal = {
    version: 2,
    hidden: [],
    added: [],
    order: {},
    options: NEWER_OPTIONS,
    sections: [{ id: "s1" }],
  };

  test("the workspace default keeps the newer fields through an unrelated change", () => {
    const written = applyWorkspaceSidebarChanges(
      readStoredSidebarLayout(structuredClone(newerWorkspace)),
      parseChanges([
        { op: "add", item: { id: "b", type: "app", appId: APP_B } },
        { op: "options", sessionsShowApps: true },
      ]),
      ids(),
    );
    // Stored as JSON and read back, as the next replica (of either version) would.
    const reread = JSON.parse(JSON.stringify(written));
    expect(reread).toEqual({
      version: 2,
      items: [
        { id: "a", type: "app", appId: APP_A },
        { id: "b", type: "app", appId: APP_B },
      ],
      options: { ...NEWER_OPTIONS, sessionsShowApps: true, appsPlacement: "sessions" },
      sections: [{ id: "s1" }],
    });
    // Reset is the one change that clears them.
    const reset = applyWorkspaceSidebarChanges(
      readStoredSidebarLayout(reread),
      parseChanges([{ op: "reset" }]),
      ids(),
    );
    expect(reset).toEqual({ version: 1, items: [] });
  });

  test("a person's own changes keep the newer fields through an unrelated change", () => {
    const workspace = readStoredSidebarLayout(structuredClone(newerWorkspace));
    const written = applyPersonalSidebarChanges(
      workspace,
      readStoredSidebarPersonalChanges(structuredClone(newerPersonal)),
      parseChanges([
        { op: "remove", itemId: "a" },
        { op: "options", settingsMore: null },
      ]),
      ids(),
    );
    const reread = JSON.parse(JSON.stringify(written));
    expect(reread).toEqual({
      version: 2,
      hidden: ["a"],
      added: [],
      order: {},
      options: { sessionsShowApps: false, railDensity: "compact", pinnedSections: { inbox: true } },
      sections: [{ id: "s1" }],
    });
    expect(
      applyPersonalSidebarChanges(
        workspace,
        readStoredSidebarPersonalChanges(reread),
        parseChanges([{ op: "reset" }]),
        ids(),
      ),
    ).toEqual(EMPTY_SIDEBAR_PERSONAL_CHANGES);
  });

  test("a value a newer version widened and fields on added entries stay", () => {
    const written = applyPersonalSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      readStoredSidebarPersonalChanges({
        version: 2,
        hidden: [],
        added: [{ parentId: null, item: { id: "my-a", type: "app", appId: APP_A }, pinned: true }],
        order: {},
        options: { sessionsShowApps: "auto" },
      }),
      parseChanges([{ op: "options", settingsMore: ["workspace:usage"] }]),
      ids(),
    );
    const reread = JSON.parse(JSON.stringify(written));
    expect(reread.added).toEqual([
      { parentId: null, item: { id: "my-a", type: "app", appId: APP_A }, pinned: true },
    ]);
    expect(reread.options).toEqual({ sessionsShowApps: "auto", settingsMore: ["workspace:usage"] });
    // This version reads it as unset; the person setting it replaces it.
    expect(mergeSidebarOptions(undefined, reread.options).sessionsShowApps).toBe(true);
    const set = applyPersonalSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      readStoredSidebarPersonalChanges(reread),
      parseChanges([{ op: "options", sessionsShowApps: false }]),
      ids(),
    );
    expect(set.options?.sessionsShowApps).toBe(false);
    expect(set.options?.appsPlacement).toBe("hidden");
  });

  test("rail entries a newer version hid stay hidden when this one saves the list", () => {
    const stored = readStoredSidebarPersonalChanges({
      version: 1,
      hidden: [],
      added: [],
      order: {},
      options: { hiddenNavEntries: ["inbox", "voice-notes"] },
    });
    // The answer names only entries this version knows; the Customize page
    // sends that list back with its change.
    expect(knownSidebarOptions(stored.options)?.hiddenNavEntries).toEqual(["inbox"]);
    const written = applyPersonalSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      stored,
      parseChanges([{ op: "options", hiddenNavEntries: ["knowledge"] }]),
      ids(),
    );
    expect(written.options?.hiddenNavEntries as string[]).toEqual(["knowledge", "voice-notes"]);
    // Showing every entry again clears the list outright.
    const cleared = applyPersonalSidebarChanges(
      EMPTY_SIDEBAR_LAYOUT,
      written,
      parseChanges([{ op: "options", hiddenNavEntries: null }]),
      ids(),
    );
    expect(cleared.options?.hiddenNavEntries).toBeUndefined();
  });

  test("every option the schema has is read for answers and applied by changes", () => {
    const every = {
      sessionsShowApps: false,
      appsPlacement: "hidden",
      hiddenNavEntries: ["meetings"],
      settingsMore: ["workspace:usage"],
    } satisfies Required<SidebarLayoutOptions>;
    expect(Object.keys(every).sort()).toEqual(Object.keys(SidebarLayoutOptions.shape).sort());
    expect(knownSidebarOptions(every)).toEqual(every);
    expect(
      applyWorkspaceSidebarChanges(
        EMPTY_SIDEBAR_LAYOUT,
        parseChanges([{ op: "options", ...every }]),
        ids(),
      ).options,
    ).toEqual(every);
  });

  test("answers show only the options this version knows", () => {
    const stored = readStoredSidebarPersonalChanges(structuredClone(newerPersonal)).options;
    const known = knownSidebarOptions(stored);
    expect(known).toEqual({ sessionsShowApps: false, settingsMore: ["workspace:usage"] });
    // The answer's schema is strict: unknown options would fail it.
    expect(() =>
      SidebarLayoutResponse.parse({
        items: [],
        hidden: [],
        personal: { available: true, revision: 1, customized: true, options: known },
        workspace: { revision: 1, canEdit: false },
        options: mergeSidebarOptions(undefined, known),
      }),
    ).not.toThrow();
  });
});

describe("reading a layout answer", () => {
  // Bendik's staging layout (25 Nov 2026), with an agent link added: every
  // item must survive, so Settings → Sidebar and the rail can draw it.
  const answer = {
    items: [
      {
        id: "app-71c4e4913b",
        origin: "workspace",
        type: "app",
        appId: "90cb351f-9bf3-4b31-969f-d053ae421b34",
        path: null,
        label: "Deployments",
        icon: "rocket",
      },
      {
        id: "my-app-79b6e87b34",
        origin: "personal",
        type: "app",
        appId: "3c039779-f434-48d3-8134-3300e88f897a",
        path: null,
        label: "Benchmarks",
        icon: "chart-line",
      },
      {
        id: "my-agent-1",
        origin: "personal",
        type: "agent",
        agentId: APP_A,
        label: "Reviewer",
        avatar: { kind: "letters", letters: "RV", hue: 200 },
      },
      {
        id: "pinned-apps",
        origin: "workspace",
        type: "live_list",
        list: "pinned_apps",
        label: "Pinned apps",
        limit: 5,
        apps: [],
      },
    ],
    hidden: [],
    personal: {
      available: true,
      revision: 26,
      customized: true,
      options: { sessionsShowApps: false, settingsMore: ["account:security"] },
    },
    workspace: { revision: 11, canEdit: false },
    options: { sessionsShowApps: false, hiddenNavEntries: [], settingsMore: ["account:security"] },
  };

  test("keeps every item, including an agent link and its avatar", () => {
    const read = readResolvedSidebarItems(answer.items);
    expect(read.map((item) => item.id)).toEqual(answer.items.map((item) => item.id));
    expect(read.find((item) => item.type === "agent")).toMatchObject({
      avatar: { kind: "letters", letters: "RV" },
    });
    expect(readResolvedSidebarOptions(answer.options)).toMatchObject({
      sessionsShowApps: false,
      settingsMore: ["account:security"],
    });
  });

  test("an agent link with a malformed avatar is left out, not an error", () => {
    expect(
      readResolvedSidebarItems([{ ...answer.items[2], avatar: { kind: "letters", letters: "" } }]),
    ).toEqual([]);
  });
});
