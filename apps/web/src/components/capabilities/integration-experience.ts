import type { IntegrationDefinitionSummary } from "@/types";

export type IntegrationExperienceIcon = "calendar" | "cloud" | "contacts" | "files" | "mail";

export type IntegrationExperienceCapability = {
  title: string;
  description: string;
};

export type IntegrationExperiencePermission = {
  label: string;
  description: string;
};

export type IntegrationExperienceDescriptor = {
  serviceName: string;
  providerName: string;
  icon: IntegrationExperienceIcon;
  introduction: string;
  capabilities: IntegrationExperienceCapability[];
  permissionSummary: string;
  permissions: IntegrationExperiencePermission[];
  technicalDetails: {
    providerDomain: string;
    oauthScopes: string[];
  };
};

type PresentationDefinition = Pick<IntegrationDefinitionSummary, "id" | "name" | "summary"> & {
  provider: { id: string; domain: string };
  authentication: { scopes: string[] };
};

type ReviewedIntegrationExperience = Omit<
  IntegrationExperienceDescriptor,
  "serviceName" | "technicalDetails" | "permissions"
> & {
  scopeLabels: Readonly<Record<string, { label: string; description: string }>>;
};

const COMMON_SCOPE_LABELS: Readonly<Record<string, { label: string; description: string }>> = {
  openid: {
    label: "Confirm your account",
    description: "Match the connection to the provider account you approve.",
  },
  email: {
    label: "See your account email",
    description: "Show which provider account is connected.",
  },
  profile: {
    label: "See your basic profile",
    description: "Use the provider's basic account identity for a clear account label.",
  },
  offline_access: {
    label: "Keep the connection working",
    description: "Refresh access when you are not actively using OpenGeni.",
  },
  "User.Read": {
    label: "Confirm your Microsoft account",
    description: "Show which Microsoft account is connected.",
  },
};

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  discord: "Discord",
  google: "Google",
  hubspot: "HubSpot",
  microsoft: "Microsoft",
  notion: "Notion",
  stripe: "Stripe",
};

const REVIEWED_INTEGRATION_EXPERIENCES: Readonly<Record<string, ReviewedIntegrationExperience>> = {
  "google-gmail": {
    providerName: "Google",
    icon: "mail",
    introduction: "Let agents work with the Gmail account you choose.",
    capabilities: [
      {
        title: "Find and understand mail",
        description: "Search messages and threads, then use them as context for your work.",
      },
      {
        title: "Draft and send messages",
        description: "Prepare replies and send mail through the reviewed Gmail tools.",
      },
      {
        title: "Organize the mailbox",
        description: "Work with labels, drafts, messages, and threads.",
      },
    ],
    permissionSummary:
      "Google grants broad mailbox access. OpenGeni still exposes only the reviewed tools configured for this integration.",
    scopeLabels: {
      "https://mail.google.com/": {
        label: "Work with your Gmail mailbox",
        description: "Read, organize, draft, and send mail for the account you approve.",
      },
    },
  },
  "google-drive": {
    providerName: "Google",
    icon: "files",
    introduction: "Let agents work with files in the Google Drive account you choose.",
    capabilities: [
      {
        title: "Find files and folders",
        description: "Browse and search content in My Drive and shared drives.",
      },
      {
        title: "Create and update content",
        description: "Work with files and folders through the reviewed Drive tools.",
      },
      {
        title: "Manage sharing",
        description: "Review and update links, permissions, and shared-drive content.",
      },
    ],
    permissionSummary:
      "Google asks for access to the Drive account you approve, including files shared with that account.",
    scopeLabels: {
      "https://www.googleapis.com/auth/drive": {
        label: "Work with Google Drive files",
        description: "See, create, edit, organize, and share files available to this account.",
      },
    },
  },
  "microsoft-outlook-mail": {
    providerName: "Microsoft",
    icon: "mail",
    introduction: "Let agents work with mail in the Microsoft account you choose.",
    capabilities: [
      {
        title: "Find and understand mail",
        description: "Search messages, folders, and attachments for useful context.",
      },
      {
        title: "Draft and send messages",
        description: "Prepare, update, and send mail through the reviewed Outlook tools.",
      },
      {
        title: "Manage mailbox settings",
        description: "Work with supported folders, classifications, and mailbox preferences.",
      },
    ],
    permissionSummary:
      "Microsoft asks for mail and mailbox-setting access for the account you approve.",
    scopeLabels: {
      "Mail.ReadWrite": {
        label: "Read and update mail",
        description: "Work with messages, folders, and attachments in this mailbox.",
      },
      "Mail.Send": {
        label: "Send mail",
        description: "Send messages as the connected Microsoft account.",
      },
      "MailboxSettings.ReadWrite": {
        label: "Manage mailbox settings",
        description: "Read and update supported Outlook mailbox preferences.",
      },
    },
  },
  "microsoft-outlook-calendar": {
    providerName: "Microsoft",
    icon: "calendar",
    introduction: "Let agents help coordinate the calendars in your Microsoft account.",
    capabilities: [
      {
        title: "Understand your schedule",
        description: "Review calendars, events, availability, and reminders.",
      },
      {
        title: "Plan meetings",
        description: "Find suitable times and coordinate calendar activity.",
      },
      {
        title: "Manage events",
        description: "Create and update events through the reviewed calendar tools.",
      },
    ],
    permissionSummary:
      "Microsoft asks for permission to view and manage calendars for the account you approve.",
    scopeLabels: {
      "Calendars.ReadWrite": {
        label: "View and manage calendars",
        description: "Read, create, update, and organize calendar events.",
      },
    },
  },
  "microsoft-outlook-contacts": {
    providerName: "Microsoft",
    icon: "contacts",
    introduction: "Let agents work with contacts in your Microsoft account.",
    capabilities: [
      {
        title: "Find people",
        description: "Look up contacts and relevant people suggestions.",
      },
      {
        title: "Organize contacts",
        description: "Work with contacts and contact folders.",
      },
      {
        title: "Keep details current",
        description: "Create or update contact information through reviewed tools.",
      },
    ],
    permissionSummary:
      "Microsoft asks for contact access and people suggestions for the account you approve.",
    scopeLabels: {
      "Contacts.ReadWrite": {
        label: "View and manage contacts",
        description: "Read, create, update, and organize contacts and contact folders.",
      },
      "People.Read.All": {
        label: "Find relevant people",
        description: "Use people suggestions available to the connected account.",
      },
    },
  },
  "microsoft-onedrive": {
    providerName: "Microsoft",
    icon: "cloud",
    introduction: "Let agents work with files in the Microsoft account you choose.",
    capabilities: [
      {
        title: "Find files and folders",
        description: "Browse drives, folders, shared items, and sites available to the account.",
      },
      {
        title: "Create and update content",
        description: "Work with OneDrive and SharePoint files through reviewed tools.",
      },
      {
        title: "Manage sharing",
        description: "Review and update sharing links and permissions.",
      },
    ],
    permissionSummary:
      "Microsoft asks for file and site access anywhere the connected account already has access.",
    scopeLabels: {
      "Files.ReadWrite.All": {
        label: "Work with accessible files",
        description: "Read, create, update, and organize files available to this account.",
      },
      "Sites.ReadWrite.All": {
        label: "Work with accessible sites",
        description: "Read and update files in SharePoint sites available to this account.",
      },
    },
  },
};

/**
 * Builds presentation-only copy from a Definition. The returned metadata never
 * grants a scope, selects a Connection, or replaces server-side authorization.
 */
export function integrationExperience(
  definition: PresentationDefinition,
): IntegrationExperienceDescriptor {
  const reviewed = REVIEWED_INTEGRATION_EXPERIENCES[definition.id];
  const providerName = reviewed?.providerName ?? friendlyProviderName(definition.provider);
  const scopeLabels = { ...COMMON_SCOPE_LABELS, ...(reviewed?.scopeLabels ?? {}) };
  const permissions = definition.authentication.scopes.flatMap((scope) => {
    const copy = scopeLabels[scope];
    return copy ? [copy] : [];
  });

  return {
    serviceName: definition.name,
    providerName,
    icon: reviewed?.icon ?? "cloud",
    introduction:
      reviewed?.introduction ?? `Let agents use ${definition.name} through the account you choose.`,
    capabilities: reviewed?.capabilities ?? [
      {
        title: `Use ${definition.name} with agents`,
        description:
          definition.summary.trim() ||
          "Use the reviewed tools published by this integration without exposing credentials.",
      },
    ],
    permissionSummary:
      reviewed?.permissionSummary ??
      `${providerName} will show the exact access request before you approve it. OpenGeni uses that access only through this integration's reviewed tools.`,
    permissions: deduplicatePermissions(permissions),
    technicalDetails: {
      providerDomain: definition.provider.domain,
      oauthScopes: [...definition.authentication.scopes],
    },
  };
}

function friendlyProviderName(provider: { id: string; domain: string }): string {
  const id = provider.id.trim();
  const reviewedName = PROVIDER_NAMES[id.toLowerCase()];
  if (reviewedName) return reviewedName;
  if (id) return titleCase(id.replaceAll(/[-_]+/g, " "));
  const domainPart = provider.domain
    .replace(/^www\./, "")
    .split(".")
    .filter(Boolean)
    .at(-2);
  return domainPart ? titleCase(domainPart) : "the provider";
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

function deduplicatePermissions(
  permissions: IntegrationExperiencePermission[],
): IntegrationExperiencePermission[] {
  const seen = new Set<string>();
  return permissions.filter((permission) => {
    const key = `${permission.label}\u0000${permission.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
