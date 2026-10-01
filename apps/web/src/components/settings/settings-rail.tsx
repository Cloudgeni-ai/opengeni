// The one settings rail: every settings page the person can use, in three
// sections. "Workspace" lists the current workspace's pages, "Organization"
// the pages of the organization it belongs to, "Your account" the person's own.
// One picker at the top (the main rail's workspace picker) changes workspace or
// organization and keeps the same kind of page. Workspace, organization and
// personal settings all draw this same rail, so a page never moves to another
// rail and the scope of every page is visible.
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BarChart3Icon,
  CodeIcon,
  ContainerIcon,
  GraduationCapIcon,
  KeyRoundIcon,
  LaptopIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UsersIcon,
  VariableIcon,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import {
  ORGANIZATION_SETTINGS_GROUPS,
  ORGANIZATION_SETTINGS_ITEMS,
  organizationSettingsLabel,
} from "./organization-settings-pages";
import { settingsHomeLink, type SettingsRailSection } from "./settings-sidebar";
import { WorkspaceSwitcherMenu } from "@/components/rail/workspace-switcher";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { orgLabel } from "@/lib/org";
import {
  organizationSettingsAccess,
  resolveOrganizationSettingsSection,
} from "@/lib/organization-settings-access";
import { hasWorkspacePermission } from "@/lib/permissions";
import { currentPageReturnTo, returnToSearch } from "@/lib/return-to";
import { useOrganizationName } from "@/lib/use-organization-name";
import type {
  WorkspaceManagementLocation,
  WorkspaceSettingsSection,
} from "@/lib/workspace-management-location";

/** Where in settings the person is: a workspace page, an organization page, or their account. */
export type SettingsLocation = WorkspaceManagementLocation | { kind: "account" };

/** One name, one icon and one description per workspace settings page. */
export const WORKSPACE_SETTINGS_COPY: Record<
  WorkspaceSettingsSection,
  {
    title: string;
    /** Omitted when it would only list what the page shows. */
    description?: (names: { workspace: string; organization: string }) => string;
  }
> = {
  general: {
    title: "General",
  },
  access: {
    title: "Access",
    description: ({ workspace, organization }) =>
      `People from ${organization} who can use ${workspace}.`,
  },
  // No subtitle: the Default model row says what a new chat uses and who pays.
  models: {
    title: "Models",
  },
  "api-keys": {
    title: "API keys",
    description: () => "Keys that let your own tools start work in this workspace.",
  },
  developer: {
    title: "Developer",
    description: () =>
      "For products built on Opengeni: tell your backend what happens here, and give runs credentials from it.",
  },
  learning: {
    title: "Agent learning",
    description: () => "How agents save knowledge, instructions and skills.",
  },
};

const SECTION_ICONS = {
  general: SlidersHorizontalIcon,
  access: UsersIcon,
  models: SparklesIcon,
  learning: GraduationCapIcon,
  "api-keys": KeyRoundIcon,
  developer: CodeIcon,
} as const;

// Agent learning is still a settings URL, but it opens the Learning page of Knowledge.
// Models is not a workspace page: every model setting, each workspace's included,
// lives on Organization > Models, and the old workspace URL redirects there.
const SECTION_ORDER: readonly WorkspaceSettingsSection[] = [
  "general",
  "access",
  "api-keys",
  "developer",
];

// Workspace dashboards in the settings rail. They open as their own pages.
export const ACTIVITY_PAGES = [
  {
    to: "/workspaces/$workspaceId/insights" as const,
    label: "Insights",
    icon: BarChart3Icon,
    requiresAdmin: true,
  },
] as const;

export const RUNTIME_PAGES = [
  {
    to: "/workspaces/$workspaceId/variable-sets" as const,
    label: "Variable sets",
    icon: VariableIcon,
  },
  {
    to: "/workspaces/$workspaceId/rigs" as const,
    label: "Sandbox environments",
    icon: ContainerIcon,
  },
  {
    to: "/workspaces/$workspaceId/machines" as const,
    label: "Machines",
    icon: LaptopIcon,
  },
] as const;

/** The name of a workspace settings page or dashboard. */
export function workspacePageLabel(location: WorkspaceManagementLocation): string {
  if (location.kind === "settings")
    return WORKSPACE_SETTINGS_COPY[location.section ?? "general"].title;
  if (location.kind === "page") {
    return (
      [...ACTIVITY_PAGES, ...RUNTIME_PAGES].find((page) => page.to === location.target)?.label ??
      "Settings"
    );
  }
  return "Settings";
}

/** Groups set apart by space, only when each has at least two pages. */
function splitIntoGroups(groups: SettingsRailSection["groups"][number]["items"][]) {
  const filled = groups.filter((items) => items.length > 0);
  return filled.every((items) => items.length >= 2)
    ? filled.map((items) => ({ items }))
    : [{ items: filled.flat() }];
}

/** The rail id of a destination, unique across the three sections. */
export function settingsRailItemId(location: SettingsLocation): string | null {
  switch (location.kind) {
    case "settings":
      return `workspace:${location.section ?? "general"}`;
    case "page":
      return `workspace:${location.target}`;
    case "organization":
      return location.section ? `organization:${location.section}` : null;
    case "account":
      return "account:security";
  }
}

/**
 * A workspace an organization owner or admin manages without being able to
 * open it: only its General and Access pages.
 */
export type ManagedWorkspaceScope = {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  /** An accessible workspace of the same organization, for its settings. */
  organizationSettingsWorkspaceId?: string | undefined;
};

export type SettingsRail = {
  /** The one picker under the back link; null where there is nothing to switch. */
  picker: ReactNode;
  sections: SettingsRailSection[];
  back: { link: ReactElement; label: string };
  home: ReactElement;
  /** The organization's name, as the rail shows it. */
  organizationName: string | null;
  workspaceName: string | null;
  /** The scope of a location, for the narrow header: "Organization · Acme Robotics". */
  scopeOf: (location: SettingsLocation) => string | undefined;
  /** The current organization page, after hiding pages this person can't use. */
  organizationSection: ReturnType<typeof resolveOrganizationSettingsSection> | null;
};

export function useSettingsRail(input: {
  /** The accessible workspace settings open through; null when there is none. */
  workspaceId: string | null;
  location: SettingsLocation;
  /** The organization's name when the page knows it better than the access grants. */
  organizationName?: string | undefined;
  managedWorkspace?: ManagedWorkspaceScope | undefined;
}): SettingsRail {
  const context = useAppContext();
  const navigate = useNavigate();
  const { location, managedWorkspace } = input;
  const workspace = input.workspaceId
    ? (context.workspaces.find((candidate) => candidate.id === input.workspaceId) ?? null)
    : null;
  // The workspace whose organization pages are linked.
  const organizationWorkspaceId = managedWorkspace
    ? (managedWorkspace.organizationSettingsWorkspaceId ?? null)
    : (workspace?.id ?? null);
  const accountId = managedWorkspace?.organizationId || workspace?.accountId || null;
  const access = accountId
    ? organizationSettingsAccess({
        accessContext: context.accessContext,
        clientConfig: context.clientConfig,
        accountId,
      })
    : null;
  // The real name: from the access grant, else (for an admin) the organization overview.
  const knownName = useOrganizationName(accountId ?? "", access?.administrator ?? false);
  const organizationName =
    input.organizationName ??
    managedWorkspace?.organizationName ??
    knownName ??
    (accountId ? orgLabel(accountId, context.accessContext.accountGrants) : null);
  // Models stays named when it refuses someone (members choose models in the
  // composer), so the page and the rail don't jump to another page.
  const organizationSection =
    access && location.kind === "organization"
      ? location.section === "models"
        ? "models"
        : resolveOrganizationSettingsSection(location.section, access.visibleSections)
      : null;

  function openWorkspace(nextWorkspaceId: string) {
    context.resetSessionView();
    switch (location.kind) {
      case "settings": {
        // A Personal workspace has no API keys or Developer page; land on General.
        const nextPersonal = isPersonalWorkspace(
          context.workspaces.find((candidate) => candidate.id === nextWorkspaceId) ?? null,
          context.managedSelfContext,
        );
        const section =
          nextPersonal && (location.section === "api-keys" || location.section === "developer")
            ? "general"
            : location.section;
        void navigate({
          to: "/workspaces/$workspaceId/settings",
          params: { workspaceId: nextWorkspaceId },
          search: section ? { section } : {},
        });
        return;
      }
      case "page":
        void navigate({ to: location.target, params: { workspaceId: nextWorkspaceId } });
        return;
      case "organization":
        void navigate({
          to: "/workspaces/$workspaceId/organization",
          params: { workspaceId: nextWorkspaceId },
          search: organizationSection ? { section: organizationSection } : {},
        });
        return;
      case "account":
        void navigate({
          to: "/workspaces/$workspaceId/settings",
          params: { workspaceId: nextWorkspaceId },
        });
    }
  }

  const workspaceName = managedWorkspace?.name ?? workspace?.name ?? null;
  // This page, as the return target of pages the rail opens outside settings'
  // own URLs (Your account, New workspace).
  const hereLabel =
    location.kind === "organization"
      ? `${organizationName ?? "Organization"} · ${organizationSettingsLabel(organizationSection ?? "identity")}`
      : location.kind === "account"
        ? "Your account"
        : `${workspaceName ?? "Workspace"} · ${workspacePageLabel(location)}`;
  const here = location.kind === "account" ? undefined : currentPageReturnTo(hereLabel);

  // The same picker as the main rail: switching workspace or organization keeps
  // the same kind of settings page. A workspace managed without access has none.
  const picker =
    workspace && !managedWorkspace ? (
      <WorkspaceSwitcherMenu
        workspaceId={workspace.id}
        collapsed={false}
        align="start"
        onSelect={openWorkspace}
        className="w-full"
      />
    ) : null;

  const personal = isPersonalWorkspace(workspace, context.managedSelfContext);
  const sections: SettingsRailSection[] = [];

  if (managedWorkspace) {
    sections.push({
      id: "workspace",
      label: "Workspace",
      meta: `${managedWorkspace.name} · Organization management`,
      groups: [
        {
          items: (["general", "access"] as const).map((section) => ({
            id: `workspace:${section}`,
            label: WORKSPACE_SETTINGS_COPY[section].title,
            icon: SECTION_ICONS[section],
            link: (
              <Link
                to="/workspaces/$workspaceId/settings"
                params={{ workspaceId: managedWorkspace.id }}
                search={{ section }}
              />
            ),
          })),
        },
      ],
    });
  } else if (workspace) {
    const workspaceId = workspace.id;
    const canReadInsights = hasWorkspacePermission(
      context.accessContext,
      workspaceId,
      "workspace:admin",
    );
    const activityPages = ACTIVITY_PAGES.filter((page) => !page.requiresAdmin || canReadInsights);
    sections.push({
      id: "workspace",
      // The picker names the workspace; the header only names the scope.
      label: "Workspace",
      // Two groups set apart by space, no labels: the workspace's own settings and
      // dashboards, then the runtime it runs on.
      groups: [
        {
          items: [
            // Nobody administers a Personal workspace, so its API keys and
            // Developer pages could only say they aren't available.
            ...SECTION_ORDER.filter(
              (section) => !personal || (section !== "api-keys" && section !== "developer"),
            ).map((section) => ({
              id: `workspace:${section}`,
              label: WORKSPACE_SETTINGS_COPY[section].title,
              icon: SECTION_ICONS[section],
              link: (
                <Link
                  to="/workspaces/$workspaceId/settings"
                  params={{ workspaceId }}
                  search={{ section }}
                />
              ),
            })),
            ...activityPages.map((page) => ({
              id: `workspace:${page.to}`,
              label: page.label,
              icon: page.icon,
              link: <Link to={page.to} params={{ workspaceId }} />,
            })),
          ],
        },
        {
          items: RUNTIME_PAGES.map((page) => ({
            id: `workspace:${page.to}`,
            label: page.label,
            icon: page.icon,
            link: <Link to={page.to} params={{ workspaceId }} />,
          })),
        },
      ],
    });
  }

  if (accountId && organizationName && access) {
    const anchor = organizationWorkspaceId;
    sections.push({
      id: "organization",
      label: "Organization",
      // Without a picker (a workspace managed without access), or without a
      // workspace to open its pages through, the header names it.
      ...(picker && anchor ? {} : { meta: organizationName }),
      // Two groups set apart by space: the organization and its people, then
      // what it provides, pays for and protects. A short list (a member's two
      // pages) stays one group rather than two lone rows.
      groups: anchor
        ? splitIntoGroups(
            ORGANIZATION_SETTINGS_GROUPS.map((group) =>
              ORGANIZATION_SETTINGS_ITEMS.filter(
                (item) => group.includes(item.id) && access.visibleSections.has(item.id),
              ).map((item) => ({
                id: `organization:${item.id}`,
                label: item.label,
                icon: item.icon,
                link: (
                  <Link
                    to="/workspaces/$workspaceId/organization"
                    params={{ workspaceId: anchor }}
                    search={{ section: item.id }}
                    aria-label={`${item.label}, ${organizationName} organization settings`}
                  />
                ),
              })),
            ),
          )
        : [],
    });
  }

  if (context.clientConfig.auth.mode === "managedSession") {
    // Your account opens outside workspace settings; its back link returns here.
    sections.push({
      id: "account",
      label: "Your account",
      groups: [
        {
          items: [
            {
              id: "account:security",
              label: "Security",
              icon: ShieldCheckIcon,
              link: <Link to="/settings/security" search={returnToSearch(here)} />,
            },
          ],
        },
      ],
    });
  }

  // Leaving settings returns to the sessions settings were opened from.
  const sessionsWorkspaceId = managedWorkspace
    ? (managedWorkspace.organizationSettingsWorkspaceId ?? null)
    : (workspace?.id ?? null);
  const back = sessionsWorkspaceId
    ? {
        label: "Back to sessions",
        link: (
          <Link
            to="/workspaces/$workspaceId/sessions"
            params={{ workspaceId: sessionsWorkspaceId }}
          />
        ),
      }
    : { label: "Back to Opengeni", link: <Link to="/" /> };

  return {
    picker,
    sections,
    back,
    home: settingsHomeLink(sessionsWorkspaceId ?? undefined),
    organizationName,
    workspaceName,
    organizationSection,
    scopeOf: (at) => {
      if (at.kind === "account") return "Your account";
      if (at.kind === "organization") {
        return organizationName ? `Organization · ${organizationName}` : "Organization";
      }
      if (!workspaceName) return "Workspace";
      return `${personal ? "Personal workspace" : "Workspace"} · ${workspaceName}`;
    },
  };
}
