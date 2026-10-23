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
 * (an unknown shape), is refused.
 */
export function grantsPermissionRequest(
  trusted: boolean,
  permission: string,
  details: { mediaTypes?: readonly string[] | undefined } = {},
): boolean {
  if (!trusted || !REQUESTABLE.has(permission)) return false;
  if (permission !== "media") return true;
  const types = details.mediaTypes ?? [];
  return types.length > 0 && types.every((type) => type === "audio");
}

/**
 * Whether a permission check from a page reports the permission as granted.
 * A media check about the camera reports it as not granted, so the page never
 * offers a camera it cannot use.
 */
export function grantsPermissionCheck(
  trusted: boolean,
  permission: string,
  details: { mediaType?: string | undefined } = {},
): boolean {
  if (!trusted || !CHECKABLE.has(permission)) return false;
  return permission !== "media" || details.mediaType !== "video";
}
