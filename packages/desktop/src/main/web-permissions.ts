// What the account's web app may ask the operating system for. macOS asks the
// person about each privacy permission the app touches, so the window grants
// only what a shipped feature uses: the microphone for dictation and voice
// chats, the clipboard, full screen and pointer lock. The camera, screen
// sharing, Bluetooth, USB, serial and HID devices, location and the like are
// refused before Chromium reaches the device, so macOS never asks about them.

/** Permissions the account's own page may be granted when it asks. */
const REQUESTABLE = new Set([
  "media",
  "clipboard-sanitized-write",
  "clipboard-read",
  "fullscreen",
  "pointerLock",
]);

/** Permissions the account's own page may be told it already has. */
const CHECKABLE = new Set(["media", "clipboard-sanitized-write", "clipboard-read", "fullscreen"]);

/**
 * Whether a permission request from a page is granted. `trusted` is true only
 * for the account's own page in its own view. A media request is granted for
 * the microphone alone: a request that names the camera, or names nothing
 * (an unknown shape), is refused, and so is every media request while the
 * person has turned the microphone off on the This computer page.
 */
export function grantsPermissionRequest(
  trusted: boolean,
  permission: string,
  details: { mediaTypes?: readonly string[] | undefined; microphone?: boolean | undefined } = {},
): boolean {
  if (!trusted || !REQUESTABLE.has(permission)) return false;
  if (permission !== "media") return true;
  if (details.microphone === false) return false;
  const types = details.mediaTypes ?? [];
  return types.length > 0 && types.every((type) => type === "audio");
}

/**
 * Whether a permission check from a page reports the permission as granted.
 * A media check about the camera reports it as not granted, so the page never
 * offers a camera it cannot use; with the microphone turned off, no media is.
 */
export function grantsPermissionCheck(
  trusted: boolean,
  permission: string,
  details: { mediaType?: string | undefined; microphone?: boolean | undefined } = {},
): boolean {
  if (!trusted || !CHECKABLE.has(permission)) return false;
  if (permission !== "media") return true;
  return details.microphone !== false && details.mediaType !== "video";
}

/** The permission handlers of an Electron session. */
export interface PermissionHandlers {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
  setDevicePermissionHandler(handler: () => boolean): void;
}

/**
 * Refuses every permission in a session whose pages need none: the default
 * session, where the app's own local pages (the welcome view, the permission
 * guide) run. Electron grants everything there unless told otherwise.
 */
export function refuseAllPermissions(session: PermissionHandlers): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
}
