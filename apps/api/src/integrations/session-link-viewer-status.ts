import {
  SESSION_LINK_ASSIGNEE_MAX_LENGTH,
  SESSION_LINK_TITLE_MAX_LENGTH,
  classifySessionLinkUrl,
  type AccessGrant,
  type SessionLink,
  type SessionLinkConnect,
  type SessionLinkLiveStatus,
  type ToolGatewayCatalogEntry,
  type ToolGatewayIdentity,
  type ToolGatewayResult,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { readSiteToolAccountInventory, type SiteToolAccountInventory } from "../site-tool-routing";
import {
  callWorkspaceToolGateway,
  prepareWorkspaceToolGatewayForGrant,
  type PreparedWorkspaceToolGateway,
} from "../workspace-tool-gateway";

/**
 * Live status for Linear issues and Slack threads in a chat's Linked panel,
 * read as the viewer: through the viewer's own account of that connector
 * (or one the workspace shares with them), with the ordinary workspace tool
 * gateway, so their tool choices, approvals and blocks apply. Never another
 * person's account. A viewer with no account gets `connect` instead; a read
 * that fails, asks for approval or is blocked leaves the link with its title.
 */

export type ViewerLinkProvider = "linear" | "slack";

type ProviderSpec = {
  /** Connector provider domains that serve it. */
  domains: readonly string[];
  name: string;
  /** The read tool, by name, on any of its connectors. */
  toolName: string;
};

const PROVIDERS: Record<ViewerLinkProvider, ProviderSpec> = {
  linear: { domains: ["linear.app"], name: "Linear", toolName: "get_issue" },
  slack: { domains: ["slack.com"], name: "Slack", toolName: "slack_read_thread" },
};

/** At most this many of the viewer's accounts are tried per link (two Linear workspaces, ...). */
const ACCOUNTS_PER_LINK = 3;
const SLACK_FIRST_MESSAGE_CHARS = 120;
/** One link's read, across its accounts, stops after this long (as GitHub's do). */
export const VIEWER_READ_TIMEOUT_MS = 6_000;

/** Resolves to null once `ms` pass; the read itself is left to finish or fail. */
function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export type ViewerLinkRead =
  | { kind: "status"; status: SessionLinkLiveStatus }
  | { kind: "connect"; connect: SessionLinkConnect }
  | { kind: "none" };

/** Calls one tool for the viewer; tests replace it. */
export type ViewerToolCaller = (
  identity: ToolGatewayIdentity,
  args: Record<string, unknown>,
) => Promise<ToolGatewayResult | null>;

/** The tools the viewer's gateway offers, with their input schemas; tests replace it. */
export type ViewerToolSession = {
  entry: (identity: ToolGatewayIdentity) => ToolGatewayCatalogEntry | undefined;
  call: ViewerToolCaller;
  close: () => Promise<void>;
};

export type ViewerLinkReaderIo = {
  inventory: (deps: ApiRouteDeps, grant: AccessGrant) => Promise<SiteToolAccountInventory>;
  open: (
    deps: ApiRouteDeps,
    grant: AccessGrant,
    identities: readonly ToolGatewayIdentity[],
    signal?: AbortSignal,
  ) => Promise<ViewerToolSession>;
};

export function viewerLinkProvider(link: Pick<SessionLink, "provider" | "kind">) {
  if (link.provider === "linear" && link.kind === "issue") return "linear" as const;
  if (link.provider === "slack" && link.kind === "thread") return "slack" as const;
  return null;
}

function domainMatches(domain: string, domains: readonly string[]): boolean {
  const value = domain.trim().toLowerCase();
  return domains.some((each) => value === each || value.endsWith(`.${each}`));
}

/** The viewer's accounts that can read `provider`, their own first, then ones the workspace shares. */
export function viewerAccountsFor(
  inventory: SiteToolAccountInventory,
  provider: ViewerLinkProvider,
): { accounts: ToolGatewayIdentity[]; connect: SessionLinkConnect | null } {
  const spec = PROVIDERS[provider];
  const connectors = [...inventory.canonical.entries()].filter(([, connect]) =>
    domainMatches(connect.providerDomain, spec.domains),
  );
  const ids = new Set(connectors.map(([id]) => id));
  const accounts = inventory.accounts.filter((account) => ids.has(account.canonicalServerId));
  const ordered = [
    ...accounts.filter((account) => account.shared !== true),
    ...accounts.filter((account) => account.shared === true),
  ];
  const capabilityId = connectors.find(([, connect]) => connect.capabilityId)?.[1].capabilityId;
  return {
    accounts: ordered.map((account) => ({ serverId: account.serverId, toolName: spec.toolName })),
    // Connect only where the workspace offers the connector.
    connect: connectors.length > 0 ? { name: spec.name, capabilityId: capabilityId ?? null } : null,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/gu, " ").trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** A tool result as JSON: structured content, else the first text part that parses. */
export function viewerToolResultValue(result: ToolGatewayResult): unknown {
  if ((result as { isError?: unknown }).isError === true) return null;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined && structured !== null) return structured;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const item = record(part);
    if (item.type !== "text" || typeof item.text !== "string") continue;
    try {
      return JSON.parse(item.text);
    } catch {
      continue;
    }
  }
  return null;
}

/** The schema's property names, to call a tool with the argument names it takes. */
function schemaProperties(entry: ToolGatewayCatalogEntry | undefined): Set<string> {
  const schema = record(entry?.inputSchema);
  return new Set(Object.keys(record(schema.properties)));
}

function pick(properties: Set<string>, names: readonly string[]): string | null {
  if (properties.size === 0) return names[0] ?? null;
  return names.find((name) => properties.has(name)) ?? null;
}

const LINEAR_FIELDS = ["title", "status", "statusType", "assignee"];

export function linearIssueArguments(
  entry: ToolGatewayCatalogEntry | undefined,
  identifier: string,
): Record<string, unknown> | null {
  const properties = schemaProperties(entry);
  const id = pick(properties, ["id", "issueId", "identifier"]);
  if (!id) return null;
  return { [id]: identifier, ...(properties.has("fields") ? { fields: LINEAR_FIELDS } : {}) };
}

function linearState(type: string | null, name: string | null): SessionLinkLiveStatus["state"] {
  // Without a state type, Linear's default state names.
  switch (type ?? linearTypeFromName(name)) {
    case "completed":
      return "done";
    case "canceled":
    case "cancelled":
    case "duplicate":
      return "closed";
    case "backlog":
    case "unstarted":
    case "started":
    case "triage":
      return "open";
    default:
      return "unknown";
  }
}

function linearTypeFromName(name: string | null): string | null {
  switch (name?.toLowerCase()) {
    case "done":
    case "completed":
      return "completed";
    case "canceled":
    case "cancelled":
    case "duplicate":
      return "canceled";
    case "backlog":
    case "todo":
    case "in progress":
    case "in review":
    case "triage":
      return "started";
    default:
      return null;
  }
}

/** A Linear issue's state, assignee and title from `get_issue`'s result. */
export function linearIssueStatus(value: unknown): SessionLinkLiveStatus | null {
  const top = record(value);
  const issue = Object.keys(record(top.issue)).length > 0 ? record(top.issue) : top;
  const title = text(issue.title, SESSION_LINK_TITLE_MAX_LENGTH);
  const status = issue.status ?? issue.state;
  const statusName = text(typeof status === "string" ? status : record(status).name, 80);
  const statusType =
    text(issue.statusType, 40)?.toLowerCase() ?? text(record(status).type, 40)?.toLowerCase();
  const assigneeValue = issue.assignee;
  const assignee = text(
    typeof assigneeValue === "string"
      ? assigneeValue
      : (record(assigneeValue).displayName ?? record(assigneeValue).name),
    SESSION_LINK_ASSIGNEE_MAX_LENGTH,
  );
  if (!title && !statusName) return null;
  return {
    state: linearState(statusType ?? null, statusName),
    label: statusName,
    title,
    checks: null,
    review: null,
    assignee,
  };
}

export function slackThreadArguments(
  entry: ToolGatewayCatalogEntry | undefined,
  thread: { channel: string; ts: string },
): Record<string, unknown> | null {
  const properties = schemaProperties(entry);
  const channel = pick(properties, ["channel", "channel_id"]);
  const ts = pick(properties, ["ts", "message_ts", "thread_ts"]);
  if (!channel || !ts) return null;
  return {
    [channel]: thread.channel,
    [ts]: thread.ts,
    ...(properties.has("limit") ? { limit: 1 } : {}),
  };
}

/** "1700000000.000100" -> ISO time, or null. */
function slackTime(ts: unknown): string | null {
  const seconds = typeof ts === "string" || typeof ts === "number" ? Number(ts) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Math.round(seconds * 1000)).toISOString();
}

/** A Slack thread's first message, reply count and last reply time from `slack_read_thread`. */
export function slackThreadStatus(
  value: unknown,
  link: Pick<SessionLink, "title">,
): SessionLinkLiveStatus | null {
  const messages = record(value).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const parent = record(messages[0]);
  const count = typeof parent.reply_count === "number" ? parent.reply_count : Number.NaN;
  // Unknown when the server leaves the count out, never "No replies".
  const replies = Number.isSafeInteger(count) && count >= 0 ? count : null;
  return {
    state: "unknown",
    label: null,
    // Its given title, else the first message.
    title: link.title ?? text(parent.text, SLACK_FIRST_MESSAGE_CHARS),
    checks: null,
    review: null,
    replies,
    lastReplyAt: replies !== 0 ? slackTime(parent.latest_reply) : null,
  };
}

function readOne(
  provider: ViewerLinkProvider,
  link: SessionLink,
  entry: ToolGatewayCatalogEntry | undefined,
): {
  args: Record<string, unknown>;
  parse: (value: unknown) => SessionLinkLiveStatus | null;
} | null {
  const classified = classifySessionLinkUrl(link.url);
  if (provider === "linear") {
    const identifier = classified?.linear?.identifier ?? link.ref;
    if (!identifier) return null;
    const args = linearIssueArguments(entry, identifier);
    return args ? { args, parse: linearIssueStatus } : null;
  }
  const [channel, ts] = classified?.slack
    ? [classified.slack.channel, classified.slack.ts]
    : (link.ref?.split("/", 2) ?? []);
  if (!channel || !ts) return null;
  const args = slackThreadArguments(entry, { channel, ts });
  return args ? { args, parse: (value) => slackThreadStatus(value, link) } : null;
}

/** Whether the viewer is a person who has connections of their own. */
export function viewerReadsOwnConnections(grant: AccessGrant): boolean {
  return grant.principalKind === undefined || grant.principalKind === "human_session";
}

const defaultIo: ViewerLinkReaderIo = {
  inventory: readSiteToolAccountInventory,
  async open(deps, grant, identities, signal) {
    const prepared: PreparedWorkspaceToolGateway = await prepareWorkspaceToolGatewayForGrant(
      deps,
      grant,
      identities,
      signal ? { signal } : {},
    );
    const entries = prepared.toolGatewayCatalog.entries;
    return {
      entry: (identity) =>
        entries.find(
          (each) =>
            each.identity.serverId === identity.serverId &&
            each.identity.toolName === identity.toolName,
        ),
      call: async (identity, args) =>
        (
          await callWorkspaceToolGateway(
            prepared,
            grant,
            { catalogDigest: prepared.toolGatewayCatalog.digest, identity, arguments: args },
            deps.db,
          )
        ).result,
      close: () => prepared.close(),
    };
  },
};

/**
 * One list read's viewer reader: the viewer's inventory is read once and the
 * gateway prepared once (for the accounts the links need), then each link
 * reads through it. `close` releases the gateway.
 */
export function viewerSessionLinkReader(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  links: readonly Pick<SessionLink, "provider" | "kind">[],
  io: ViewerLinkReaderIo = defaultIo,
  timeoutMs = VIEWER_READ_TIMEOUT_MS,
): { read: (link: SessionLink) => Promise<ViewerLinkRead>; close: () => Promise<void> } {
  let inventory: Promise<SiteToolAccountInventory | null> | null = null;
  let session: Promise<ViewerToolSession | null> | null = null;
  const accountsOf = async (provider: ViewerLinkProvider) => {
    inventory ??= io.inventory(deps, grant).catch(() => null);
    const read = await inventory;
    return read ? viewerAccountsFor(read, provider) : null;
  };
  const sessionFor = async () => {
    session ??= (async () => {
      // Only the connectors these links need.
      const needed = [
        ...new Set(
          links.map(viewerLinkProvider).filter((each): each is ViewerLinkProvider => !!each),
        ),
      ];
      const all = await Promise.all(needed.map(accountsOf));
      const identities = all.flatMap((each) => each?.accounts ?? []);
      if (identities.length === 0) return null;
      return await io
        .open(deps, grant, identities, AbortSignal.timeout(VIEWER_READ_TIMEOUT_MS))
        .catch(() => null);
    })();
    return await session;
  };
  return {
    async read(link) {
      const provider = viewerLinkProvider(link);
      if (!provider || !viewerReadsOwnConnections(grant)) return { kind: "none" };
      const read = async (): Promise<ViewerLinkRead> => {
        const found = await accountsOf(provider);
        if (!found) return { kind: "none" };
        if (found.accounts.length === 0)
          return found.connect ? { kind: "connect", connect: found.connect } : { kind: "none" };
        const tools = await sessionFor();
        if (!tools) return { kind: "none" };
        for (const identity of found.accounts.slice(0, ACCOUNTS_PER_LINK)) {
          const entry = tools.entry(identity);
          if (!entry) continue;
          const plan = readOne(provider, link, entry);
          if (!plan) continue;
          const result = await tools.call(identity, plan.args).catch(() => null);
          const status = result ? plan.parse(viewerToolResultValue(result)) : null;
          if (status) return { kind: "status", status };
        }
        return { kind: "none" };
      };
      return (await within(read(), timeoutMs)) ?? { kind: "none" };
    },
    async close() {
      const open = await session?.catch(() => null);
      await open?.close().catch(() => undefined);
    },
  };
}
