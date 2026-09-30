import {
  type WorkspaceSettingsSection,
  type WorkspaceManagementLocation,
} from "@/lib/workspace-management-location";
export {
  workspaceManagementLocation,
  workspaceSettingsSectionFromSearch,
  type WorkspaceSettingsSection,
  type WorkspaceManagementLocation,
} from "@/lib/workspace-management-location";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BarChart3Icon,
  BotIcon,
  Building2Icon,
  ContainerIcon,
  GraduationCapIcon,
  KeyRoundIcon,
  LaptopIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UsersIcon,
  VariableIcon,
  WebhookIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  SettingsRailOutLink,
  SettingsShell,
  settingsHomeLink,
  type SettingsRailGroup,
  type SettingsShellPage,
} from "./settings-sidebar";
import { WorkspacePausedBanner } from "@/components/rail/workspace-paused-banner";
import { WorkspaceSwitcherMenu } from "@/components/rail/workspace-switcher";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";

/** One name, one icon and one description per settings page. */
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
  models: {
    title: "Models",
    description: () => "Which models this workspace can use, and who pays for them.",
  },
  "api-keys": {
    title: "API keys",
    description: () => "Keys that let your own tools start work in this workspace.",
  },
  developer: {
    title: "Developer",
    description: () => "Webhooks and a credential provider for products built on this workspace.",
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
  developer: WebhookIcon,
} as const;

// Agent learning is still a settings URL, but it opens the Learning page of Knowledge.
const SECTION_ORDER: readonly WorkspaceSettingsSection[] = [
  "general",
  "access",
  "models",
  "api-keys",
  "developer",
];

// Workspace dashboards in the settings rail. They open as their own pages.
const ACTIVITY_PAGES = [
  {
    to: "/workspaces/$workspaceId/agents" as const,
    label: "Agents",
    icon: BotIcon,
    requiresAdmin: false,
  },
  {
    to: "/workspaces/$workspaceId/insights" as const,
    label: "Insights",
    icon: BarChart3Icon,
    requiresAdmin: true,
  },
] as const;

const RUNTIME_PAGES = [
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

/** Sub-pages (an account, a key, a form) bring their own back link and title. */
function isSubPage(section: WorkspaceSettingsSection, search: Record<string, unknown>): boolean {
  if (section === "models") return Boolean(search.account || search.view);
  if (section === "api-keys") return Boolean(search.key);
  if (section === "access") return Boolean(search.view);
  if (section === "general") return search.view === "agent-defaults";
  return false;
}

export function WorkspaceManagementShell({
  workspaceId,
  workspaceName,
  organizationName,
  location,
  organizationManagementOnly = false,
  organizationSettingsWorkspaceId,
  children,
}: {
  workspaceId: string;
  workspaceName?: string;
  organizationName: string;
  location: WorkspaceManagementLocation;
  /**
   * An organization administrator without access to this workspace: only its
   * name, access and deletion.
   */
  organizationManagementOnly?: boolean;
  organizationSettingsWorkspaceId?: string;
  children: ReactNode;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const canReadInsights = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );
  const search = useRouterState({
    select: (state) => state.location.search as Record<string, unknown>,
  });
  const names = {
    workspace: workspaceName ?? "this workspace",
    organization: organizationName,
  };
  const sections = organizationManagementOnly
    ? SECTION_ORDER.filter((section) => section === "general" || section === "access")
    : SECTION_ORDER;

  const groups: SettingsRailGroup[] = [
    {
      items: sections.map((section) => ({
        id: section,
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
    },
  ];
  const activityPages = organizationManagementOnly
    ? []
    : ACTIVITY_PAGES.filter((page) => !page.requiresAdmin || canReadInsights);
  if (!organizationManagementOnly) {
    groups.push({
      label: "Workspace activity",
      items: activityPages.map((page) => ({
        id: page.to,
        label: page.label,
        icon: page.icon,
        link: <Link to={page.to} params={{ workspaceId }} />,
      })),
    });
    groups.push({
      label: "Runtime",
      items: RUNTIME_PAGES.map((page) => ({
        id: page.to,
        label: page.label,
        icon: page.icon,
        link: <Link to={page.to} params={{ workspaceId }} />,
      })),
    });
  }

  const organizationLinkWorkspaceId =
    organizationSettingsWorkspaceId ?? (organizationManagementOnly ? undefined : workspaceId);

  const section: WorkspaceSettingsSection | null =
    location.kind === "settings" ? (location.section ?? "general") : null;
  const page: SettingsShellPage | null =
    section && !isSubPage(section, search)
      ? {
          title: WORKSPACE_SETTINGS_COPY[section].title,
          description: WORKSPACE_SETTINGS_COPY[section].description?.(names),
        }
      : null;
  const currentPage = section
    ? WORKSPACE_SETTINGS_COPY[section].title
    : ([...activityPages, ...RUNTIME_PAGES].find(
        (candidate) => location.kind === "page" && candidate.to === location.target,
      )?.label ?? "Settings");

  function openWorkspace(nextWorkspaceId: string) {
    context.resetSessionView();
    if (location.kind === "settings") {
      void navigate({
        to: "/workspaces/$workspaceId/settings",
        params: { workspaceId: nextWorkspaceId },
        search: location.section ? { section: location.section } : {},
      });
      return;
    }
    void navigate({ to: location.target, params: { workspaceId: nextWorkspaceId } });
  }

  // An organization administrator without workspace access has no sessions
  // here: the way back is organization settings (or OpenGeni).
  const back =
    organizationManagementOnly && organizationSettingsWorkspaceId
      ? {
          label: "Organization settings",
          link: (
            <Link
              to="/workspaces/$workspaceId/organization"
              params={{ workspaceId: organizationSettingsWorkspaceId }}
            />
          ),
        }
      : organizationManagementOnly
        ? { label: "Back to OpenGeni", link: <Link to="/" /> }
        : {
            label: "Back to sessions",
            link: <Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId }} />,
          };

  return (
    <SettingsShell
      label="Workspace settings"
      back={back}
      home={settingsHomeLink(
        organizationManagementOnly ? organizationSettingsWorkspaceId : workspaceId,
      )}
      scope={
        organizationManagementOnly ? (
          <div className="min-w-0 px-2.5">
            <p className="truncate text-sm leading-5 font-semibold text-fg">
              {workspaceName ?? "Workspace"}
            </p>
            <p className="text-xs leading-4.5 text-fg-subtle">Organization management</p>
          </div>
        ) : (
          <WorkspaceSwitcherMenu
            workspaceId={workspaceId}
            collapsed={false}
            align="start"
            onSelect={openWorkspace}
            className="w-full"
          />
        )
      }
      groups={groups}
      activeId={location.kind === "settings" ? section : location.target}
      footer={
        <SettingsRailOutLink
          groupLabel="Organization"
          label={organizationName}
          icon={Building2Icon}
          link={
            organizationLinkWorkspaceId ? (
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId: organizationLinkWorkspaceId }}
                aria-label={`Organization settings for ${organizationName}`}
              />
            ) : undefined
          }
        />
      }
      currentPage={currentPage}
      page={page}
      layout={location.kind === "page" ? "page" : "settings"}
      notice={
        organizationManagementOnly ? undefined : <WorkspacePausedBanner workspaceId={workspaceId} />
      }
    >
      {children}
    </SettingsShell>
  );
}

/**
 * The body of one workspace settings page. The page header lives in the
 * settings shell (`WorkspaceManagementShell`), so the body is only the content.
 */
export function WorkspaceSettingsContent({ children }: { children: ReactNode }) {
  return <div className="min-w-0">{children}</div>;
}
