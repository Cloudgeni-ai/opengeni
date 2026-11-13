import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import {
  NOTIFICATION_SUBTITLE_MAX_CHARS,
  SessionNotificationPostedPayload,
  type ConnectionMetadata,
} from "@opengeni/contracts";
import { errorMessage } from "@opengeni/contracts/values";
import {
  getConnectionMetadata,
  listConnectionsMetadata,
  type ConnectionNeedsReauth,
  type Database,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { listOwnConnectionMetadata } from "./personal-connection-delegations";
import {
  catalogProviderDomain,
  INTEGRATION_BACKEND_PROJECTION_KEY,
  projectConnectionsForBackends,
  type NangoBackends,
} from "./nango-integrations";

/**
 * A connection that exists but stopped working: its provider rejected the
 * stored sign-in (`needs_reauth`), so nothing can use it until its owner signs
 * in again. Reconnecting keeps the same connection, its settings and grants.
 */
export type ConnectionNeedingReconnect = {
  connectionId: string;
  providerDomain: string;
  /** The MCP endpoint it was connected for, when it is an MCP account. */
  mcpUrl: string | null;
  /** The person's own account, or a connection the whole workspace shares. */
  ownership: "personal" | "workspace";
  /** Which account it is, as the provider named it (for example an email). */
  account: string;
  /** When it stopped working: its last status change. */
  since: string;
  /**
   * Added in this workspace, so a card here can reconnect it. A personal
   * account added in another workspace is reconnected where it was added.
   */
  addedHere: boolean;
};

function needingReconnect(
  connection: ConnectionMetadata,
  workspaceId: string,
): ConnectionNeedingReconnect {
  const mcpUrl = connection.metadata.mcpUrl;
  return {
    connectionId: connection.id,
    providerDomain: connection.providerDomain,
    mcpUrl: typeof mcpUrl === "string" && mcpUrl ? mcpUrl : null,
    ownership: connection.subjectId === null ? "workspace" : "personal",
    account: connectionAccountIdentityLabel(connection.metadata, connection.providerDomain),
    since: connection.updatedAt,
    addedHere: connection.workspaceId === workspaceId,
  };
}

/**
 * The connections this person could reconnect that stopped working: the
 * workspace's shared connections and the person's own accounts, wherever in
 * the organization they were added. Read only to tell the person and offer
 * the right reconnect card; never used to select or resolve credentials.
 * `subjectId` null lists only the workspace's shared connections.
 */
export async function listConnectionsNeedingReconnect(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string | null;
    /** The integration backend switch; native accounts of a Nango-backed service need reconnecting. */
    integrationBackends?: NangoBackends;
  },
): Promise<ConnectionNeedingReconnect[]> {
  const backends = input.integrationBackends ?? new Map();
  const shared = projectConnectionsForBackends(
    await listConnectionsMetadata(db, input.workspaceId, null),
    backends,
  ).filter(
    (connection) =>
      connection.subjectId === null &&
      connection.accountId === input.accountId &&
      connection.status === "needs_reauth",
  );
  // `db` may be one bounded transaction: these reads must not overlap.
  const own = input.subjectId
    ? projectConnectionsForBackends(
        await listOwnConnectionMetadata(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          reach: "anywhere",
          includeInactive: true,
        }),
        backends,
      ).filter((connection) => connection.status === "needs_reauth")
    : [];
  return (
    [...shared, ...own]
      // Already replaced by a Nango connection of the same owner.
      .filter(
        (connection) => connection.metadata[INTEGRATION_BACKEND_PROJECTION_KEY] !== "superseded",
      )
      .map((connection) => needingReconnect(connection, input.workspaceId))
      .sort(
        (left, right) =>
          left.providerDomain.localeCompare(right.providerDomain) ||
          left.account.localeCompare(right.account) ||
          left.connectionId.localeCompare(right.connectionId),
      )
  );
}

function sameEndpoint(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\/+$/u, "").toLowerCase();
  return normalize(left) === normalize(right);
}

/**
 * The ones that belong to one connector or catalog entry: same provider and,
 * when both name one, the same MCP endpoint.
 */
export function connectionsNeedingReconnectFor(
  connections: readonly ConnectionNeedingReconnect[],
  target: { providerDomain?: string | null | undefined; mcpUrl?: string | null | undefined },
): ConnectionNeedingReconnect[] {
  const domain = target.providerDomain?.trim().toLowerCase();
  if (!domain) return [];
  // A connector served through Nango still names its catalog service.
  const service = catalogProviderDomain(domain);
  return connections.filter(
    (connection) =>
      catalogProviderDomain(connection.providerDomain.toLowerCase()) === service &&
      (!connection.mcpUrl || !target.mcpUrl || sameEndpoint(connection.mcpUrl, target.mcpUrl)),
  );
}

/** "2026-10-29": the day it stopped working, for the agent's own words. */
export function connectionReconnectDay(since: string): string {
  const parsed = new Date(since);
  return Number.isNaN(parsed.getTime()) ? since : parsed.toISOString().slice(0, 10);
}

/** A calm service name for a provider domain the person would not recognize. */
const PROVIDER_NAMES: Record<string, string> = {
  "gmailmcp.googleapis.com": "Gmail",
  "drivemcp.googleapis.com": "Google Drive",
  "calendarmcp.googleapis.com": "Google Calendar",
};

function providerName(providerDomain: string): string {
  const host = providerDomain
    .trim()
    .toLowerCase()
    .replace(/^www\./u, "");
  const known = PROVIDER_NAMES[host];
  if (known) return known;
  const first = host.split(".")[0] ?? host;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : providerDomain;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** One notice per connection: a later break of the same connection updates it. */
export function connectionNeedsReauthNoticeKey(connectionId: string): string {
  return `connection-reconnect-${connectionId}`;
}

export type ConnectionNeedsReauthNoticeDeps = {
  db: Database;
  bus: EventBus;
  observability?: Pick<Observability, "warn"> | undefined;
};

/**
 * Tell the owner, once, that a connection just stopped working. Called only
 * by the broker transition that moved it from active to needs_reauth, so a
 * later failed use of the same broken connection never notifies again. The
 * notice lives on the chat whose use found it, addressed to the person whose
 * message that turn ran for (the owner of a personal account, which only its
 * owner's turns use), so it reaches their inbox and phone. A break found
 * outside a chat turn has no chat to carry it; the connection's own status
 * still says it needs reconnecting.
 */
export async function postConnectionNeedsReauthNotice(
  deps: ConnectionNeedsReauthNoticeDeps,
  broken: ConnectionNeedsReauth,
): Promise<void> {
  const use = broken.use;
  if (!use) return;
  try {
    const connection = await getConnectionMetadata(
      deps.db,
      broken.workspaceId,
      broken.connectionId,
      broken.subjectId,
    );
    const service = providerName(broken.providerDomain);
    const account = connection ? connectionAccountIdentityLabel(connection.metadata, "") : "";
    const payload = SessionNotificationPostedPayload.parse({
      key: connectionNeedsReauthNoticeKey(broken.connectionId),
      title: `${service} needs reconnecting`,
      ...(account ? { subtitle: clip(account, NOTIFICATION_SUBTITLE_MAX_CHARS) } : {}),
      body: `${service} stopped accepting ${
        account ? `the sign-in for ${account}` : "its saved sign-in"
      }, so agents can't use it until it is reconnected. Reconnect it from Connections in settings, or from the card an agent shows when it needs it; reconnecting keeps the same connection and its settings.`,
      urgency: "normal",
      replaced: false,
    });
    await appendAndPublishEvents(deps.db, deps.bus, use.workspaceId, use.sessionId, [
      {
        type: "session.notification.posted",
        payload,
        turnId: use.turnId,
        turnGeneration: use.executionGeneration,
        turnAttemptId: use.attemptId,
      },
    ] as Parameters<typeof appendAndPublishEvents>[4]);
  } catch (error) {
    // The connection's status still shows it needs reconnecting.
    deps.observability?.warn("Connection reconnect notice was not posted", {
      connectionId: broken.connectionId,
      error: errorMessage(error),
    });
  }
}
