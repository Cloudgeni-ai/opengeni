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
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { OrganizationSettingsSwitcher } from "./organization-settings-switcher";
import { SettingsShell, settingsHomeLink } from "./settings-sidebar";
import { useAppContext } from "@/context";
import { organizationsForSubject } from "@/lib/org";
import type { OrganizationAdminSection } from "@/lib/organization-admin";

type OrganizationSettingsItem = {
  id: OrganizationAdminSection;
  label: string;
  icon: LucideIcon;
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

function description(
  section: OrganizationAdminSection,
  organizationName: string,
): string | undefined {
  switch (section) {
    case "general":
      // The rows (Name, Organization ID) say it; a description would restate them.
      return undefined;
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
    <SettingsShell
      label="Organization settings"
      back={{
        label: "Workspace settings",
        link: <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} />,
      }}
      home={settingsHomeLink(workspaceId)}
      scope={
        organizationCount > 1 ? (
          <OrganizationSettingsSwitcher
            workspaceId={workspaceId}
            organizationLabel={organizationLabel}
            section={section}
          />
        ) : (
          <div className="min-w-0 px-2.5">
            <p className="truncate text-sm leading-5 font-semibold text-fg">{organizationLabel}</p>
            <p className="text-xs leading-4.5 text-fg-subtle">Organization</p>
          </div>
        )
      }
      groups={[
        {
          items: items.map((item) => ({
            id: item.id,
            label: item.label,
            icon: item.icon,
            link: (
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId }}
                search={{ section: item.id }}
              />
            ),
          })),
        },
      ]}
      activeId={section}
      currentPage={current.label}
      page={
        hideHeader
          ? null
          : { title: current.label, description: description(section, organizationLabel), actions }
      }
    >
      {children}
    </SettingsShell>
  );
}
