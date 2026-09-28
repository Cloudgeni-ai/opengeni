import { Link, useRouterState } from "@tanstack/react-router";
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
import { SettingsFrame, SettingsFrameOutLink } from "./settings-frame";
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
  const rawSection = useRouterState({
    select: (state) => (state.location.search as { section?: unknown }).section,
  });
  const organizationCount = organizationsForSubject(
    context.accessContext,
    context.workspaces,
  ).length;
  const items = ORGANIZATION_SETTINGS_ITEMS.filter((item) => visibleSections.has(item.id));
  const current = ORGANIZATION_SETTINGS_ITEMS.find((item) => item.id === section)!;
  const workspaceName =
    context.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Workspace";
  return (
    <SettingsFrame
      label="Organization settings"
      heading="Organization"
      subheading={organizationCount > 1 ? undefined : organizationLabel}
      header={
        organizationCount > 1 ? (
          <OrganizationSettingsSwitcher
            workspaceId={workspaceId}
            organizationLabel={organizationLabel}
            section={section}
          />
        ) : undefined
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
      indexRequested={rawSection === undefined}
      indexLink={<Link to="/workspaces/$workspaceId/organization" params={{ workspaceId }} />}
      footer={
        <SettingsFrameOutLink
          groupLabel="Workspace"
          label={workspaceName}
          icon={SlidersHorizontalIcon}
          link={
            <Link
              to="/workspaces/$workspaceId/settings"
              params={{ workspaceId }}
              aria-label={`Workspace settings for ${workspaceName}`}
            />
          }
        />
      }
      page={
        hideHeader
          ? null
          : { title: current.label, description: description(section, organizationLabel), actions }
      }
      ownBackLink={hideHeader}
    >
      {children}
    </SettingsFrame>
  );
}
