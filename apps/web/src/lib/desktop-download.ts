// Where the desktop app downloads from. The server redirects these
// version-less paths to the current desktop release (apps/api routes
// desktop-distribution.ts), so links never go stale.

import type { ConnectOs } from "@/lib/deployment";

export type DesktopDownload = { label: string; asset: string };

function originOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * The downloads to offer on an OS, most likely first. Linux browsers rarely
 * say which distribution they run on, so every package format is offered; the
 * install command picks the right one by itself.
 */
export function desktopDownloadsFor(
  os: ConnectOs,
  userAgent: string | undefined,
): DesktopDownload[] {
  if (os === "macos") return [{ label: "Download for Mac", asset: "Opengeni-mac.dmg" }];
  if (os === "windows") return [{ label: "Download for Windows", asset: "Opengeni-windows.exe" }];
  const arm = /aarch64|arm64|armv8/i.test(userAgent ?? "");
  return [
    { label: "Download .deb", asset: `Opengeni-linux-${arm ? "arm64" : "amd64"}.deb` },
    { label: "Download .rpm", asset: `Opengeni-linux-${arm ? "aarch64" : "x86_64"}.rpm` },
    { label: "Download AppImage", asset: `Opengeni-linux-${arm ? "arm64" : "x86_64"}.AppImage` },
  ];
}

export function desktopDownloadUrl(baseUrl: string, asset: string): string {
  return `${originOf(baseUrl)}/desktop/latest/${asset}`;
}

/** The current desktop release's page, with every platform's download. */
export function desktopReleasePageUrl(baseUrl: string): string {
  return `${originOf(baseUrl)}/desktop/latest`;
}

/** Installs or updates the app on macOS and Linux. */
export function desktopInstallCommand(baseUrl: string): string {
  return `curl -fsSL ${originOf(baseUrl)}/desktop/install.sh | sh`;
}
