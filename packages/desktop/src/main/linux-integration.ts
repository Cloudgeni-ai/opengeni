// Desktop integration for the Linux AppImage. Installed packages (deb, rpm)
// ship a .desktop file that registers the app's URL scheme and icon; an
// AppImage is one file anywhere on disk, so it writes its own entry under the
// person's data directory. Without it, the browser can't hand sign-in back to
// the app, and the dock shows a generic icon.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppImageEntryOptions {
  productName: string;
  scheme: string;
  /** The AppImage file itself (`$APPIMAGE`). */
  appImagePath: string;
  /** The icon name the entry refers to, installed next to it. */
  iconName: string;
  /** The window class, so the dock groups the window under this entry. */
  windowClass: string;
}

/** Quote a path for a .desktop Exec line (Desktop Entry Specification, "The Exec key"). */
export function desktopExecQuote(path: string): string {
  return `"${path.replace(/[\\"`$]/gu, (character) => `\\${character}`)}"`;
}

/** The .desktop file for an AppImage, launching it with the link it was opened with. */
export function appImageDesktopEntry(options: AppImageEntryOptions): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${options.productName}`,
    `Exec=${desktopExecQuote(options.appImagePath)} %U`,
    `TryExec=${options.appImagePath}`,
    `Icon=${options.iconName}`,
    "Terminal=false",
    "Categories=Development;",
    `MimeType=x-scheme-handler/${options.scheme};`,
    `StartupWMClass=${options.windowClass}`,
    "",
  ].join("\n");
}

/** The file name of the AppImage's entry; distinct from the packages' own entry. */
export function appImageEntryName(scheme: string): string {
  return `${scheme}-appimage`;
}

function writeIfChanged(path: string, content: string | Buffer): boolean {
  try {
    const current = readFileSync(path);
    if (current.equals(Buffer.isBuffer(content) ? content : Buffer.from(content))) return false;
  } catch {
    // Not there yet.
  }
  writeFileSync(path, content);
  return true;
}

function run(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The desktop's helper tools are optional.
  }
}

/**
 * Register the running AppImage with the desktop: its entry (URL scheme and
 * icon) under `$XDG_DATA_HOME/applications`, and the scheme's default handler.
 * Cheap when nothing changed; safe to call on every launch.
 */
export function installAppImageIntegration(options: {
  productName: string;
  scheme: string;
  appImagePath: string;
  iconPath: string;
  windowClass: string;
}): void {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const name = appImageEntryName(options.scheme);
  const applications = join(dataHome, "applications");
  const icons = join(dataHome, "icons", "hicolor", "512x512", "apps");
  mkdirSync(applications, { recursive: true });
  mkdirSync(icons, { recursive: true });
  writeIfChanged(join(icons, `${name}.png`), readFileSync(options.iconPath));
  const changed = writeIfChanged(
    join(applications, `${name}.desktop`),
    appImageDesktopEntry({ ...options, iconName: name }),
  );
  if (!changed) return;
  run("update-desktop-database", [applications]);
  run("xdg-mime", ["default", `${name}.desktop`, `x-scheme-handler/${options.scheme}`]);
}
