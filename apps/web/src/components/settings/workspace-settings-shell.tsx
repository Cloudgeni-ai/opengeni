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
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BarChart3Icon,
  BotIcon,
  BoxIcon,
  BoxesIcon,
  Building2Icon,
  ChevronRightIcon,
  DatabaseIcon,
  KeyRoundIcon,
  LaptopIcon,
  PlugIcon,
  Settings2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import {
  SettingsSidebar,
  SETTINGS_SHELL_CLASS,
  SETTINGS_NAV_CLASS,
  settingsNavItemClass,
} from "./settings-sidebar";
import { WorkspaceSwitcherMenu } from "@/components/rail/workspace-switcher";
import { SETTINGS_SWITCHER_CLASS } from "@/components/ui/scope-switcher-trigger";
import { ContentPage } from "@/components/ui/content-layout";
import { useAppContext } from "@/context";
import { cn } from "@/lib/utils";

type SettingsItem = {
  id: WorkspaceSettingsSection;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const SETTINGS_ITEMS: readonly SettingsItem[] = [
  { id: "general", label: "General", icon: Settings2Icon },
  { id: "learning", label: "Agent learning", icon: BotIcon },
  { id: "members", label: "Members", icon: UsersIcon },
  { id: "models", label: "Models", icon: SparklesIcon },
  { id: "tools", label: "Agent tools", icon: ShieldCheckIcon },
  { id: "plugins", label: "Plugins", icon: PlugIcon },
  { id: "api-keys", label: "API keys", icon: KeyRoundIcon },
  { id: "danger", label: "Danger zone", icon: ShieldAlertIcon },
];

const SECTION_COPY: Record<WorkspaceSettingsSection, { title: string; description: string }> = {
  general: {
    title: "General",
    description: "Workspace identity and defaults for new sessions.",
  },
  learning: {
    title: "Agent learning",
    description: "Defaults and exceptions for Knowledge, workspace instructions, and Skills.",
  },
  members: {
    title: "Members",
    description: "Manage who can access this workspace and what they can do.",
  },
  tools: {
    title: "Agent tools",
    description: "Choose which built-in OpenGeni tools new sessions can use.",
  },
  plugins: {
    title: "Plugins",
    description: "Choose which plugins new sessions may use when they are available.",
  },
  models: {
    title: "Models",
    description: "Control which models can run in this workspace.",
  },
  "api-keys": {
    title: "API keys",
    description: "Create workspace-scoped credentials for other products.",
  },
  danger: {
    title: "Danger zone",
    description: "Irreversible workspace actions.",
  },
};

const WORKSPACE_PAGE_GROUPS = [
  {
    label: "Workspace activity",
    items: [
      {
        to: "/workspaces/$workspaceId/agents" as const,
        label: "Agents",
        icon: BotIcon,
      },
      {
        to: "/workspaces/$workspaceId/insights" as const,
        label: "Insights",
        icon: BarChart3Icon,
      },
    ],
  },
  {
    label: "Knowledge",
    items: [
      {
        to: "/workspaces/$workspaceId/memory" as const,
        label: "Agent Knowledge",
        icon: DatabaseIcon,
      },
    ],
  },
  {
    label: "Runtime",
    items: [
      {
        to: "/workspaces/$workspaceId/variable-sets" as const,
        label: "Credentials & variables",
        icon: BoxesIcon,
      },
      {
        to: "/workspaces/$workspaceId/rigs" as const,
        label: "Rigs",
        icon: BoxIcon,
      },
      {
        to: "/workspaces/$workspaceId/machines" as const,
        label: "Machines",
        icon: LaptopIcon,
      },
    ],
  },
] as const;

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
  organizationManagementOnly?: boolean;
  organizationSettingsWorkspaceId?: string;
  children: ReactNode;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const settingsItems = organizationManagementOnly
    ? SETTINGS_ITEMS.filter(
        (item) => item.id === "general" || item.id === "members" || item.id === "danger",
      )
    : SETTINGS_ITEMS;
  const organizationLinkWorkspaceId =
    organizationSettingsWorkspaceId ?? (organizationManagementOnly ? undefined : workspaceId);
  const switcherWorkspaceId = organizationManagementOnly
    ? (organizationSettingsWorkspaceId ?? context.workspaces[0]?.id)
    : workspaceId;

  function openManagementWorkspace(nextWorkspaceId: string) {
    context.resetSessionView();
    if (location.kind === "settings") {
      void navigate({
        to: "/workspaces/$workspaceId/settings",
        params: { workspaceId: nextWorkspaceId },
        search: { section: location.section },
      });
      return;
    }
    void navigate({
      to: location.target,
      params: { workspaceId: nextWorkspaceId },
    });
  }
  return (
    <div className={SETTINGS_SHELL_CLASS}>
      <SettingsSidebar
        workspaceId={organizationManagementOnly ? undefined : workspaceId}
        label="Workspace settings"
        currentPage={
          location.kind === "settings"
            ? SECTION_COPY[location.section].title
            : (WORKSPACE_PAGE_GROUPS.map(
                (group) => group.items.find((item) => item.to === location.target)?.label,
              ).find(Boolean) ?? "Workspace settings")
        }
        identity={
          organizationManagementOnly ? (
            <>
              <div className="mt-2 flex min-w-0 items-center gap-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-brand/25 bg-brand-strong/15 text-sm font-semibold text-brand">
                  {workspaceName?.trim().charAt(0).toUpperCase() || "W"}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold leading-tight tracking-tight text-fg">
                    {workspaceName ?? "Workspace"}
                  </p>
                  <p className="mt-0.5 text-2xs text-fg-subtle">Organization management</p>
                </div>
              </div>
              {switcherWorkspaceId ? (
                <div className="mt-3 min-w-0">
                  <p className="mb-1 px-1 text-2xs text-fg-subtle">Open another workspace</p>
                  <WorkspaceSwitcherMenu
                    workspaceId={switcherWorkspaceId}
                    collapsed={false}
                    align="start"
                    onSelect={openManagementWorkspace}
                    className="w-full"
                  />
                </div>
              ) : null}
            </>
          ) : (
            <div className="mt-2 min-w-0">
              <WorkspaceSwitcherMenu
                workspaceId={workspaceId}
                collapsed={false}
                align="start"
                onSelect={openManagementWorkspace}
                className={SETTINGS_SWITCHER_CLASS}
              />
              <p className="mt-1.5 px-1 text-2xs text-fg-subtle">Settings and controls</p>
            </div>
          )
        }
      >
        <p className="mt-3 px-2.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
          Settings
        </p>
        <nav aria-label="Workspace settings" className={SETTINGS_NAV_CLASS}>
          {settingsItems.map((item) => {
            const Icon = item.icon;
            const selected = location.kind === "settings" && item.id === location.section;
            return (
              <Link
                key={item.id}
                to="/workspaces/$workspaceId/settings"
                params={{ workspaceId }}
                search={{ section: item.id }}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  settingsNavItemClass(selected),
                  item.id === "danger" && selected ? "text-danger" : "",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {!organizationManagementOnly
          ? WORKSPACE_PAGE_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="mt-4 px-2.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                  {group.label}
                </p>
                <nav aria-label={group.label} className={SETTINGS_NAV_CLASS}>
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const selected = location.kind === "page" && item.to === location.target;
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        params={{ workspaceId }}
                        aria-current={selected ? "page" : undefined}
                        className={cn(settingsNavItemClass(selected))}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      </Link>
                    );
                  })}
                </nav>
              </div>
            ))
          : null}

        <div className="mt-4 border-t border-border pt-3">
          <p className="px-2.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
            Organization
          </p>
          {organizationLinkWorkspaceId ? (
            <Link
              to="/workspaces/$workspaceId/organization"
              params={{ workspaceId: organizationLinkWorkspaceId }}
              aria-label={`Organization settings for ${organizationName}`}
              className="mt-1 flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2.5 text-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <Building2Icon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{organizationName}</span>
              <ChevronRightIcon className="size-3.5 shrink-0 text-fg-subtle" />
            </Link>
          ) : (
            <div className="mt-1 flex min-h-9 min-w-0 items-center gap-2 px-2.5 text-sm text-fg-muted">
              <Building2Icon className="size-4 shrink-0" />
              <span className="truncate">{organizationName}</span>
            </div>
          )}
        </div>
      </SettingsSidebar>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}

export function WorkspaceSettingsContent({
  section,
  children,
}: {
  section: WorkspaceSettingsSection;
  children: ReactNode;
}) {
  const copy = SECTION_COPY[section];
  return (
    <ContentPage width="standard">
      <header className="border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-1.5 text-sm text-fg-muted">{copy.description}</p>
      </header>
      <div className="py-6">{children}</div>
    </ContentPage>
  );
}
