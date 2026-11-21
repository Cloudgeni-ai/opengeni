/**
 * The platform's connect card for an App (Site): the connected tools the App
 * declares that the viewer still has to connect or reconnect, with one
 * action each. Framework-free so the console (React) and the published-App
 * shell (plain DOM) show the same items, labels and dismissals.
 *
 * Host data (`ToolGatewaySiteSetupResponse`) carries ids and addresses; Site
 * code only ever receives `OpenGeniSiteConnectionStatus`.
 */
import type { ToolGatewayIdentity, ToolGatewaySiteSetupItem } from "./types";

/** One thing the viewer still has to do before some of the App's tools work. */
export type OpenGeniSiteConnectionNeed = {
  /** Pass to `site.connections.connect(key)` to start that one action. */
  key: string;
  /** `connect`: no account yet. `reconnect`: their account must sign in again. */
  action: "connect" | "reconnect";
  /** The connector ("Gmail"). */
  connector: string;
  /** The account to sign in again, for `reconnect`. */
  account: string | null;
  /** The button's words: "Connect Gmail", "Reconnect Gmail". */
  label: string;
  /** The App's declared tools that wait on it. */
  tools: ToolGatewayIdentity[];
};

/** What `site.connections.status()` resolves. */
export type OpenGeniSiteConnectionStatus = {
  /** False when the host can't tell (local previews, older hosts, people outside the workspace). */
  supported: boolean;
  /** True when nothing is left to connect. */
  ready: boolean;
  needed: OpenGeniSiteConnectionNeed[];
};

/** The one action of a card item, in plain words. */
export function siteConnectCardLabel(item: Pick<ToolGatewaySiteSetupItem, "action" | "connector">) {
  return `${item.action === "reconnect" ? "Reconnect" : "Connect"} ${item.connector}`;
}

/** The host's card items as Site code may see them: no ids, no addresses. */
export function siteConnectionStatus(
  items: readonly ToolGatewaySiteSetupItem[] | null,
): OpenGeniSiteConnectionStatus {
  if (!items) return { supported: false, ready: true, needed: [] };
  const needed = items.map((item) => ({
    key: item.key,
    action: item.action,
    connector: item.connector,
    account: item.account,
    label: siteConnectCardLabel(item),
    tools: item.tools.map((tool) => ({ serverId: tool.serverId, toolName: tool.toolName })),
  }));
  return { supported: true, ready: needed.length === 0, needed };
}

/** A host's answer to `site.connections.status()`, checked before it reaches Site code. */
export function isOpenGeniSiteConnectionStatus(
  value: unknown,
): value is OpenGeniSiteConnectionStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Partial<OpenGeniSiteConnectionStatus>;
  return (
    typeof status.supported === "boolean" &&
    typeof status.ready === "boolean" &&
    Array.isArray(status.needed) &&
    status.needed.every(
      (need) =>
        typeof need === "object" &&
        need !== null &&
        typeof need.key === "string" &&
        (need.action === "connect" || need.action === "reconnect") &&
        typeof need.connector === "string" &&
        typeof need.label === "string" &&
        Array.isArray(need.tools),
    )
  );
}

export const SITE_CONNECT_CARD_DISMISSED_PREFIX = "opengeni.appConnectCard.dismissed:";

type CardStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Which card items the viewer closed, per App, kept in the host's own
 * storage. A dismissed item stays hidden until something new is missing
 * (a new item key) or the App asks to show the card again. Storage that
 * can't be read or written (private mode, quotas) just forgets.
 */
export function siteConnectCardDismissals(siteId: string, storage?: CardStorage | null) {
  const store = storage === undefined ? defaultStorage() : storage;
  const key = `${SITE_CONNECT_CARD_DISMISSED_PREFIX}${siteId}`;
  const read = (): Set<string> => {
    try {
      const parsed: unknown = JSON.parse(store?.getItem(key) ?? "[]");
      return new Set(
        Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [],
      );
    } catch {
      return new Set();
    }
  };
  return {
    /** The items still to show. */
    visible<T extends { key: string }>(items: readonly T[]): T[] {
      const dismissed = read();
      return items.filter((item) => !dismissed.has(item.key));
    },
    /** Hide these items (the card's close button). Keeps at most 64 keys. */
    dismiss(keys: readonly string[]): void {
      const next = [...new Set([...read(), ...keys])].slice(-64);
      try {
        store?.setItem(key, JSON.stringify(next));
      } catch {
        // Not remembered; the card closes for this page only.
      }
    },
    /** Show every item again (the App called `site.connections.showCard()`). */
    reset(): void {
      try {
        store?.removeItem(key);
      } catch {
        // Nothing was remembered.
      }
    },
  };
}

function defaultStorage(): CardStorage | null {
  try {
    return (globalThis as { localStorage?: CardStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}
