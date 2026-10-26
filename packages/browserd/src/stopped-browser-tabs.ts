import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isBlankTabUrl } from "./cdp-driver";

/**
 * Why a managed browser was relaunched. The browser process stopped and a new
 * one reopened the same pages; each reopened tab keeps the ID its page had, and
 * a tab ID no reopened tab took over names a tab that no longer exists:
 * - idle_release: the supervisor stopped it after it went unused for the idle
 *   release time; the session's next call relaunched it;
 * - controller_restart: its controller shut down (an agent update or
 *   restart), and the browser stopped then or while unused afterwards;
 * - browser_lost: the browser process ended unexpectedly (a crash, or the
 *   system or a person ended it) and was relaunched;
 * - state_capture: the browser restarted to save its profile state.
 */
export type BrowserRelaunchReason =
  | "idle_release"
  | "controller_restart"
  | "browser_lost"
  | "state_capture";

/** The tabs a browser had when it stopped, mapped to the browser's own IDs for
 * the tabs its successor reopened; each reopened tab keeps the stopped tab's ID.
 * A null replacement means no reopened tab shows the same page. */
export type BrowserRelaunchedTabs = {
  reason: BrowserRelaunchReason;
  /** The idle release time, for idle_release. */
  idleReleaseMinutes?: number;
  tabs: Array<{ targetId: string; replacementId: string | null }>;
};

/** A tab of a stopped browser. Its page is kept only as a SHA-256 of its URL,
 * enough to find the reopened tab showing the same page without writing page
 * addresses to disk; null for a blank tab, which never identifies a page. */
export type StoppedBrowserTab = { targetId: string; urlHash: string | null; selected: boolean };

/** The key a tab's page is matched by: a SHA-256 of its exact URL, or null
 * for a blank tab (a new tab, or a URL too long to report, which reads as
 * about:blank), since any number of unrelated tabs show one. */
export function tabUrlHash(url: string): string | null {
  return isBlankTabUrl(url) ? null : createHash("sha256").update(url).digest("hex");
}

/**
 * The tabs a managed browser had when its controller stopped it or let it go,
 * kept in the session directory until the next launch on the profile. A
 * relaunch reads it so each reopened tab keeps its earlier ID, and an agent
 * holding the ID of a tab that did not reopen learns why it is gone.
 */
export type StoppedBrowserTabsRecord = {
  version: 2;
  reason: Extract<BrowserRelaunchReason, "idle_release" | "controller_restart">;
  idleReleaseMinutes?: number;
  stoppedAt: string;
  tabs: StoppedBrowserTab[];
};

const RECORD_NAME = "stopped-browser-tabs.json";
const MAX_RECORD_BYTES = 256 * 1024;
export const MAX_STOPPED_BROWSER_TABS = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export async function writeStoppedBrowserTabs(
  sessionDirectory: string,
  record: StoppedBrowserTabsRecord,
): Promise<void> {
  const path = join(sessionDirectory, RECORD_NAME);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const bounded = { ...record, tabs: record.tabs.slice(0, MAX_STOPPED_BROWSER_TABS) };
  await writeFile(temporary, JSON.stringify(bounded), { mode: 0o600 });
  await rename(temporary, path);
}

/** Read and remove the record, so it describes only the launch right after
 * the stop it recorded. Null when there is none or it cannot be read. */
export async function takeStoppedBrowserTabs(
  sessionDirectory: string,
): Promise<StoppedBrowserTabsRecord | null> {
  const path = join(sessionDirectory, RECORD_NAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  await rm(path, { force: true }).catch(() => undefined);
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) return null;
  try {
    return parseStoppedBrowserTabs(JSON.parse(text));
  } catch {
    return null;
  }
}

function parseStoppedBrowserTabs(value: unknown): StoppedBrowserTabsRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 2) return null;
  if (record.reason !== "idle_release" && record.reason !== "controller_restart") return null;
  if (typeof record.stoppedAt !== "string" || !Array.isArray(record.tabs)) return null;
  const tabs: StoppedBrowserTab[] = [];
  for (const tab of record.tabs.slice(0, MAX_STOPPED_BROWSER_TABS)) {
    if (typeof tab !== "object" || tab === null) return null;
    const { targetId, urlHash, selected } = tab as Record<string, unknown>;
    if (typeof targetId !== "string" || !targetId) return null;
    if (urlHash !== null && (typeof urlHash !== "string" || !SHA256_HEX.test(urlHash))) return null;
    tabs.push({ targetId, urlHash, selected: selected === true });
  }
  const minutes = record.idleReleaseMinutes;
  return {
    version: 2,
    reason: record.reason,
    ...(typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
      ? { idleReleaseMinutes: minutes }
      : {}),
    stoppedAt: record.stoppedAt,
    tabs,
  };
}

/**
 * Pair each tab of the stopped browser with the reopened tab showing the same
 * page, by exact URL. A pair decides which tab an ID names from then on, so it
 * is made only when exactly one stopped tab and exactly one reopened tab show
 * that URL: tabs sharing a URL can't be told apart (the browser reopens them in
 * its own order, and its selected tab need not be the one the agent selected),
 * so none of them is paired. Blank tabs never match. A stopped tab whose ID
 * still exists is the same tab (the browser kept running) and is left out.
 */
export function matchReopenedTabs(
  stopped: readonly StoppedBrowserTab[],
  reopened: ReadonlyArray<{ id: string; url: string; selected: boolean; kind: string }>,
): BrowserRelaunchedTabs["tabs"] {
  const pages = reopened
    .filter((target) => target.kind === "page" || target.kind === "popup")
    .map((target) => ({ ...target, urlHash: tabUrlHash(target.url) }));
  const live = new Set(pages.map((target) => target.id));
  const stoppedIds = new Set(stopped.map((tab) => tab.targetId));
  const gone: StoppedBrowserTab[] = [];
  for (const tab of stopped) {
    if (!live.has(tab.targetId) && !gone.some((seen) => seen.targetId === tab.targetId))
      gone.push(tab);
  }
  const reopenedPages = pages.filter((target) => !stoppedIds.has(target.id));
  return gone.map((tab) => {
    if (tab.urlHash === null) return { targetId: tab.targetId, replacementId: null };
    const sameStopped = gone.filter((other) => other.urlHash === tab.urlHash);
    const sameReopened = reopenedPages.filter((target) => target.urlHash === tab.urlHash);
    return {
      targetId: tab.targetId,
      replacementId:
        sameStopped.length === 1 && sameReopened.length === 1 ? sameReopened[0]!.id : null,
    };
  });
}

/** A tab ID callers hold and the browser's own ID for the open tab it names. */
export type BrowserTabIdPair = { tabId: string; browserTargetId: string };

/**
 * The tab IDs a running managed browser's tabs have that differ from the
 * browser's own IDs for them (tabs a relaunched browser reopened keep their
 * earlier IDs). Kept in the session directory while that browser runs, so a
 * controller that reattaches to it after a restart gives its tabs the same
 * IDs. A relaunch replaces it.
 */
type BrowserTabIdsRecord = { version: 1; tabs: BrowserTabIdPair[] };

const TAB_IDS_NAME = "browser-tab-ids.json";
const MAX_TAB_ID_LENGTH = 256;

export async function writeBrowserTabIds(
  sessionDirectory: string,
  tabs: readonly BrowserTabIdPair[],
): Promise<void> {
  const path = join(sessionDirectory, TAB_IDS_NAME);
  if (tabs.length === 0) {
    await rm(path, { force: true });
    return;
  }
  const record: BrowserTabIdsRecord = {
    version: 1,
    tabs: tabs.slice(0, MAX_STOPPED_BROWSER_TABS).map(({ tabId, browserTargetId }) => ({
      tabId,
      browserTargetId,
    })),
  };
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, path);
}

/** The recorded tab IDs; empty when there are none or they cannot be read. */
export async function readBrowserTabIds(sessionDirectory: string): Promise<BrowserTabIdPair[]> {
  let text: string;
  try {
    text = await readFile(join(sessionDirectory, TAB_IDS_NAME), "utf8");
  } catch {
    return [];
  }
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) return [];
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.tabs)) return [];
    const tabs: BrowserTabIdPair[] = [];
    for (const tab of record.tabs.slice(0, MAX_STOPPED_BROWSER_TABS)) {
      if (typeof tab !== "object" || tab === null) return [];
      const { tabId, browserTargetId } = tab as Record<string, unknown>;
      if (!isTabId(tabId) || !isTabId(browserTargetId)) return [];
      tabs.push({ tabId, browserTargetId });
    }
    return tabs;
  } catch {
    return [];
  }
}

function isTabId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TAB_ID_LENGTH;
}
