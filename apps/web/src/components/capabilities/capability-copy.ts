import { capabilityCuration, domainFromUrl } from "@/lib/capabilities";
import type { CapabilityCatalogItem } from "@/types";

/* ----------------------------------------------------------------------------
   Product words for catalog connections. The catalog stores what the backend
   needs (registry names, provider domains, scope lists); these helpers pick
   the one sentence, the publisher and the trust line a person reads.
   -------------------------------------------------------------------------- */

/** Hosts whose connections always belong to one person (official Gmail, Slack's hosted MCP). */
const PERSONAL_ONLY_HOSTS = new Set(["gmailmcp.googleapis.com", "mcp.slack.com"]);

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

/** One outcome sentence per provider we know, where the catalog copy is written for the backend. */
const DESCRIPTIONS: Record<string, string> = {
  "gmailmcp.googleapis.com": "Search, read, draft, and send email from your Gmail.",
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
 * provider publishes it (official) or OpenGeni built it; otherwise null.
 */
export function capabilityPublisher(item: CapabilityCatalogItem): string | null {
  if (item.source === "built_in" || item.surfaceType?.startsWith("first_party_")) return "Opengeni";
  if (!capabilityCuration(item).official) return null;
  const domain = item.providerDomain?.toLowerCase() ?? "";
  for (const [pattern, name] of PUBLISHERS) if (pattern.test(domain)) return name;
  return item.name;
}

/**
 * Registry entries OpenGeni has not curated. Shown with a visible "Community"
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
