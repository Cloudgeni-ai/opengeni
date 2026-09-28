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
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
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
} from "lucide-react";
import type { ReactNode } from "react";

import {
  SettingsFrame,
  SettingsFrameOutLink,
  type SettingsFrameGroup,
  type SettingsFramePage,
} from "./settings-frame";
import { NavItem } from "@/components/ui/settings-nav";
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
} as const;

// Agent learning is still a settings URL, but it opens the Learning page of Knowledge.
const SECTION_ORDER: readonly WorkspaceSettingsSection[] = [
  "general",
  "access",
  "models",
  "api-keys",
];

// Workspace dashboards reached from settings, as before settings moved into the
// content area. They open as their own full-width pages.
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
   * name, access and deletion, and no main rail.
   */
  organizationManagementOnly?: boolean;
  organizationSettingsWorkspaceId?: string;
  children: ReactNode;
}) {
  const context = useAppContext();
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

  const groups: SettingsFrameGroup[] = [
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
  if (!organizationManagementOnly) {
    groups.push({
      label: "Workspace activity",
      items: ACTIVITY_PAGES.filter((page) => !page.requiresAdmin || canReadInsights).map(
        (page) => ({
          id: page.to,
          label: page.label,
          icon: page.icon,
          link: <Link to={page.to} params={{ workspaceId }} />,
        }),
      ),
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

  const indexRequested = location.kind === "settings" && location.section === null;
  const section: WorkspaceSettingsSection | null =
    location.kind === "settings" ? (location.section ?? "general") : null;
  const page: SettingsFramePage | null =
    section && !isSubPage(section, search)
      ? {
          title: WORKSPACE_SETTINGS_COPY[section].title,
          description: WORKSPACE_SETTINGS_COPY[section].description?.(names),
        }
      : null;

  const frame = (
    <SettingsFrame
      label="Workspace settings"
      heading="Settings"
      subheading={workspaceName}
      groups={groups}
      activeId={location.kind === "settings" ? section : location.target}
      indexRequested={indexRequested}
      indexLink={<Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} />}
      header={
        organizationManagementOnly && organizationSettingsWorkspaceId ? (
          <NavItem asChild label="Organization settings" icon={<ArrowLeftIcon />}>
            <Link
              to="/workspaces/$workspaceId/organization"
              params={{ workspaceId: organizationSettingsWorkspaceId }}
            />
          </NavItem>
        ) : undefined
      }
      footer={
        <SettingsFrameOutLink
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
      page={page}
      ownBackLink={Boolean(section) && page === null}
    >
      {children}
    </SettingsFrame>
  );

  if (!organizationManagementOnly) return frame;
  // No workspace access means no main rail: the frame is the whole canvas.
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg text-fg">
      {frame}
    </div>
  );
}

/**
 * The body of one workspace settings page. The page header lives in the
 * settings frame (`WorkspaceManagementShell`), so the body is only the content.
 */
export function WorkspaceSettingsContent({ children }: { children: ReactNode }) {
  return <div className="min-w-0">{children}</div>;
}
