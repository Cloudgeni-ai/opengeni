import {
  BlocksIcon,
  CodeIcon,
  CreditCardIcon,
  FingerprintIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SquareStackIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import type { OrganizationAdminSection } from "@/lib/organization-admin";

type OrganizationSettingsItem = {
  id: OrganizationAdminSection;
  label: string;
  icon: LucideIcon;
};

/**
 * The organization's settings pages: one name and one icon each, in rail order.
 * A page that exists at both scopes wears the same icon in the workspace rail
 * (`settings-rail.tsx`): General, People/Access, Developer, Security. Models is one
 * page in the workspace section; the organization's accounts are on it.
 */
export const ORGANIZATION_SETTINGS_ITEMS: readonly OrganizationSettingsItem[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "people", label: "People", icon: UsersIcon },
  { id: "workspaces", label: "Workspaces", icon: SquareStackIcon },
  { id: "identity", label: "Organization identity", icon: FingerprintIcon },
  { id: "integrations", label: "Integrations", icon: BlocksIcon },
  { id: "billing", label: "Billing & usage", icon: CreditCardIcon },
  { id: "developer", label: "Developer", icon: CodeIcon },
  { id: "security", label: "Security & data", icon: ShieldCheckIcon },
];

/**
 * The rail's two unlabeled groups: the organization and its people, then what
 * it provides, pays for and protects.
 */
export const ORGANIZATION_SETTINGS_GROUPS: readonly (readonly OrganizationAdminSection[])[] = [
  ["general", "people", "workspaces", "identity"],
  ["integrations", "billing", "developer", "security"],
];

export function organizationSettingsLabel(section: OrganizationAdminSection): string {
  return ORGANIZATION_SETTINGS_ITEMS.find((item) => item.id === section)?.label ?? "Organization";
}

/** The page subtitle, omitted when it would only restate what the page shows. */
export function organizationSettingsDescription(
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
      // Redirects to the workspace's Models page, which has its own subtitle.
      return undefined;
    case "integrations":
      // "Allowed integrations" and its one row say it all.
      return undefined;
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
