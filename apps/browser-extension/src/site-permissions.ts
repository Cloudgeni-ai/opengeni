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
};

export const SITE_PERMISSIONS_PAGE = "site-permissions.html";
const CONTENT_SETTINGS: chrome.permissions.Permissions = { permissions: ["contentSettings"] };
const STORAGE_KEY = "sitePermissions";
const MAX_ENTRIES = 1_000;

export class SitePermissionError extends Error {
  constructor(
    readonly code: "consent_required" | "tab_changed" | "invalid_request",
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
    throw new SitePermissionError("invalid_request", "site permission origin is invalid");
  }
  // Only plain host names and IP addresses: in a pattern `*` or `[*.]`
  // would widen it to other sites.
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== origin ||
    !/^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/u.test(url.hostname)
  ) {
    throw new SitePermissionError("invalid_request", "site permission origin is invalid");
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//${url.hostname}:${port}/*`;
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
  return serialized(async () => ({ allowed: await allowed(), entries: await storedEntries() }));
}

/**
 * Sets one permission for one site, for a tab this extension is controlling
 * that shows that site. `prompt` removes the agent's setting, so the site
 * follows the person's own choice again. Without the person's consent it
 * opens the page that asks for it and sets nothing.
 */
export function setSitePermission(
  request: { origin: string; permission: SitePermission; setting: SitePermissionSetting },
  controlledTabs: () => Promise<chrome.tabs.Tab[]>,
): Promise<{ origin: string; setting: SitePermissionSetting }> {
  return serialized(async () => {
    const pattern = sitePattern(request.origin);
    if (!(await allowed())) {
      await openSitePermissionsPage();
      throw new SitePermissionError(
        "consent_required",
        "the person has not allowed site permissions in this Chrome profile",
      );
    }
    const tabs = await controlledTabs();
    const showing = tabs.some((tab) => {
      if (tab.incognito || !tab.url) return false;
      try {
        return new URL(tab.url).origin === request.origin;
      } catch {
        return false;
      }
    });
    if (!showing) {
      throw new SitePermissionError("tab_changed", "no controlled tab shows this site now");
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
      throw new SitePermissionError("invalid_request", "too many site permissions are set");
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
      await storeEntries([]);
      await chrome.permissions.remove(CONTENT_SETTINGS);
    }
    return { allowed: await allowed(), entries: await storedEntries() };
  });
}

/** Shows the page that asks the person, reusing one already open. */
export async function openSitePermissionsPage(): Promise<void> {
  const url = chrome.runtime.getURL(SITE_PERMISSIONS_PAGE);
  const [open] = await chrome.tabs.query({ url });
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { active: true });
    return;
  }
  try {
    await chrome.tabs.create({ url, active: true });
  } catch {
    // Chrome is running with no window to put a tab in.
    await chrome.windows.create({ url, focused: false });
  }
}
