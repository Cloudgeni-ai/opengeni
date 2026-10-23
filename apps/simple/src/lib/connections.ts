import type { ConnectAccount } from "@opengeni/connect";
import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";

/**
 * Presentation for the Connections settings: a person reads services and
 * accounts ("Linear", "bendik@... · Only you"), never provider domains or
 * adapter ids. Nothing here selects or grants a credential; every action still
 * names the exact account id the server listed.
 */

export type LogoSource = (item: CapabilityCatalogItem) => string | null;

export type ConnectedAccountView = {
  /** The exact inventory id: what disconnect and reconnect act on. */
  id: string;
  version: number | undefined;
  providerId: string;
  /** Account identity, e.g. an email or workspace name. Null when the provider shares none. */
  label: string | null;
  ownership: "personal" | "workspace";
  /** A short role for this account within its service, e.g. "Bot". */
  role: string | null;
  needsAttention: boolean;
  /** The MCP endpoint for an OAuth MCP account, used to sign in again. */
  mcpUrl: string | null;
  canReconnect: boolean;
  createdAt: string | null;
};

export type ConnectedServiceView = {
  key: string;
  name: string;
  logo: string | null;
  accounts: ConnectedAccountView[];
};

const GITHUB_PROVIDERS = new Set(["github-app", "github-personal", "github-lens"]);

/** Native providers whose name and catalog row are known up front. */
const NATIVE: Record<string, { name: string; catalogId?: string; role?: string }> = {
  "github-app": { name: "GitHub", catalogId: "api:github-app" },
  "github-personal": { name: "GitHub", catalogId: "api:github-app" },
  "github-lens": { name: "GitHub", catalogId: "api:github-app", role: "Code review" },
  "slack-bot": { name: "Slack", role: "Bot" },
  "slack-personal": { name: "Slack" },
  gmail: { name: "Gmail" },
  "google-drive-publish": { name: "Google Drive" },
  "google-drive-knowledge": { name: "Google Drive" },
  x: { name: "X", catalogId: "api:x" },
  reddit: { name: "Reddit", catalogId: "api:reddit" },
  "fiken-token": { name: "Fiken", catalogId: "api:fiken" },
  "fiken-oauth": { name: "Fiken", catalogId: "api:fiken" },
  "microsoft-outlook-mail": { name: "Outlook Mail" },
  "microsoft-outlook-calendar": { name: "Outlook Calendar" },
  "microsoft-outlook-contacts": { name: "Outlook Contacts" },
  "microsoft-onedrive": { name: "OneDrive" },
};

/** Second-level labels too broad to identify one service on their own. */
const SHARED_ROOTS = new Set([
  "googleapis",
  "google",
  "microsoft",
  "azure",
  "amazonaws",
  "cloudflare",
  "vercel",
  "herokuapp",
  "github",
  "example",
]);

export function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function host(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname
      .toLowerCase()
      .replace(/^www\./u, "");
  } catch {
    return null;
  }
}

function rootLabel(hostname: string | null): string | null {
  if (!hostname) return null;
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  // co.uk, com.au and similar keep their registrable label one step further left.
  const second = parts[parts.length - 2]!;
  const root =
    parts.length >= 3 && ["co", "com", "net", "org"].includes(second)
      ? parts[parts.length - 3]!
      : second;
  return SHARED_ROOTS.has(root) ? null : root;
}

/** "mcp.grafana.net" -> "Grafana", "internal-tools.example.com" -> "Internal Tools". */
export function humanizeDomain(domain: string): string {
  const hostname = host(domain) ?? domain;
  const parts = hostname.split(".").filter(Boolean);
  const meaningful = parts.filter(
    (part, index) =>
      index < parts.length - 1 && !["mcp", "api", "app", "www", "auth"].includes(part),
  );
  const pick =
    rootLabel(hostname) ?? meaningful.find((part) => !SHARED_ROOTS.has(part)) ?? parts[0] ?? domain;
  return pick
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/iu.test(value.trim());
}

export function catalogCurationFeatured(item: Pick<CapabilityCatalogItem, "metadata">): boolean {
  const raw = item.metadata?.curation;
  return Boolean(
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).featured === true,
  );
}

type CatalogIndex = {
  byId: Map<string, CapabilityCatalogItem>;
  byConnection: Map<string, CapabilityCatalogItem>;
  byEndpoint: Map<string, CapabilityCatalogItem>;
  byHost: Map<string, CapabilityCatalogItem>;
  byRoot: Map<string, CapabilityCatalogItem>;
  byName: Map<string, CapabilityCatalogItem>;
};

function indexCatalog(items: readonly CapabilityCatalogItem[]): CatalogIndex {
  const index: CatalogIndex = {
    byId: new Map(),
    byConnection: new Map(),
    byEndpoint: new Map(),
    byHost: new Map(),
    byRoot: new Map(),
    byName: new Map(),
  };
  const rank = (item: CapabilityCatalogItem) =>
    (catalogCurationFeatured(item) ? 4 : 0) +
    (item.tier === "verified" ? 2 : 0) +
    (item.logoAssetPath ? 1 : 0);
  const put = (
    map: Map<string, CapabilityCatalogItem>,
    key: string | null | undefined,
    item: CapabilityCatalogItem,
  ) => {
    if (!key) return;
    const existing = map.get(key);
    // Prefer a featured/verified row with a logo over a community duplicate.
    if (!existing || rank(item) > rank(existing)) map.set(key, item);
  };
  for (const item of items) {
    index.byId.set(item.id, item);
    put(index.byConnection, item.connectionRef?.connectionId, item);
    const endpoint = item.mcpUrl ?? item.endpointUrl;
    if (endpoint) put(index.byEndpoint, canonicalUrl(endpoint), item);
    for (const name of [host(endpoint), host(item.providerDomain)]) {
      put(index.byHost, name, item);
      put(index.byRoot, rootLabel(name), item);
    }
    put(index.byName, item.name.toLowerCase(), item);
  }
  return index;
}

function catalogFor(
  index: CatalogIndex,
  account: ConnectAccount,
  connection: ConnectionMetadata | undefined,
): CapabilityCatalogItem | undefined {
  const native = NATIVE[account.providerId];
  if (native?.catalogId) return index.byId.get(native.catalogId);
  const exact = index.byConnection.get(account.id);
  if (exact) return exact;
  const mcpUrl =
    typeof connection?.metadata.mcpUrl === "string" ? connection.metadata.mcpUrl : null;
  if (mcpUrl) {
    const byEndpoint = index.byEndpoint.get(canonicalUrl(mcpUrl));
    if (byEndpoint) return byEndpoint;
  }
  if (native) return index.byName.get(native.name.toLowerCase());
  const domain =
    connection?.providerDomain ?? (looksLikeDomain(account.label) ? account.label : "");
  for (const candidate of [host(mcpUrl), host(domain)]) {
    const found = index.byHost.get(candidate ?? "");
    if (found) return found;
  }
  for (const candidate of [rootLabel(host(mcpUrl)), rootLabel(host(domain))]) {
    const found = candidate ? index.byRoot.get(candidate) : undefined;
    if (found) return found;
  }
  return undefined;
}

function accountLabel(
  account: ConnectAccount,
  connection: ConnectionMetadata | undefined,
  serviceName: string,
): string | null {
  const fromMetadata = connection ? connectionAccountIdentityLabel(connection.metadata, "") : "";
  if (fromMetadata && !looksLikeDomain(fromMetadata)) return fromMetadata;
  const label = account.label.trim();
  if (
    !label ||
    looksLikeDomain(label) ||
    label.toLowerCase() === serviceName.toLowerCase() ||
    label === connection?.id ||
    label === account.id ||
    /^(Slack workspace bot|GitHub|Google Drive|Lens installation)$/iu.test(label)
  )
    return null;
  return label;
}

function fromConnection(connection: ConnectionMetadata): ConnectAccount {
  return {
    id: connection.id,
    version: connection.version,
    providerId: "connection",
    label: connection.providerDomain,
    ownership: connection.subjectId === null ? "workspace" : "personal",
    status: connection.status === "active" ? "connected" : "auth_needed",
  };
}

const short = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/**
 * One entry per service, each with its accounts. Accounts the connect inventory
 * lists come first; plain connection rows it does not describe are added so
 * nothing the old screen showed disappears.
 */
export function connectedServices(input: {
  accounts: readonly ConnectAccount[];
  connections: readonly ConnectionMetadata[];
  catalog: readonly CapabilityCatalogItem[];
  logo: LogoSource;
  firstPartyLogo?: (providerId: string) => string | null;
}): ConnectedServiceView[] {
  const index = indexCatalog(input.catalog);
  const byId = new Map(input.connections.map((connection) => [connection.id, connection]));
  const listed = new Set(input.accounts.map((account) => account.id));
  const inventory = [
    ...input.accounts.filter((account) => account.status !== "disabled"),
    ...input.connections
      .filter((connection) => !listed.has(connection.id) && connection.status !== "revoked")
      .map(fromConnection),
  ];
  const services = new Map<string, ConnectedServiceView>();
  for (const account of inventory) {
    const connection = byId.get(account.id);
    const item = catalogFor(index, account, connection);
    const native = NATIVE[account.providerId];
    const name =
      native?.name ??
      item?.name ??
      humanizeDomain(connection?.providerDomain ?? account.label ?? account.providerId);
    const key = name.toLowerCase();
    const logo =
      (item ? input.logo(item) : null) ?? input.firstPartyLogo?.(account.providerId) ?? null;
    const mcpUrl =
      connection?.kind === "oauth2" && typeof connection.metadata.mcpUrl === "string"
        ? connection.metadata.mcpUrl
        : null;
    const view: ConnectedAccountView = {
      id: account.id,
      version: account.version,
      providerId: account.providerId,
      label: accountLabel(account, connection, name),
      ownership: account.ownership,
      role: native?.role ?? null,
      needsAttention: account.status === "auth_needed",
      mcpUrl,
      canReconnect: Boolean(mcpUrl) && !GITHUB_PROVIDERS.has(account.providerId),
      createdAt: connection?.createdAt ?? null,
    };
    const service = services.get(key) ?? { key, name, logo, accounts: [] };
    service.logo ??= logo;
    service.accounts.push(view);
    services.set(key, service);
  }
  for (const service of services.values()) {
    // Accounts that read the same need a tell: when each was added.
    const seen = new Map<string, number>();
    for (const account of service.accounts) {
      const text = `${account.label ?? ""}|${account.ownership}|${account.role ?? ""}`;
      seen.set(text, (seen.get(text) ?? 0) + 1);
    }
    for (const account of service.accounts) {
      const text = `${account.label ?? ""}|${account.ownership}|${account.role ?? ""}`;
      if ((seen.get(text) ?? 0) > 1 && !account.label && account.createdAt)
        account.label = `Added ${short.format(new Date(account.createdAt))}`;
    }
    service.accounts.sort(
      (a, b) =>
        Number(b.needsAttention) - Number(a.needsAttention) ||
        (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
    );
  }
  // Anything that needs a sign-in leads, so it survives a collapsed list.
  const attention = (service: ConnectedServiceView) =>
    Number(service.accounts.some((account) => account.needsAttention));
  return [...services.values()].sort(
    (a, b) => attention(b) - attention(a) || a.name.localeCompare(b.name),
  );
}

/** "Workspace" or "Only you", with the account's identity and role when known. */
export function accountSubtitle(account: ConnectedAccountView): string {
  return [account.label, account.role, account.ownership === "personal" ? "Only you" : "Workspace"]
    .filter(Boolean)
    .join(" · ");
}

/** OAuth MCP services a person can connect from here, as Connect would accept them. */
export function connectableCatalog(
  items: readonly CapabilityCatalogItem[],
): CapabilityCatalogItem[] {
  const usable = items.filter(
    (item) =>
      item.kind === "mcp" &&
      item.authKind === "oauth2" &&
      Boolean(item.mcpUrl ?? item.endpointUrl) &&
      item.surfaceType !== "codex_apps" &&
      // The provider refuses self-registration and this deployment has no
      // operator client for it: Connect cannot succeed.
      (item.enabled || item.runtime?.operatorOAuthClient?.configured !== false),
  );
  // One tile per service name: registries can list the same service twice.
  const byName = new Map<string, CapabilityCatalogItem>();
  for (const item of usable) {
    const key = item.name.toLowerCase();
    const existing = byName.get(key);
    if (
      !existing ||
      (catalogCurationFeatured(item) && !catalogCurationFeatured(existing)) ||
      (!existing.logoAssetPath && item.logoAssetPath)
    )
      byName.set(key, item);
  }
  return [...byName.values()];
}

export function categoryLabel(category: string | null | undefined): string | null {
  if (!category) return null;
  const words = category.replace(/[-_]+/gu, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

export function searchCatalog(
  items: readonly CapabilityCatalogItem[],
  query: string,
): CapabilityCatalogItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    const featured = items.filter(catalogCurationFeatured);
    // Rows still named by their API host ("bigquery.googleapis.com") stay
    // reachable by search but don't crowd browsing.
    const rest = items.filter(
      (item) =>
        !catalogCurationFeatured(item) && item.tier === "verified" && !looksLikeDomain(item.name),
    );
    return [...featured, ...rest];
  }
  const scored = items.flatMap((item) => {
    const name = item.name.toLowerCase();
    const score = name.startsWith(needle)
      ? 0
      : name.includes(needle)
        ? 1
        : `${item.description ?? ""} ${item.category ?? ""} ${item.providerDomain ?? ""}`
              .toLowerCase()
              .includes(needle)
          ? 2
          : -1;
    return score < 0 ? [] : [{ item, score }];
  });
  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        Number(catalogCurationFeatured(b.item)) - Number(catalogCurationFeatured(a.item)) ||
        a.item.name.localeCompare(b.item.name),
    )
    .map((entry) => entry.item);
}
