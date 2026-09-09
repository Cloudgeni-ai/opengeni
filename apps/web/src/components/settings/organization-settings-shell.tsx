import { Link } from "@tanstack/react-router";
import {
  BrainCircuitIcon,
  Code2Icon,
  CreditCardIcon,
  CpuIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { OrganizationSettingsSwitcher } from "./organization-settings-switcher";
import {
  SettingsSidebar,
  SETTINGS_SHELL_CLASS,
  SETTINGS_NAV_CLASS,
  settingsNavItemClass,
} from "./settings-sidebar";
import type { OrganizationAdminSection } from "@/lib/organization-admin";

type OrganizationSettingsItem = {
  id: OrganizationAdminSection;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const ITEMS: readonly OrganizationSettingsItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboardIcon },
  { id: "knowledge", label: "Knowledge", icon: BrainCircuitIcon },
  { id: "models", label: "Models", icon: CpuIcon },
  { id: "people", label: "People & invitations", icon: UsersIcon },
  { id: "recovery", label: "Recovery", icon: ShieldCheckIcon },
  { id: "retention", label: "Retention", icon: DatabaseIcon },
  { id: "developer", label: "Developer", icon: Code2Icon },
  { id: "billing", label: "Billing", icon: CreditCardIcon },
];

const COPY: Record<OrganizationAdminSection, { title: string; description: string }> = {
  overview: {
    title: "Overview",
    description: "Identity, workspaces, access, and organization-wide session policy.",
  },
  knowledge: {
    title: "Knowledge",
    description:
      "Set the small identity agents always know and explore company knowledge they retrieve when relevant.",
  },
  models: {
    title: "Models",
    description: "Manage subscriptions and provider accounts shared with your workspaces.",
  },
  people: {
    title: "People & invitations",
    description: "Manage organization membership, roles, invitations, and workspace access.",
  },
  recovery: {
    title: "Recovery",
    description: "Configure recovery custody and review protected co-owner promotion operations.",
  },
  retention: {
    title: "Retention",
    description: "Control how long organization data is retained.",
  },
  developer: {
    title: "Developer",
    description: "Connect your product to every organization workspace.",
  },
  billing: {
    title: "Billing",
    description: "Credits, usage, plan entitlements, and payment settings.",
  },
};

export function OrganizationSettingsShell({
  workspaceId,
  organizationLabel,
  section,
  showModels,
  children,
}: {
  workspaceId: string;
  organizationLabel: string;
  section: OrganizationAdminSection;
  showModels: boolean;
  children: ReactNode;
}) {
  const copy = COPY[section];
  return (
    <div data-workspace-scroll-owner="self-managed" className={SETTINGS_SHELL_CLASS}>
      <a
        href="#organization-settings-content"
        className="sr-only z-50 rounded-md bg-bg px-3 py-2 text-sm font-medium text-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus-visible:ring-2 focus-visible:ring-brand"
      >
        Skip to organization settings
      </a>
      <SettingsSidebar
        workspaceId={workspaceId}
        label="Organization settings"
        currentPage={copy.title}
        identity={
          <div className="mt-2 min-w-0">
            <OrganizationSettingsSwitcher
              workspaceId={workspaceId}
              organizationLabel={organizationLabel}
              section={section}
            />
            <p className="mt-1.5 px-1 text-2xs text-fg-subtle">Settings and governance</p>
          </div>
        }
      >
        <p className="mt-3 px-2.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
          Settings
        </p>
        <nav aria-label="Organization settings" className={SETTINGS_NAV_CLASS}>
          {ITEMS.filter((item) => item.id !== "models" || showModels).map((item) => {
            const Icon = item.icon;
            const selected = item.id === section;
            return (
              <Link
                key={item.id}
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId }}
                search={{ section: item.id }}
                aria-current={selected ? "page" : undefined}
                className={settingsNavItemClass(selected)}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </SettingsSidebar>

      <main
        id="organization-settings-content"
        className="min-h-0 min-w-0 overflow-y-auto overscroll-y-contain px-4 py-5 sm:px-8 lg:px-12 lg:py-10"
      >
        <div className="mx-auto max-w-5xl">
          <header className="border-b border-border pb-5">
            <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-brand">
              {organizationLabel}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
            <p className="mt-1.5 text-sm text-fg-muted">{copy.description}</p>
          </header>
          <div className="py-6">{children}</div>
        </div>
      </main>
    </div>
  );
}
