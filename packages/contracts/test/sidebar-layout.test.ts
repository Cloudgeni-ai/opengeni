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
  sidebarLinkedAppIds,
  sidebarPersonalChangesCustomized,
  withoutGoneSidebarApps,
  knownSidebarItem,
  type SidebarLayoutChange,
  type MergedSidebarGroup,
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
    expect(knownSidebarItem({ id: "a", type: "app", appId: APP_A, icon: "rocket" })).toEqual({
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
  });
});
