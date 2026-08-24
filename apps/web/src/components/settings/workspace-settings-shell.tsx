import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BoxesIcon,
  Building2Icon,
  KeyRoundIcon,
  PlugZapIcon,
  Settings2Icon,
  ShieldAlertIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

export type WorkspaceSettingsSection =
  | "general"
  | "members"
  | "capabilities"
  | "models"
  | "connections"
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
  { id: "capabilities", label: "Capabilities", icon: BoxesIcon },
  { id: "models", label: "Models", icon: SparklesIcon },
  { id: "connections", label: "Connections", icon: PlugZapIcon },
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
  capabilities: {
    title: "Capabilities",
    description: "Choose what new sessions can use by default.",
  },
  models: {
    title: "Models",
    description: "Control which models can run in this workspace.",
  },
  connections: {
    title: "Connections",
    description: "Connect model subscriptions and inference providers.",
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

export function WorkspaceSettingsShell({
  workspaceId,
  workspaceName,
  organizationLabel,
  section,
  children,
}: {
  workspaceId: string;
  workspaceName: string;
  organizationLabel: string;
  section: WorkspaceSettingsSection;
  children: ReactNode;
}) {
  const copy = SECTION_COPY[section];
  return (
    <main className="min-h-dvh bg-bg text-fg lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="border-b border-border bg-surface/35 lg:sticky lg:top-0 lg:h-dvh lg:border-r lg:border-b-0">
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
            <p className="text-base font-semibold">Settings</p>
            <p className="mt-1 truncate text-xs text-fg-muted">{workspaceName}</p>
          </div>

          <nav
            aria-label="Workspace settings"
            className="mt-3 flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0"
          >
            {SETTINGS_ITEMS.map((item) => {
              const Icon = item.icon;
              const selected = item.id === section;
              return (
                <Link
                  key={item.id}
                  to="/workspaces/$workspaceId/settings"
                  params={{ workspaceId }}
                  search={{ section: item.id }}
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm transition-colors lg:w-full",
                    selected
                      ? "bg-surface-3 font-medium text-fg"
                      : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                    item.id === "danger" && selected ? "text-danger" : "",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-4 border-t border-border pt-3 lg:mt-auto">
            <p className="px-2.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Organization
            </p>
            <Link
              to="/workspaces/$workspaceId/organization"
              params={{ workspaceId }}
              search={{ section: "overview" }}
              className="mt-1 flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <Building2Icon className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{organizationLabel}</span>
            </Link>
          </div>
        </div>
      </aside>

      <div className="min-w-0 px-4 py-7 sm:px-8 lg:px-12 lg:py-10">
        <div className="mx-auto max-w-4xl">
          <header className="border-b border-border pb-5">
            <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
            <p className="mt-1.5 text-sm text-fg-muted">{copy.description}</p>
          </header>
          <div className="py-6">{children}</div>
        </div>
      </div>
    </main>
  );
}
