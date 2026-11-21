import { beforeEach, expect, test } from "bun:test";
import type { SidebarLayoutResponse } from "@opengeni/sdk";
import {
  cachedSidebarLayout,
  readSidebarLayout,
  refreshSidebarLayout,
  resetSidebarLayouts,
  sidebarMenuSections,
  subscribeSidebarLayout,
} from "./sidebar-layout";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

function layout(
  items: unknown[],
  revisions: { personal?: number; workspace?: number } = {},
): SidebarLayoutResponse {
  return {
    items,
    hidden: [],
    personal: { available: true, revision: revisions.personal ?? 0, customized: false },
    workspace: { revision: revisions.workspace ?? 0, canEdit: false },
  } as SidebarLayoutResponse;
}

const list = (id: string, apps: string[], limit = 5) => ({
  id,
  origin: "workspace",
  type: "live_list",
  list: "pinned_apps",
  label: "Pinned apps",
  limit,
  apps: apps.map((appId, index) => ({ appId, title: `App ${index + 1}` })),
});
const app = (id: string, appId: string, path: string | null = null) => ({
  id,
  origin: "workspace",
  type: "app",
  appId,
  path,
  label: id,
});
const link = (id: string, url = `https://${id}.example.com`) => ({
  id,
  origin: "personal",
  type: "link",
  url,
  label: id,
});

beforeEach(() => resetSidebarLayouts());

test("groups are headed sections; top-level links share one; lists show at most 3 apps", () => {
  const sections = sidebarMenuSections(
    readSidebarLayout(
      layout([
        app("releases", A, "/releases"),
        link("status"),
        {
          id: "eng",
          origin: "workspace",
          type: "group",
          label: "Engineering",
          collapsed: true,
          items: [app("review", B), link("docs"), list("eng-pins", [C])],
        },
        list("pinned-apps", [A, B, C, D]),
        link("later"),
      ]),
    ).items,
  );
  expect(sections.map((section) => [section.heading, section.rows.map((row) => row.key)])).toEqual([
    [null, ["releases", "status"]],
    ["Engineering", ["review", "docs", `eng-pins/${C}`]],
    ["Pinned apps", [`pinned-apps/${A}`, `pinned-apps/${B}`, `pinned-apps/${C}`]],
    [null, ["later"]],
  ]);
  expect(sections[0]!.rows[0]).toEqual({
    key: "releases",
    kind: "app",
    appId: A,
    path: "/releases",
    label: "releases",
  });
});

test("agents are rows with their avatar, at the top level and in groups", () => {
  const avatar = { kind: "letters", letters: "RH", hue: 40 };
  const agent = (id: string, agentId: string) => ({
    id,
    origin: "workspace",
    type: "agent",
    agentId,
    label: `Agent ${id}`,
    avatar,
  });
  const sections = sidebarMenuSections(
    readSidebarLayout(
      layout([
        agent("helper", A),
        link("status"),
        {
          id: "team",
          origin: "workspace",
          type: "group",
          label: "Team",
          collapsed: false,
          items: [agent("reviewer", B)],
        },
      ]),
    ).items,
  );
  expect(sections.map((section) => [section.heading, section.rows.map((row) => row.kind)])).toEqual(
    [
      [null, ["agent", "link"]],
      ["Team", ["agent"]],
    ],
  );
  expect(sections[0]!.rows[0]).toEqual({
    key: "helper",
    kind: "agent",
    agentId: A,
    label: "Agent helper",
    avatar,
  });
});

test("empty lists and groups, unknown types and non-https links are left out", () => {
  const sections = sidebarMenuSections(
    readSidebarLayout(
      layout([
        list("pinned-apps", []),
        {
          id: "empty",
          origin: "workspace",
          type: "group",
          label: "Empty",
          collapsed: false,
          items: [],
        },
        { id: "future", origin: "workspace", type: "calendar", label: "Later" },
        link("plain", "http://plain.example.com"),
        list("short", [A, B], 1),
      ]),
    ).items,
  );
  expect(sections.map((section) => section.rows.map((row) => row.key))).toEqual([[`short/${A}`]]);
  expect(sidebarMenuSections(null)).toEqual([]);
});

test("overlapping reads finishing out of order keep the newer layout", async () => {
  const answers: Array<(value: SidebarLayoutResponse) => void> = [];
  const client = {
    getSidebarLayout: () =>
      new Promise<SidebarLayoutResponse>((resolve) => {
        answers.push(resolve);
      }),
  };
  const seen: number[] = [];
  subscribeSidebarLayout("k", (next) => seen.push(next.personal.revision));
  const first = refreshSidebarLayout(client, "k", "w");
  const second = refreshSidebarLayout(client, "k", "w");
  answers[1]!(layout([link("new")], { personal: 2 }));
  await second;
  answers[0]!(layout([link("old")], { personal: 1 }));
  expect((await first)?.items.map((item) => item.id)).toEqual(["new"]);
  expect(cachedSidebarLayout("k")?.personal.revision).toBe(2);
  expect(seen).toEqual([2]);
});

test("a failed read or a server without the sidebar keeps what is shown", async () => {
  await refreshSidebarLayout(
    { getSidebarLayout: async () => layout([link("kept")], { workspace: 1 }) },
    "k",
    "w",
  );
  const failing = {
    getSidebarLayout: async (): Promise<SidebarLayoutResponse> => {
      throw new Error("offline");
    },
  };
  expect((await refreshSidebarLayout(failing, "k", "w"))?.items).toHaveLength(1);
  expect(await refreshSidebarLayout({}, "other", "w")).toBeNull();
});

test("rows and groups carry their icons; unknown icons fall back", () => {
  const sections = sidebarMenuSections(
    readSidebarLayout(
      layout([
        { ...app("releases", A), icon: "rocket" },
        { ...link("status"), icon: "no-such-icon" },
        {
          id: "eng",
          origin: "workspace",
          type: "group",
          label: "Engineering",
          collapsed: false,
          icon: "code",
          items: [app("review", B)],
        },
      ]),
    ).items,
  );
  expect(sections.map((section) => [section.icon, section.rows.map((row) => row.icon)])).toEqual([
    [undefined, ["rocket", undefined]],
    ["code", [undefined]],
  ]);
});
