/**
 * Reviewed consent copy for the core API integration definitions.
 *
 * Presentation only: nothing here grants a scope, selects a connection, or
 * replaces server-side authorization. The copy used to live hardcoded in the
 * web bundle (`REVIEWED_INTEGRATION_EXPERIENCES`); it is served with the
 * definition now so polishing a consent screen is a data change, not a
 * frontend release. The web keeps its generic fallback for any definition or
 * field missing here. Gmail's reviewed presentation lives on its catalog row
 * instead (`data/catalog/curated.json`): Gmail is a Connector, not one of
 * these API integration definitions.
 *
 * MCP connectors carry the same shape on their curated catalog row
 * (`presentation` in `data/catalog/curated.json` -> importer ->
 * `capability_catalog_items.metadata.presentation`).
 */

export type IntegrationPresentationIcon = "calendar" | "cloud" | "contacts" | "files" | "mail";

export type IntegrationPresentationCopy = {
  readonly providerName?: string;
  readonly icon?: IntegrationPresentationIcon;
  readonly introduction?: string;
  readonly capabilities?: readonly { readonly title: string; readonly description: string }[];
  readonly permissionSummary?: string;
  readonly scopeLabels?: Readonly<
    Record<string, { readonly label: string; readonly description: string }>
  >;
};

export const INTEGRATION_DEFINITION_PRESENTATIONS: Readonly<
  Record<string, IntegrationPresentationCopy>
> = {
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
