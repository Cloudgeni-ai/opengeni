import type { SessionNotificationPostedPayload, ToolAuthNeededPayload } from "./index";

/**
 * A connection card (connect, reconnect or more access) the agent is waiting
 * on needs the person, as an approval does. It is announced with the
 * session's ordinary notification, so it reaches the inbox and the phone and
 * marks the chat as needing them, and it is withdrawn once the card is done.
 * One notice per account or capability: a repeat card updates it in place.
 */
export const CONNECTION_CARD_NOTICE_PREFIX = "connection-card:";

/** Service names for connection identities whose domain says nothing to a person. */
const KNOWN_PROVIDER_NAMES: Record<string, string> = {
  "gmailmcp.googleapis.com": "Gmail",
  "drivemcp.googleapis.com": "Google Drive",
  "calendarmcp.googleapis.com": "Google Calendar",
};

const ACTIONABLE_REASONS = new Set<string>([
  "missing_connection",
  "expired",
  "insufficient_scope",
  "refresh_failed",
]);

/** 64-bit FNV-1a, hex: a short stable key for any card subject. */
function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

type NoticeCard = Pick<ToolAuthNeededPayload, "providerDomain"> & {
  /** The tool call that needed it; absent for a card found preparing the turn. */
  toolName?: string | null | undefined;
  connectionId?: string | null | undefined;
  capability?: { id: string; name?: string | undefined } | null | undefined;
  setupRequest?: { name?: string | undefined; endpointUrl?: string | undefined } | null | undefined;
};

/** The notice key for one card's account or capability. */
export function connectionCardNoticeKey(card: NoticeCard): string {
  // The card's own subject, as its continuation names it: an agent's
  // capability request, else the account, else the server it asked to add.
  const subject = card.capability
    ? `capability:${card.capability.id}`
    : card.connectionId
      ? `connection:${card.connectionId}`
      : card.setupRequest?.endpointUrl
        ? `server:${card.setupRequest.endpointUrl.trim().toLowerCase().replace(/\/+$/u, "")}`
        : `provider:${card.providerDomain.trim().toLowerCase()}`;
  return `${CONNECTION_CARD_NOTICE_PREFIX}${fnv1a64(subject)}`;
}

export function isConnectionCardNoticeKey(key: string): boolean {
  return key.startsWith(CONNECTION_CARD_NOTICE_PREFIX);
}

function serviceName(card: NoticeCard): string {
  const named = card.capability?.name ?? card.setupRequest?.name;
  if (named?.trim()) return named.trim();
  const domain = card.providerDomain.trim().toLowerCase();
  const known = KNOWN_PROVIDER_NAMES[domain];
  if (known) return known;
  const label = domain.replace(/^(?:www|api|mcp)\./u, "").split(".")[0] ?? "";
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "A connection";
}

/**
 * The notice announcing a card the agent waits on, or null for one it doesn't:
 * a card that only explains something unavailable, one found while preparing
 * the turn (no tool call needed it; it would announce itself every turn) and
 * Opengeni's own permissions, which are settings rather than a connection.
 */
export function connectionCardNotice(
  card: NoticeCard & { reason: string | null },
): SessionNotificationPostedPayload | null {
  if (!card.capability && !card.setupRequest) {
    if (!ACTIONABLE_REASONS.has(card.reason ?? "")) return null;
    if (!card.toolName?.trim()) return null;
    if (card.providerDomain.trim().toLowerCase() === "opengeni") return null;
  }
  const name = serviceName(card);
  const title =
    card.reason === "insufficient_scope"
      ? `${name} needs your permission`
      : card.reason === "expired" || card.reason === "refresh_failed"
        ? `Reconnect ${name}`
        : `Connect ${name}`;
  return {
    key: connectionCardNoticeKey(card),
    title: title.slice(0, 80),
    body: "The agent is waiting for you in this chat.",
    urgency: "normal",
    replaced: false,
  };
}
