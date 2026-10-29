import {
  capabilityCuration,
  capabilityErrorToast,
  domainFromUrl,
} from "@opengeni/react/app/lib/capabilities";
import type { CapabilityCatalogItem } from "@opengeni/react/app/types";
import { apiErrorFacts } from "@opengeni/react/ui/api-error";
import {
  PERSONAL_INTEGRATION_SETUP_PERMISSION,
  personalIntegrationSetupAccess,
} from "@opengeni/contracts/personal-integration-setup";

/* ----------------------------------------------------------------------------
   Product words for catalog connections. The catalog stores what the backend
   needs (registry names, provider domains, scope lists); these helpers pick
   the one sentence, the publisher and the trust line a person reads.
   -------------------------------------------------------------------------- */

/** Hosts whose connections always belong to one person (Gmail, Google Calendar, Slack's hosted MCP). */
const PERSONAL_ONLY_HOSTS = new Set([
  "gmailmcp.googleapis.com",
  "calendarmcp.googleapis.com",
  "mcp.slack.com",
]);

/**
 * True for providers that only ever connect someone's own account. The
 * ownership choice is not offered for them: each member connects their own.
 */
export function personalOnlyCapability(
  item: Pick<CapabilityCatalogItem, "mcpUrl" | "endpointUrl">,
): boolean {
  const host = domainFromUrl(item.mcpUrl ?? item.endpointUrl ?? null);
  return host !== null && PERSONAL_ONLY_HOSTS.has(host.toLowerCase());
}

type SetupGrant = {
  permissions: readonly string[];
  permissionMode?: "legacy" | "explicit" | undefined;
};

/** A sign-in connection's page, for one person: whether they choose who can
 * use it, and why they can't finish setup here (null when they can). */
export type CatalogConnectAccess = {
  /** Only their own account: no "Everyone in this workspace" choice. */
  personalOnly: boolean;
  /** Shown instead of the Connect button; nothing is signed in or saved. */
  blocked: { title: string; description: string } | null;
};

/**
 * Who may set up a connection from its page, decided before anyone signs in
 * so no account is saved for setup that can't finish. A Personal workspace
 * has one person: everything there is theirs alone, and a connection that
 * signs each person in takes only their own account. For an MCP connection
 * that is not on yet (custom ones often don't declare their sign-in until
 * asked), this is the shared rule the API and chat cards apply
 * (`personalIntegrationSetupAccess`). Once a connection is on, nobody needs to
 * turn it on again, so connecting is not blocked here, matching the in-chat
 * connect card (`inChatCapabilitySetup`); a person's own account is only used
 * where the connection takes each person's account. Until the grant loads,
 * offer setup; the API still enforces access.
 */
export function catalogConnectAccess(
  item: CapabilityCatalogItem,
  grant: SetupGrant | null | undefined,
  workspaceKind: "personal" | "shared" | null | undefined,
  /** The person is alone in this workspace: there is nobody to share with. */
  nobodyToShareWith = false,
): CatalogConnectAccess {
  const fixedPersonal =
    workspaceKind === "personal" ||
    nobodyToShareWith ||
    personalOnlyCapability(item) ||
    (item.enabled && item.connectionRef?.subjectScope === "subject");
  if (!grant || item.kind !== "mcp" || item.enabled)
    return { personalOnly: fixedPersonal, blocked: null };
  const access = personalIntegrationSetupAccess(grant, item);
  if (access) return { personalOnly: fixedPersonal || access === "personal", blocked: null };
  const canConnectOwn =
    grant.permissions.includes(PERSONAL_INTEGRATION_SETUP_PERMISSION) ||
    grant.permissions.includes("connections:write") ||
    (grant.permissionMode !== "explicit" && grant.permissions.includes("workspace:admin"));
  return {
    personalOnly: fixedPersonal,
    blocked: canConnectOwn
      ? {
          title: `Ask an admin to turn on ${capabilityTitle(item)}`,
          description:
            "Only an admin can turn it on in this workspace. Once it's on, you can connect your own account here.",
        }
      : {
          title: "You can't connect accounts here",
          description: "Ask a workspace admin for access to connect your own accounts.",
        },
  };
}

/** Why adding an MCP server failed, shown in the Add connection dialog. */
export function addConnectionErrorCopy(error: unknown): { title: string; description: string } {
  if (apiErrorFacts(error).status === 403)
    return {
      title: "Only an admin can add connections",
      description:
        "Ask a workspace admin to add this MCP server. Once it's on, you can connect your own account.",
    };
  return capabilityErrorToast(error, "Couldn't add the connection");
}

/** One outcome sentence per provider we know, where the catalog copy is written for the backend. */
const DESCRIPTIONS: Record<string, string> = {
  "gmailmcp.googleapis.com": "Search, read, draft, and send email from your Gmail.",
  "calendarmcp.googleapis.com":
    "See your schedule, check when you're free, and add or move events in your Google Calendar.",
  "slack.com": "Let agents read and send Slack messages as you.",
  "reddit.com": "Search Reddit, read threads, and reply from your account.",
  "jira.com": "Read and update the Jira issues and Confluence pages you can already see.",
  "atlassian.com": "Read and update the Jira issues and Confluence pages you can already see.",
};

export function capabilityDescription(
  item: Pick<CapabilityCatalogItem, "providerDomain" | "description">,
): string | null {
  const domain = item.providerDomain?.toLowerCase() ?? "";
  return DESCRIPTIONS[domain] ?? item.description ?? null;
}

/** A readable title when the catalog name is a registry slug ("42crunch-api-security"). */
export function capabilityTitle(item: Pick<CapabilityCatalogItem, "name" | "providerDomain">) {
  const domain = item.providerDomain?.toLowerCase() ?? "";
  if (domain === "jira.com" || domain === "atlassian.com") return "Jira & Confluence";
  return item.name;
}

const PUBLISHERS: Array<[RegExp, string]> = [
  [/(^|\.)google(apis)?\.com$/, "Google"],
  [/(^|\.)slack\.com$/, "Slack"],
  [/(^|\.)(atlassian|jira)\.com$/, "Atlassian"],
  [/(^|\.)microsoft\.com$|(^|\.)office\.com$/, "Microsoft"],
];

/**
 * Who makes it, for the "by X" line. Only claimed when the catalog says the
 * provider publishes it (official) or Opengeni built it; otherwise null.
 */
export function capabilityPublisher(item: CapabilityCatalogItem): string | null {
  if (item.source === "built_in" || item.surfaceType?.startsWith("first_party_")) return "Opengeni";
  if (!capabilityCuration(item).official) return null;
  const domain = item.providerDomain?.toLowerCase() ?? "";
  for (const [pattern, name] of PUBLISHERS) if (pattern.test(domain)) return name;
  return item.name;
}

/**
 * Registry entries Opengeni has not curated. Shown with a visible "Community"
 * label because it changes whether you should trust it.
 */
export function isCommunityCapability(item: CapabilityCatalogItem): boolean {
  if (item.kind !== "mcp") return false;
  if ((item.source as string) !== "registry" && (item.source as string) !== "public_registry")
    return false;
  return !capabilityCuration(item).curated;
}

/** "Everyone in this workspace" / "Only you", for the aside. */
export function ownershipLabel(scope: "workspace" | "personal"): string {
  return scope === "personal" ? "Only you" : "Everyone in this workspace";
}

export const OWNERSHIP_HELP = {
  workspace: "Agents and automations in this workspace can use it.",
  personal: "Only work you start can use it.",
  personalOnly: "Connects your own account. Only work you start can use it.",
} as const;
