export type DesktopOs = "macos" | "windows" | "linux";

export type BrowserDevice = { kind: "handheld" } | { kind: "desktop"; os: DesktopOs } | null;

/**
 * The device this page runs on, as far as its browser says for sure: a phone
 * or tablet, a desktop system, or null when it can't tell. A connected
 * computer on another system is certainly not this device.
 */
export function browserDevice(userAgent: string | undefined, maxTouchPoints = 0): BrowserDevice {
  if (!userAgent) return null;
  if (/iPhone|iPad|iPod|Android/u.test(userAgent)) return { kind: "handheld" };
  // iPadOS asks for desktop pages as a Mac; only its touch screen tells.
  if (/Macintosh/u.test(userAgent) && maxTouchPoints > 1) return { kind: "handheld" };
  if (/Windows/u.test(userAgent)) return { kind: "desktop", os: "windows" };
  if (/Macintosh|Mac OS X/u.test(userAgent)) return { kind: "desktop", os: "macos" };
  // A Chromebook can run Linux machines inside it, so it may be one.
  if (/CrOS/u.test(userAgent)) return null;
  if (/Linux|X11/u.test(userAgent)) return { kind: "desktop", os: "linux" };
  return null;
}

/** A connected machine's reported system, in the same terms. */
export function machineOs(os: string | undefined): DesktopOs | null {
  if (os === "macos" || os === "darwin") return "macos";
  if (os === "windows" || os === "win32") return "windows";
  if (os === "linux") return "linux";
  return null;
}

export function currentBrowserDevice(): BrowserDevice {
  if (typeof navigator === "undefined") return null;
  return browserDevice(navigator.userAgent, navigator.maxTouchPoints);
}
