/**
 * Site permissions an agent sets in this Chrome profile: camera, microphone,
 * location and notifications, each for one exact site (scheme, host and
 * port). Chrome lets an extension do this only through `contentSettings`,
 * which this extension asks for as an optional permission, once, from its own
 * page; until the person allows it, nothing can be set. Every change is kept
 * in a list the person sees in the popup and on that page, and can remove.
 */

/** The permissions Chrome lets an extension set for a site, by the names
 * the agent's permission action uses. Chrome calls geolocation `location`. */
export const SITE_PERMISSIONS = ["camera", "microphone", "geolocation", "notifications"] as const;
export type SitePermission = (typeof SITE_PERMISSIONS)[number];
export type SitePermissionSetting = "granted" | "denied" | "prompt";

export const SITE_PERMISSION_LABELS: Readonly<Record<SitePermission, string>> = {
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  notifications: "Notifications",
};

/** A permission an agent set and that is still in effect. */
export type SitePermissionEntry = {
  /** The site, as `https://example.com` (the default port left out). */
  origin: string;
  /** The Chrome pattern it was set for: the site with its port always given,
   * because a pattern without a port matches every port of the host. */
  pattern: string;
  permission: SitePermission;
  setting: "granted" | "denied";
  setAt: string;
};

/** What the popup and the page show. */
export type SitePermissionsState = {
  /** The person allowed this extension to set site permissions. */
  allowed: boolean;
  entries: SitePermissionEntry[];
  /** What an agent last asked for while the person had not allowed it. */
  request?: SitePermissionRequest;
};

/** A permission an agent asked to set before the person allowed it. */
export type SitePermissionRequest = {
  origin: string;
  permission: SitePermission;
  setting: SitePermissionSetting;
};

export const SITE_PERMISSIONS_PAGE = "site-permissions.html";
const CONTENT_SETTINGS: chrome.permissions.Permissions = { permissions: ["contentSettings"] };
const STORAGE_KEY = "sitePermissions";
const REQUEST_KEY = "sitePermissionRequest";
// The page asking the person was shown in this profile (or they turned it
// off): an agent's request does not open it again, so closing it, or Not
// now, is a lasting answer until they open it themselves.
const PAGE_SHOWN_KEY = "sitePermissionsPageShown";
const MAX_ENTRIES = 1_000;

export class SitePermissionError extends Error {
  constructor(
    readonly code:
      | "consent_required"
      | "consent_declined"
      | "not_opened_by_agent"
      | "tab_changed"
      | "unsupported_site"
      | "limit_reached",
    message: string,
  ) {
    super(message);
  }
}

export function isSitePermission(value: unknown): value is SitePermission {
  return (SITE_PERMISSIONS as readonly unknown[]).includes(value);
}

/** The exact site of an `http:` or `https:` address, as Chrome's
 * content-setting pattern: `https://example.com:443/*`. */
export function sitePattern(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw unsupportedSite();
  }
  // Only plain host names and IP addresses: in a pattern `*` or `[*.]`
  // would widen it to other sites.
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== origin ||
    !/^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/u.test(url.hostname)
  ) {
    throw unsupportedSite();
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//${url.hostname}:${port}/*`;
}

function unsupportedSite(): SitePermissionError {
  return new SitePermissionError(
    "unsupported_site",
    "only http and https sites with a plain host name or IP address can be given a permission",
  );
}

function contentSetting(permission: SitePermission): chrome.contentSettings.ContentSetting<string> {
  const settings = chrome.contentSettings as unknown as Record<
    string,
    chrome.contentSettings.ContentSetting<string>
  >;
  return settings[permission === "geolocation" ? "location" : permission]!;
}

async function allowed(): Promise<boolean> {
  return await chrome.permissions.contains(CONTENT_SETTINGS);
}

async function storedEntries(): Promise<SitePermissionEntry[]> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
  const entries = stored[STORAGE_KEY];
  return Array.isArray(entries) ? (entries as SitePermissionEntry[]) : [];
}

async function storeEntries(entries: SitePermissionEntry[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: entries });
}

// One change at a time: removing one site's permission clears every site's
// rule for that permission and sets the others again.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

/** Chrome removes one extension's rules only all at once per permission, so
 * clear them and set the remaining ones again. */
async function reapply(permission: SitePermission, entries: SitePermissionEntry[]): Promise<void> {
  const setting = contentSetting(permission);
  await setting.clear({});
  for (const entry of entries) {
    if (entry.permission !== permission) continue;
    await setting.set({
      primaryPattern: entry.pattern,
      setting: entry.setting === "granted" ? "allow" : "block",
    });
  }
}

export function sitePermissionsState(): Promise<SitePermissionsState> {
  return serialized(async () => {
    const isAllowed = await allowed();
    const stored = (await chrome.storage.local.get(REQUEST_KEY)) as Record<string, unknown>;
    const request = stored[REQUEST_KEY] as SitePermissionRequest | null | undefined;
    // Answered: a request from before the person allowed it is not shown
    // again if the permission is later given back some other way.
    if (isAllowed && request) await chrome.storage.local.set({ [REQUEST_KEY]: null });
    return {
      allowed: isAllowed,
      entries: await storedEntries(),
      ...(!isAllowed && request ? { request } : {}),
    };
  });
}

/**
 * Sets one permission for one site, which the exact tab the agent acts in
 * must show under the attachment the agent holds (`controlledTab` answers
 * that tab only while that attachment lasts); that tab must be one an agent
 * opened. `prompt` removes the agent's setting, so the site follows the
 * person's own choice again. Without the person's consent it sets nothing
 * and opens the page that asks for it, in front, only the first time: an
 * agent trying again never takes the person's tab away, and once they closed
 * that page it stays closed.
 */
export function setSitePermission(
  request: SitePermissionRequest & { tabId: string; attachment: number },
  tabs: {
    openedByAgent: (tabId: string) => boolean;
    controlledTab: (tabId: string, attachment: number) => Promise<chrome.tabs.Tab | null>;
  },
): Promise<{ origin: string; setting: SitePermissionSetting }> {
  return serialized(async () => {
    const pattern = sitePattern(request.origin);
    if (!(await allowed())) {
      await chrome.storage.local.set({
        [REQUEST_KEY]: {
          origin: request.origin,
          permission: request.permission,
          setting: request.setting,
        } satisfies SitePermissionRequest,
      });
      if (!(await askOnce())) {
        throw new SitePermissionError(
          "consent_declined",
          "the person was asked and has not allowed site permissions in this Chrome profile",
        );
      }
      throw new SitePermissionError(
        "consent_required",
        "the person has not allowed site permissions in this Chrome profile",
      );
    }
    if (!tabs.openedByAgent(request.tabId)) {
      throw new SitePermissionError(
        "not_opened_by_agent",
        "site permissions can be set only in a tab an agent opened",
      );
    }
    const tab = await tabs.controlledTab(request.tabId, request.attachment);
    if (!tab || tab.incognito || !tab.url || tabOrigin(tab.url) !== request.origin) {
      throw new SitePermissionError(
        "tab_changed",
        "the agent's tab no longer shows this site under its attachment",
      );
    }
    const entries = await storedEntries();
    const others = entries.filter(
      (entry) => entry.pattern !== pattern || entry.permission !== request.permission,
    );
    if (request.setting === "prompt") {
      // Nothing to undo when no agent set this permission for this site.
      if (others.length < entries.length) {
        await reapply(request.permission, others);
        await storeEntries(others);
      }
      return { origin: request.origin, setting: request.setting };
    }
    if (others.length >= MAX_ENTRIES) {
      throw new SitePermissionError(
        "limit_reached",
        `agents already set ${MAX_ENTRIES} site permissions in this profile`,
      );
    }
    await contentSetting(request.permission).set({
      primaryPattern: pattern,
      setting: request.setting === "granted" ? "allow" : "block",
    });
    await storeEntries([
      ...others,
      {
        origin: request.origin,
        pattern,
        permission: request.permission,
        setting: request.setting,
        setAt: new Date().toISOString(),
      },
    ]);
    return { origin: request.origin, setting: request.setting };
  });
}

function tabOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The person removes one change, from the popup or the page. */
export function removeSitePermission(
  pattern: string,
  permission: SitePermission,
): Promise<SitePermissionsState> {
  return serialized(async () => {
    const entries = await storedEntries();
    if (!(await allowed())) return { allowed: false, entries };
    const others = entries.filter(
      (entry) => entry.pattern !== pattern || entry.permission !== permission,
    );
    await reapply(permission, others);
    await storeEntries(others);
    return { allowed: true, entries: others };
  });
}

/** The person turns it off: every change is removed first, because Chrome
 * keeps an extension's rules in force after it gives up the permission, and
 * then it can no longer remove them. */
export function turnOffSitePermissions(): Promise<SitePermissionsState> {
  return serialized(async () => {
    if (await allowed()) {
      for (const permission of SITE_PERMISSIONS) await reapply(permission, []);
      // An earlier agent's request is not a reason to allow it again.
      await chrome.storage.local.set({ [STORAGE_KEY]: [], [REQUEST_KEY]: null });
      await chrome.permissions.remove(CONTENT_SETTINGS);
    }
    // Turned off on purpose: no agent opens the page again.
    await chrome.storage.local.set({ [PAGE_SHOWN_KEY]: true });
    return { allowed: await allowed(), entries: await storedEntries() };
  });
}

/** For an agent's request: whether the page asking the person is open,
 * opening it in front only if it was never shown in this profile. One
 * already open stays where it is. */
async function askOnce(): Promise<boolean> {
  const url = chrome.runtime.getURL(SITE_PERMISSIONS_PAGE);
  const [open] = await chrome.tabs.query({ url });
  if (open) return true;
  const stored = (await chrome.storage.local.get(PAGE_SHOWN_KEY)) as Record<string, unknown>;
  if (stored[PAGE_SHOWN_KEY] === true) return false;
  await openSitePermissionsPage({ bringForward: false });
  return true;
}

/** Shows the page that asks the person, reusing one already open, which is
 * brought forward only when the person asked for it (from the popup). */
export async function openSitePermissionsPage(options: { bringForward: boolean }): Promise<void> {
  await chrome.storage.local.set({ [PAGE_SHOWN_KEY]: true });
  const url = chrome.runtime.getURL(SITE_PERMISSIONS_PAGE);
  const [open] = await chrome.tabs.query({ url });
  if (open?.id !== undefined) {
    if (options.bringForward) await chrome.tabs.update(open.id, { active: true });
    return;
  }
  try {
    await chrome.tabs.create({ url, active: true });
  } catch {
    // Chrome is running with no window to put a tab in.
    await chrome.windows.create({ url, focused: false });
  }
}
