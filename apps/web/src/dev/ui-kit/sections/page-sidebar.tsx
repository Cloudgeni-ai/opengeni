import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  KeyRoundIcon,
  PanelLeftIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UsersIcon,
} from "lucide-react";
import type {
  ResolvedSidebarChild,
  ResolvedSidebarItem,
  SessionAvatar,
  SidebarLayoutResponse,
  UpdateSidebarLayoutRequest,
} from "@opengeni/sdk";
import {
  applyPersonalSidebarChanges,
  applyWorkspaceSidebarChanges,
  EMPTY_SIDEBAR_PERSONAL_CHANGES,
  isSidebarItemIcon,
  mergeSidebarLayout,
  mergeSidebarOptions,
  readResolvedSidebarOptions,
  SIDEBAR_LIVE_LIST_DEFAULT_LIMIT,
  SIDEBAR_LIVE_LIST_LABELS,
  sidebarPersonalChangesCustomized,
  UpdateSidebarLayoutRequest as UpdateRequestSchema,
  type MergedSidebarChild,
  type MergedSidebarItem,
  type StoredSidebarLayout,
  type StoredSidebarPersonalChanges,
} from "@opengeni/contracts/sidebar-layout";
import { agentInitialsAvatar } from "@opengeni/contracts";
import { AppContext } from "@opengeni/react/app/app-context";
import { RailProvider } from "@opengeni/react/app/components/rail/rail-context";
import { SidebarLayoutSection } from "@/components/sidebar-layout/sidebar-layout-section";
import { resetSidebarLayoutCache } from "@/components/sidebar-layout/use-sidebar-layout";
import { SettingsShell, type SettingsRailSection } from "@/components/settings/settings-sidebar";
import { foldSettingsRail } from "@/components/settings/settings-more";
import { useSidebarLayout } from "@/components/sidebar-layout/use-sidebar-layout";
import { SidebarCustomizeRoute } from "@/routes/sidebar-customize";
import { currentWorkspace } from "../fixtures";
import { KitBlock, KitCanvas, KitSection } from "../kit";

/* ----------------------------------------------------------------------------
   The customizable sidebar (docs/sidebar-layout.md) with the production rail
   section and Sidebar page. Only the SDK transport is replaced: an in-memory
   layout with a few apps and agents, changed by the same contract functions
   the API uses.
   -------------------------------------------------------------------------- */

const WORKSPACE_ID = currentWorkspace.id;
const APPS = [
  { appId: "0b5b7c3e-6f3e-4d55-9a3c-1f2b3c4d5e01", title: "Release notes" },
  { appId: "0b5b7c3e-6f3e-4d55-9a3c-1f2b3c4d5e02", title: "Incident board" },
  { appId: "0b5b7c3e-6f3e-4d55-9a3c-1f2b3c4d5e03", title: "Sales dashboard" },
];
const AGENTS: { id: string; name: string; avatar: SessionAvatar | null }[] = [
  {
    id: "6d1f0a2b-3c4d-4e5f-8a9b-0c1d2e3f4a01",
    name: "Release helper",
    avatar: { kind: "emoji", emoji: "🚀", hue: 250 },
  },
  {
    id: "6d1f0a2b-3c4d-4e5f-8a9b-0c1d2e3f4a02",
    name: "Support triage",
    avatar: null,
  },
  {
    id: "6d1f0a2b-3c4d-4e5f-8a9b-0c1d2e3f4a03",
    name: "Code reviewer",
    avatar: { kind: "icon", icon: "bot", hue: 150 },
  },
];

function createFixture() {
  let workspace: StoredSidebarLayout = {
    version: 1,
    items: [
      {
        id: "team",
        type: "group",
        label: "Team",
        icon: "users",
        items: [
          { id: "release-helper", type: "agent", agentId: AGENTS[0]!.id },
          {
            id: "releases",
            type: "app",
            appId: APPS[0]!.appId,
            path: "/latest",
            icon: "rocket",
          },
          { id: "docs", type: "link", url: "https://docs.example.com", label: "Docs" },
        ],
      },
      { id: "triage", type: "agent", agentId: AGENTS[1]!.id },
      {
        id: "apps",
        type: "group",
        label: "Apps",
        icon: "layout-grid",
        items: [{ id: "recent", type: "live_list", list: "recent_apps", limit: 3 }],
      },
    ],
  };
  let personal: StoredSidebarPersonalChanges = {
    ...EMPTY_SIDEBAR_PERSONAL_CHANGES,
    added: [
      {
        parentId: null,
        item: { id: "my-links", type: "group", label: "My links", items: [] },
      },
    ],
    options: { settingsMore: ["workspace:keys", "workspace:security"] },
  };
  let revisions = { personal: 1, workspace: 1 };
  let next = 0;
  const randomId = () => `k${(next += 1)}`;

  const child = (item: MergedSidebarChild): ResolvedSidebarChild | null => {
    const base = { id: item.id, origin: item.origin };
    if (item.type === "agent") {
      const agent = AGENTS.find((entry) => entry.id === item.agentId);
      if (!agent) return null;
      return {
        ...base,
        type: "agent",
        agentId: agent.id,
        label: item.label ?? agent.name,
        avatar: agent.avatar ?? agentInitialsAvatar(agent.name, agent.id),
      };
    }
    if (item.type === "app") {
      const app = APPS.find((entry) => entry.appId === item.appId);
      if (!app) return null;
      return {
        ...base,
        type: "app",
        appId: app.appId,
        path: item.path ?? null,
        label: item.label ?? app.title,
        ...(isSidebarItemIcon(item.icon) ? { icon: item.icon } : {}),
      };
    }
    if (item.type === "link")
      return {
        ...base,
        type: "link",
        url: item.url,
        label: item.label,
        ...(isSidebarItemIcon(item.icon) ? { icon: item.icon } : {}),
      };
    return {
      ...base,
      type: "live_list",
      list: item.list,
      label: item.label ?? SIDEBAR_LIVE_LIST_LABELS[item.list],
      limit: item.limit ?? SIDEBAR_LIVE_LIST_DEFAULT_LIMIT,
      apps: APPS.slice(0, item.limit ?? SIDEBAR_LIVE_LIST_DEFAULT_LIMIT),
    };
  };
  const resolve = (items: MergedSidebarItem[]): ResolvedSidebarItem[] =>
    items.flatMap((item): ResolvedSidebarItem[] => {
      if (item.type !== "group") {
        const resolved = child(item);
        return resolved ? [resolved] : [];
      }
      return [
        {
          id: item.id,
          origin: item.origin,
          type: "group",
          label: item.label,
          collapsed: item.collapsed ?? false,
          ...(isSidebarItemIcon(item.icon) ? { icon: item.icon } : {}),
          items: item.items.flatMap((entry) => {
            const resolved = child(entry);
            return resolved ? [resolved] : [];
          }),
        },
      ];
    });
  const response = (): SidebarLayoutResponse => {
    const merged = mergeSidebarLayout(workspace, personal);
    return {
      items: resolve(merged.items),
      options: mergeSidebarOptions(workspace.options, personal.options),
      hidden: merged.hidden.flatMap((entry) => {
        const [item] = resolve([entry.item]);
        return item ? [{ parentId: entry.parentId, item }] : [];
      }),
      personal: {
        available: true,
        revision: revisions.personal,
        customized: sidebarPersonalChangesCustomized(personal),
        ...(personal.options ? { options: personal.options } : {}),
      },
      workspace: {
        revision: revisions.workspace,
        canEdit: true,
        ...(workspace.options ? { options: workspace.options } : {}),
        items: resolve(mergeSidebarLayout(workspace, EMPTY_SIDEBAR_PERSONAL_CHANGES).items),
      },
    };
  };
  const client = {
    getSidebarLayout: async () => response(),
    // No network in the kit: outside links keep their fallback icon.
    getSidebarLinkIcon: async () => null,
    updateSidebarLayout: async (_workspaceId: string, request: UpdateSidebarLayoutRequest) => {
      const parsed = UpdateRequestSchema.parse(request);
      if (parsed.scope === "workspace") {
        workspace = applyWorkspaceSidebarChanges(workspace, parsed.changes, randomId);
        revisions = { ...revisions, workspace: revisions.workspace + 1 };
      } else {
        personal = applyPersonalSidebarChanges(workspace, personal, parsed.changes, randomId);
        revisions = { ...revisions, personal: revisions.personal + 1 };
      }
      return response();
    },
    listAgents: async () => {
      // `&agents=error`: the agent list can't be read.
      if (new URLSearchParams(window.location.search).get("agents") === "error")
        throw new Error("Service unavailable.");
      return AGENTS.map((agent) => ({
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar,
      }));
    },
    listArtifactCatalog: async () => ({
      items: APPS.map((app) => ({ id: app.appId, title: app.title })),
    }),
    // The Add app form's Page picker reads the app's links from its current HTML.
    getWorkspaceArtifactCurrent: async (_workspaceId: string, appId: string) => ({
      artifact: { id: appId, currentVersion: { id: `${appId}-v1` } },
    }),
    getWorkspaceArtifactHtml: async () =>
      `<nav><a href="/">Home</a><a href="/releases">Releases</a><a href="/roadmap">Roadmap</a><a href="#/changelog">Changelog</a></nav>`,
  };
  return {
    context: {
      client,
      accessContext: {
        subjectId: "user:kit",
        accountId: "kit-account",
      },
      workspaces: [currentWorkspace],
      resetSessionView: () => undefined,
    },
  };
}

function Provider({ children }: { children: ReactNode }) {
  const [fixture] = useState(() => {
    resetSidebarLayoutCache();
    return createFixture();
  });
  return (
    <AppContext.Provider value={fixture.context as never}>
      <RailProvider workspaceId={WORKSPACE_ID}>{children}</RailProvider>
    </AppContext.Provider>
  );
}

function SettingsSearchPreview() {
  const sections = useMemo<SettingsRailSection[]>(
    () => [
      {
        id: "workspace",
        label: "Workspace",
        groups: [
          {
            items: [
              {
                id: "workspace:general",
                label: "General",
                icon: SlidersHorizontalIcon,
                link: <Link to="/dev/ui-kit" />,
              },
              {
                id: "workspace:members",
                label: "Members",
                icon: UsersIcon,
                link: <Link to="/dev/ui-kit" />,
              },
              {
                id: "workspace:agents",
                label: "Agent settings",
                icon: BotIcon,
                link: <Link to="/dev/ui-kit" />,
              },
              {
                id: "workspace:keys",
                label: "API keys",
                icon: KeyRoundIcon,
                link: <Link to="/dev/ui-kit" />,
              },
              {
                id: "workspace:security",
                label: "Security",
                icon: ShieldCheckIcon,
                link: <Link to="/dev/ui-kit" />,
              },
            ],
          },
        ],
        searchOnly: [
          {
            id: "workspace:/workspaces/$workspaceId/sidebar",
            label: "Sidebar",
            icon: PanelLeftIcon,
            link: <Link to="/dev/ui-kit" />,
            keywords: ["customize sidebar", "navigation"],
          },
        ],
      },
    ],
    [],
  );
  // The person's own choice of top-level entries; the rest fold under More.
  const { layout, update } = useSidebarLayout(WORKSPACE_ID);
  const more = readResolvedSidebarOptions(layout?.options).settingsMore;
  const rail = foldSettingsRail(sections, more, (settingsMore) => {
    void update({ scope: "personal", changes: [{ op: "options", settingsMore }] });
  });
  return (
    <div
      data-kit-settings-search
      className="h-[480px] overflow-hidden rounded-md border border-border"
    >
      <SettingsShell
        label="Settings"
        back={{ link: <Link to="/dev/ui-kit" />, label: "Back to sessions" }}
        home={<Link to="/dev/ui-kit" />}
        sections={rail}
        activeId="workspace:general"
        currentPage="General"
        page={{ title: "General" }}
      >
        <p className="text-sm text-fg-muted">Workspace settings.</p>
      </SettingsShell>
    </div>
  );
}

export default function SidebarPageSection() {
  return (
    <KitSection sectionKey="page-sidebar">
      <Provider>
        <KitBlock title="Rail and Sidebar page">
          <KitCanvas className="min-h-[640px]">
            <div className="flex gap-6">
              <div
                data-kit-rail
                className="w-64 shrink-0 rounded-md border border-border bg-surface py-2"
              >
                <SidebarLayoutSection />
              </div>
              <div className="min-w-0 flex-1">
                <SidebarCustomizeRoute workspaceId={WORKSPACE_ID} />
              </div>
            </div>
          </KitCanvas>
        </KitBlock>
        <KitBlock title="Settings search">
          <SettingsSearchPreview />
        </KitBlock>
      </Provider>
    </KitSection>
  );
}
