import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Why a managed browser's tabs got new IDs. The browser process stopped and a
 * new one reopened the same pages, so every tab ID an agent still holds names
 * a tab that no longer exists:
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

/** The tabs a browser had when it stopped, mapped to the tabs its successor
 * reopened. A null replacement means no reopened tab shows the same page. */
export type BrowserRelaunchedTabs = {
  reason: BrowserRelaunchReason;
  /** The idle release time, for idle_release. */
  idleReleaseMinutes?: number;
  tabs: Array<{ targetId: string; replacementId: string | null }>;
};

export type StoppedBrowserTab = { targetId: string; url: string; selected: boolean };

/**
 * The tabs a managed browser had when its controller stopped it or let it go,
 * kept in the session directory until the next launch on the profile. A
 * relaunch reads it to tell an agent still holding an old tab ID why that tab
 * is gone and which reopened tab shows its page.
 */
export type StoppedBrowserTabsRecord = {
  version: 1;
  reason: Extract<BrowserRelaunchReason, "idle_release" | "controller_restart">;
  idleReleaseMinutes?: number;
  stoppedAt: string;
  tabs: StoppedBrowserTab[];
};

const RECORD_NAME = "stopped-browser-tabs.json";
const MAX_RECORD_BYTES = 256 * 1024;
export const MAX_STOPPED_BROWSER_TABS = 64;

export async function writeStoppedBrowserTabs(
  sessionDirectory: string,
  record: StoppedBrowserTabsRecord,
): Promise<void> {
  const path = join(sessionDirectory, RECORD_NAME);
  const temporary = `${path}.${process.pid}.tmp`;
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
  if (record.version !== 1) return null;
  if (record.reason !== "idle_release" && record.reason !== "controller_restart") return null;
  if (typeof record.stoppedAt !== "string" || !Array.isArray(record.tabs)) return null;
  const tabs: StoppedBrowserTab[] = [];
  for (const tab of record.tabs.slice(0, MAX_STOPPED_BROWSER_TABS)) {
    if (typeof tab !== "object" || tab === null) return null;
    const { targetId, url, selected } = tab as Record<string, unknown>;
    if (typeof targetId !== "string" || !targetId || typeof url !== "string") return null;
    tabs.push({ targetId, url, selected: selected === true });
  }
  const minutes = record.idleReleaseMinutes;
  return {
    version: 1,
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
 * page. Tabs are matched by exact URL, each reopened tab at most once, the
 * previously selected tab first so it gets the reopened selected tab when
 * several show the same page. A stopped tab whose ID still exists is the same
 * tab (the browser kept running) and is left out.
 */
export function matchReopenedTabs(
  stopped: readonly StoppedBrowserTab[],
  reopened: ReadonlyArray<{ id: string; url: string; selected: boolean; kind: string }>,
): BrowserRelaunchedTabs["tabs"] {
  const pages = reopened.filter((target) => target.kind === "page" || target.kind === "popup");
  const live = new Set(pages.map((target) => target.id));
  const used = new Set<string>();
  const ordered = [
    ...stopped.filter((tab) => tab.selected),
    ...stopped.filter((tab) => !tab.selected),
  ];
  const matches = new Map<string, string | null>();
  for (const tab of ordered) {
    if (live.has(tab.targetId) || matches.has(tab.targetId)) continue;
    const candidates = pages.filter(
      (target) => !used.has(target.id) && !stopped.some((s) => s.targetId === target.id),
    );
    const match =
      candidates.find((target) => target.url === tab.url && target.selected === tab.selected) ??
      candidates.find((target) => target.url === tab.url) ??
      null;
    if (match) used.add(match.id);
    matches.set(tab.targetId, match?.id ?? null);
  }
  return stopped
    .filter((tab) => matches.has(tab.targetId))
    .map((tab) => ({ targetId: tab.targetId, replacementId: matches.get(tab.targetId) ?? null }));
}
