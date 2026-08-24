import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BarChart3Icon,
  BookOpenIcon,
  BotIcon,
  BoxIcon,
  BoxesIcon,
  BrainCircuitIcon,
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

import { BrandMark } from "@/components/brand-mark";
import { ContentPage } from "@/components/ui/content-layout";
import { cn } from "@/lib/utils";

export type WorkspaceSettingsSection =
  | "general"
  | "members"
  | "tools"
  | "plugins"
  | "models"
  | "api-keys"
  | "danger";

type SettingsItem = {
  id: WorkspaceSettingsSection;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const SETTINGS_ITEMS: readonly SettingsItem[] = [
  { id: "general", label: "General", icon: Settings2Icon },
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
        to: "/workspaces/$workspaceId/documents" as const,
        label: "Documents",
        icon: BookOpenIcon,
      },
      {
        to: "/workspaces/$workspaceId/memory" as const,
        label: "Memory",
        icon: DatabaseIcon,
      },
      {
        to: "/workspaces/$workspaceId/state" as const,
        label: "Company Brain",
        icon: BrainCircuitIcon,
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

type WorkspacePageTarget = (typeof WORKSPACE_PAGE_GROUPS)[number]["items"][number]["to"];

export type WorkspaceManagementLocation =
  | { kind: "settings"; section: WorkspaceSettingsSection }
  | { kind: "page"; target: WorkspacePageTarget };

const DEFAULT_SETTINGS_SECTION: WorkspaceSettingsSection = "general";

export function workspaceSettingsSectionFromSearch(value: unknown): WorkspaceSettingsSection {
  return value === "members" ||
    value === "tools" ||
    value === "plugins" ||
    value === "models" ||
    value === "api-keys" ||
    value === "danger"
    ? value
    : DEFAULT_SETTINGS_SECTION;
}

/**
 * Resolve the workspace routes that share the persistent management shell.
 * Keep matching segment-aware: `/rigs/:rigId` belongs to Rigs, while a future
 * `/rigs-archive` route must not be captured accidentally.
 */
export function workspaceManagementLocation(
  pathname: string,
  workspaceId: string,
  settingsSection?: unknown,
): WorkspaceManagementLocation | null {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  if (pathname === `${base}/settings`) {
    return {
      kind: "settings",
      section: workspaceSettingsSectionFromSearch(settingsSection),
    };
  }

  for (const group of WORKSPACE_PAGE_GROUPS) {
    for (const item of group.items) {
      const targetPath = item.to.replace("$workspaceId", encodeURIComponent(workspaceId));
      if (
        pathname === targetPath ||
        (item.to.endsWith("/rigs") && pathname.startsWith(`${targetPath}/`))
      ) {
        return { kind: "page", target: item.to };
      }
    }
  }
  return null;
}

export function WorkspaceManagementShell({
  workspaceId,
  workspaceName,
  location,
  children,
}: {
  workspaceId: string;
  workspaceName: string;
  location: WorkspaceManagementLocation;
  children: ReactNode;
}) {
  return (
    <main className="grid h-dvh min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-bg text-fg lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-1">
      <aside className="max-h-[50dvh] min-h-0 overflow-y-auto overscroll-y-contain border-b border-border bg-surface/35 lg:h-dvh lg:max-h-none lg:border-r lg:border-b-0">
        <div className="flex h-full min-h-0 flex-col px-3 py-3 lg:py-4">
          <Link
            to="/workspaces/$workspaceId/sessions"
            params={{ workspaceId }}
            className="flex h-9 items-center gap-2 rounded-md px-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-2"
          >
            <span className="flex size-6 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
              <BrandMark className="size-4" />
            </span>
            OpenGeni
          </Link>

          <Link
            to="/workspaces/$workspaceId/sessions"
            params={{ workspaceId }}
            className="mt-3 inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg lg:mt-5"
          >
            <ArrowLeftIcon className="size-3.5" />
            Back to sessions
          </Link>

          <div className="mt-4 min-w-0 px-2 lg:mt-6">
            <p className="text-base font-semibold">Workspace</p>
            <p className="mt-1 truncate text-xs text-fg-muted">{workspaceName}</p>
          </div>

          <p className="mt-3 px-2.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
            Settings
          </p>
          <nav
            aria-label="Workspace settings"
            className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-3 lg:flex lg:flex-col"
          >
            {SETTINGS_ITEMS.map((item) => {
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
                    "flex h-9 min-w-0 items-center gap-2 rounded-md px-2.5 text-sm transition-colors lg:w-full",
                    selected
                      ? "bg-surface-3 font-medium text-fg"
                      : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                    item.id === "danger" && selected ? "text-danger" : "",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          {WORKSPACE_PAGE_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="mt-4 px-2.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                {group.label}
              </p>
              <nav
                aria-label={group.label}
                className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-3 lg:flex lg:flex-col"
              >
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const selected = location.kind === "page" && item.to === location.target;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      params={{ workspaceId }}
                      aria-current={selected ? "page" : undefined}
                      className={cn(
                        "flex h-9 min-w-0 items-center gap-2 rounded-md px-2.5 text-sm transition-colors lg:w-full",
                        selected
                          ? "bg-surface-3 font-medium text-fg"
                          : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </nav>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </main>
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
