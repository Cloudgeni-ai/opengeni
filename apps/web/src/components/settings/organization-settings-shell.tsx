import { Link } from "@tanstack/react-router";
import {
  BlocksIcon,
  CodeIcon,
  CpuIcon,
  CreditCardIcon,
  FingerprintIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SquareStackIcon,
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
import { ContentPage } from "@/components/ui/content-layout";
import { PageHeader } from "@/components/ui/page-header";
import { useAppContext } from "@/context";
import { organizationsForSubject } from "@/lib/org";
import type { OrganizationAdminSection } from "@/lib/organization-admin";

type OrganizationSettingsItem = {
  id: OrganizationAdminSection;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

export const ORGANIZATION_SETTINGS_ITEMS: readonly OrganizationSettingsItem[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "people", label: "People", icon: UsersIcon },
  { id: "workspaces", label: "Workspaces", icon: SquareStackIcon },
  { id: "models", label: "Models", icon: CpuIcon },
  { id: "integrations", label: "Integrations", icon: BlocksIcon },
  { id: "identity", label: "Organization identity", icon: FingerprintIcon },
  { id: "billing", label: "Billing & usage", icon: CreditCardIcon },
  { id: "developer", label: "Developer", icon: CodeIcon },
  { id: "security", label: "Security & data", icon: ShieldIcon },
];

function description(section: OrganizationAdminSection, organizationName: string): string {
  switch (section) {
    case "general":
      return "The organization's name and ID.";
    case "people":
      return `Everyone in ${organizationName}, with one role each and a private Personal workspace.`;
    case "workspaces":
      return `Shared workspaces in ${organizationName}. Everyone also has a private Personal workspace.`;
    case "models":
      return "Subscriptions and API keys the organization pays for, and which workspaces can use them.";
    case "integrations":
      return "Which integrations workspaces can connect.";
    case "identity":
      return "Who the organization is and what it does, for every agent.";
    case "billing":
      return "Credits, plan and usage by workspace.";
    case "developer":
      return "Organization API keys and the integration guide.";
    case "security":
      return "Private chats, how long data is kept, and recovery.";
  }
}

export function OrganizationSettingsShell({
  workspaceId,
  organizationLabel,
  section,
  visibleSections,
  actions,
  hideHeader = false,
  children,
}: {
  workspaceId: string;
  organizationLabel: string;
  section: OrganizationAdminSection;
  /** Pages this person can use. The rest are hidden. */
  visibleSections: ReadonlySet<OrganizationAdminSection>;
  /** The page's one primary action, in the header. */
  actions?: ReactNode;
  /** A sub-page (a person, a workspace, a form) brings its own back link and title. */
  hideHeader?: boolean;
  children: ReactNode;
}) {
  const context = useAppContext();
  const organizationCount = organizationsForSubject(
    context.accessContext,
    context.workspaces,
  ).length;
  const items = ORGANIZATION_SETTINGS_ITEMS.filter((item) => visibleSections.has(item.id));
  const current = ORGANIZATION_SETTINGS_ITEMS.find((item) => item.id === section)!;
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
        backToWorkspaceSettings
        label="Organization"
        currentPage={current.label}
        identity={
          organizationCount > 1 ? (
            <div className="mt-2 min-w-0">
              <OrganizationSettingsSwitcher
                workspaceId={workspaceId}
                organizationLabel={organizationLabel}
                section={section}
              />
            </div>
          ) : (
            <p className="mt-1 truncate text-sm leading-5 font-semibold text-fg">
              {organizationLabel}
            </p>
          )
        }
      >
        <nav aria-label="Organization settings" className={SETTINGS_NAV_CLASS}>
          {items.map((item) => {
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

      <main id="organization-settings-content" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ContentPage width="standard">
          {hideHeader ? null : (
            <PageHeader
              title={current.label}
              description={description(section, organizationLabel)}
              actions={actions}
            />
          )}
          <div className={hideHeader ? "pb-7" : "py-7"}>{children}</div>
        </ContentPage>
      </main>
    </div>
  );
}
