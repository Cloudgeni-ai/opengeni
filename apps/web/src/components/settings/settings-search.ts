// Search across settings: every page in the settings rail, plus the settings
// inside those pages that people look for by name ("voice input", "MCP",
// "invoices"). The index is built from the rail itself, so search never offers
// a page the person can't use: a setting is listed only when its page is.
import { cloneElement, isValidElement, type ReactElement } from "react";
import type { LucideIcon } from "lucide-react";

import type { SettingsRailSection } from "./settings-sidebar";

export interface SettingsSearchEntry {
  id: string;
  /** The page or setting: "Voice input". */
  label: string;
  /** Where it lives: "Workspace · General", or "Organization" for a page. */
  location: string;
  icon: LucideIcon;
  /** The router link, without children. */
  link: ReactElement;
  keywords: readonly string[];
}

/** A setting inside a page, found by its own name. */
interface SettingsTopic {
  label: string;
  keywords?: readonly string[];
  /** Search params that open the setting's own sub-page, when it has one. */
  search?: Record<string, string>;
}

/**
 * Other words for each page, keyed by settings rail item id. Words people type
 * when they don't know the page's name.
 */
const PAGE_KEYWORDS: Record<string, readonly string[]> = {
  "workspace:general": ["workspace name", "workspace id", "preferences"],
  "workspace:access": ["people", "members", "invite", "permissions", "roles", "share"],
  "workspace:learning": ["knowledge", "skills", "instructions", "memory", "review", "learn"],
  "workspace:usage": ["budget", "spend", "limit", "monthly", "cost"],
  "workspace:api-keys": ["token", "bearer", "sdk", "key"],
  "workspace:developer": ["webhooks", "credential provider", "events", "sdk", "integration"],
  "workspace:/workspaces/$workspaceId/insights": ["usage", "spend", "tokens", "cost", "analytics"],
  "workspace:/workspaces/$workspaceId/secrets": [
    "passwords",
    "vault",
    "variables",
    "environment variables",
    "variable sets",
    "tokens",
    "one-time codes",
    "totp",
    "credentials",
  ],
  "workspace:/workspaces/$workspaceId/rigs": ["sandbox", "rigs", "docker", "image", "setup script"],
  "workspace:/workspaces/$workspaceId/machines": [
    "connected machines",
    "computer",
    "laptop",
    "server",
    "self-hosted",
  ],
  "organization:general": ["organization name", "organization id", "rename organization"],
  "organization:people": ["members", "invite", "roles", "owner", "admin", "team"],
  "organization:workspaces": ["new workspace", "create workspace", "delete workspace"],
  "organization:identity": ["mission", "company profile", "about", "documents"],
  "organization:models": [
    "default model",
    "providers",
    "openai",
    "azure",
    "anthropic",
    "claude",
    "codex",
    "chatgpt",
    "supergrok",
    "xai",
    "subscriptions",
    "ai gateway",
    "llm",
    "compaction",
  ],
  "organization:integrations": ["allowed integrations", "connectors", "apps", "tools", "plugins"],
  "organization:agents": [
    "mcp",
    "mcp server",
    "claude code",
    "cursor",
    "codex",
    "coding agents",
    "ide",
    "install",
  ],
  "organization:insights": ["usage", "spend", "tokens", "cost", "analytics"],
  "organization:billing": ["credits", "payments", "invoices", "top up", "budgets", "plan", "card"],
  "organization:developer": [
    "api keys",
    "organization api keys",
    "personal api keys",
    "service accounts",
    "webhooks",
    "sdk",
  ],
  "organization:security": [
    "privacy",
    "private chats",
    "retention",
    "recovery",
    "data",
    "admin access",
  ],
  "account:security": [
    "password",
    "sign-in methods",
    "google",
    "github",
    "email",
    "privacy",
    "analytics",
  ],
};

/** Settings found by their own name, keyed by the settings rail item id of their page. */
const PAGE_TOPICS: Record<string, readonly SettingsTopic[]> = {
  "workspace:general": [
    {
      label: "Agent defaults",
      keywords: ["new session defaults", "default agent", "instructions"],
      search: { view: "agent-defaults" },
    },
    { label: "Agent activity", keywords: ["pause agents", "resume agents", "stop"] },
    { label: "Sandbox environment", keywords: ["default sandbox", "rig"] },
    { label: "Sandbox image", keywords: ["docker", "container"] },
    { label: "Voice input", keywords: ["transcription", "dictation", "microphone", "speech"] },
    { label: "Video generation", keywords: ["video"] },
    { label: "Use connected apps automatically", keywords: ["integrations", "tools"] },
    { label: "Delete workspace", keywords: ["remove workspace", "danger zone"] },
  ],
  "workspace:access": [
    { label: "Add people", keywords: ["invite", "share workspace"], search: { view: "add" } },
  ],
  "workspace:api-keys": [
    { label: "Create API key", keywords: ["new key", "token"], search: { key: "new" } },
  ],
  "workspace:developer": [
    { label: "Add webhook", keywords: ["events", "callback"], search: { view: "new-webhook" } },
    {
      label: "Credential provider",
      keywords: ["run credentials"],
      search: { view: "credential-provider" },
    },
  ],
  "organization:people": [
    { label: "Invite people", keywords: ["add members", "invitation"], search: { view: "invite" } },
  ],
  "organization:workspaces": [
    { label: "New workspace", keywords: ["create workspace"], search: { view: "new-workspace" } },
  ],
  "organization:agents": [
    {
      label: "Opengeni MCP server",
      keywords: ["install", "server url", "claude code", "cursor", "codex", "coding agents"],
    },
  ],
  "organization:billing": [{ label: "Buy credits", keywords: ["top up", "payment"] }],
  "organization:developer": [
    {
      label: "Create organization API key",
      keywords: ["new key", "token"],
      search: { view: "new-key" },
    },
    { label: "Personal API keys", keywords: ["personal key", "token"] },
    { label: "Service accounts", keywords: ["bot", "machine user"] },
  ],
  "organization:security": [
    { label: "Data retention", keywords: ["retention", "delete data"] },
    { label: "Admin access for agent sessions", keywords: ["agents", "admin"] },
  ],
  "account:security": [
    { label: "Password", keywords: ["change password", "sign in"] },
    { label: "Analytics preferences", keywords: ["privacy", "tracking", "cookies"] },
  ],
};

/** The same link with extra search params, to open a setting's sub-page. */
function withSearch(link: ReactElement, extra: Record<string, string> | undefined): ReactElement {
  if (!extra || !isValidElement(link)) return link;
  const props = link.props as { search?: unknown };
  const current =
    props.search && typeof props.search === "object"
      ? (props.search as Record<string, unknown>)
      : {};
  return cloneElement(link as ReactElement<{ search?: unknown }>, {
    search: { ...current, ...extra },
  });
}

/** Every page in the rail and the settings inside them, in rail order. */
export function settingsSearchEntries(
  sections: readonly SettingsRailSection[],
): SettingsSearchEntry[] {
  const entries: SettingsSearchEntry[] = [];
  for (const section of sections) {
    for (const group of section.groups) {
      for (const item of group.items) {
        entries.push({
          id: item.id,
          label: item.label,
          location: section.label,
          icon: item.icon,
          link: item.link,
          keywords: PAGE_KEYWORDS[item.id] ?? [],
        });
        for (const topic of PAGE_TOPICS[item.id] ?? []) {
          entries.push({
            id: `${item.id}#${topic.label}`,
            label: topic.label,
            location: `${section.label} · ${item.label}`,
            icon: item.icon,
            link: withSearch(item.link, topic.search),
            keywords: topic.keywords ?? [],
          });
        }
      }
    }
  }
  return entries;
}

function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when a word in `text` starts with `token`. */
function hasWordStartingWith(text: string, token: string): boolean {
  return text === token || text.startsWith(token) || text.includes(` ${token}`);
}

/**
 * Entries matching every word of the query, best first: the name itself, then
 * a word of the name, then its other words and where it lives.
 */
export function searchSettings(
  entries: readonly SettingsSearchEntry[],
  query: string,
): SettingsSearchEntry[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(" ");
  const scored: { entry: SettingsSearchEntry; score: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const label = normalize(entry.label);
    const keywords = entry.keywords.map(normalize).join(" ");
    const everything = `${label} ${keywords} ${normalize(entry.location)}`;
    if (!tokens.every((token) => hasWordStartingWith(everything, token))) return;
    let score = 0;
    if (label === normalizedQuery) score = 100;
    else if (label.startsWith(normalizedQuery)) score = 80;
    else if (tokens.every((token) => hasWordStartingWith(label, token))) score = 60;
    else if (entry.keywords.some((keyword) => normalize(keyword).startsWith(normalizedQuery)))
      score = 40;
    else if (tokens.some((token) => hasWordStartingWith(label, token))) score = 20;
    scored.push({ entry, score, index });
  });
  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ entry }) => entry);
}
