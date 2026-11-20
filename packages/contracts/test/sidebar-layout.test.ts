import { describe, expect, test } from "bun:test";
import {
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
  sidebarPersonalChangesCustomized,
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
    expect(() => parseChanges([{ op: "add", item: { type: "link", url: "http://x.y", label: "X" } }])).toThrow();
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
    expect(seen.items.map((item) => item.id)).toEqual(["engineering", "link-n1"]);
    expect((seen.items[0] as MergedSidebarGroup).items.map((item) => item.id)).toEqual(["releases", "reviews", "status"]);
    expect(seen.hidden.map((entry) => [entry.parentId, entry.item.id])).toEqual([
      ["engineering", "incidents"],
    ]);
    // Everyone else still sees the default.
    const other = mergeSidebarLayout(workspace, EMPTY_SIDEBAR_PERSONAL_CHANGES);
    expect((other.items[0] as MergedSidebarGroup).items).toHaveLength(4);
    expect(sidebarPersonalChangesCustomized(member)).toBe(true);
    const reset = applyPersonalSidebarChanges(workspace, member, parseChanges([{ op: "reset" }]), ids());
    expect(sidebarPersonalChangesCustomized(reset)).toBe(false);
  });

  test("people reorder their view, add into workspace groups and show hidden items", () => {
    const workspace = engineering();
    let member = applyPersonalSidebarChanges(
      workspace,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([
        { op: "move", itemId: "status", index: 0 },
        { op: "add", groupId: "engineering", index: 1, item: { id: "mine", type: "app", appId: APP_C } },
        { op: "remove", itemId: "reviews" },
      ]),
      ids(),
    );
    let seen = mergeSidebarLayout(workspace, member);
    expect((seen.items[0] as MergedSidebarGroup).items.map((item) => item.id)).toEqual([
      "status",
      "mine",
      "releases",
      "incidents",
    ]);
    member = applyPersonalSidebarChanges(workspace, member, parseChanges([{ op: "show", itemId: "reviews" }]), ids());
    seen = mergeSidebarLayout(workspace, member);
    expect((seen.items[0] as MergedSidebarGroup).items.map((item) => item.id)).toContain("reviews");
    expect(() =>
      applyPersonalSidebarChanges(workspace, member, parseChanges([{ op: "update", itemId: "releases", label: "R" }]), ids()),
    ).toThrow(SidebarLayoutChangeError);
    expect(() =>
      applyPersonalSidebarChanges(workspace, member, parseChanges([{ op: "move", itemId: "releases", groupId: null, index: 0 }]), ids()),
    ).toThrow(SidebarLayoutChangeError);
  });

  test("a deleted workspace group keeps a person's items visible", () => {
    let workspace = engineering();
    const member = applyPersonalSidebarChanges(
      workspace,
      EMPTY_SIDEBAR_PERSONAL_CHANGES,
      parseChanges([{ op: "add", groupId: "engineering", item: { id: "mine", type: "app", appId: APP_C } }]),
      ids(),
    );
    workspace = applyWorkspaceSidebarChanges(workspace, parseChanges([{ op: "remove", itemId: "engineering" }]), ids());
    expect(mergeSidebarLayout(workspace, member).items.map((item) => item.id)).toEqual(["mine"]);
  });

  test("unknown item types are ignored by readers and kept by writers", () => {
    const stored = readStoredSidebarLayout({
      version: 2,
      items: [
        { id: "future", type: "kanban_board", board: "x" },
        { id: "g", type: "group", label: "G", items: [{ id: "f2", type: "chart" }, { id: "l", type: "link", url: "https://a.example", label: "A" }] },
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
    expect((updated.items[1]!.items as { id: string }[]).map((item) => item.id)).toEqual(["f2", "l"]);
    expect(readResolvedSidebarItems([{ id: "z", type: "kanban_board", origin: "workspace" }, "x"])).toEqual([]);
    expect(readStoredSidebarPersonalChanges({ hidden: ["a", 1, "a"], added: [{ item: { id: "b", type: "chart" } }] })).toEqual({
      version: 1,
      hidden: ["a"],
      added: [{ parentId: null, item: { id: "b", type: "chart" } }],
      order: {},
    });
  });

  test("duplicate ids and nested groups are refused", () => {
    const workspace = engineering();
    expect(() =>
      applyWorkspaceSidebarChanges(workspace, parseChanges([{ op: "add", item: { id: "releases", type: "app", appId: APP_A } }]), ids()),
    ).toThrow(SidebarLayoutChangeError);
    expect(() =>
      applyWorkspaceSidebarChanges(workspace, parseChanges([{ op: "add", groupId: "engineering", item: { type: "group", label: "Inner" } }]), ids()),
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
            apps: [APP_A, APP_B, APP_C, APP_A].map((appId, index) => ({ appId, title: `${index}` })),
          },
        ],
      },
    ]);
    expect(flat.map((item) => item.id)).toEqual(["a", "r"]);
    expect(flat[1]!.type === "live_list" && flat[1]!.apps).toHaveLength(3);
  });
});
