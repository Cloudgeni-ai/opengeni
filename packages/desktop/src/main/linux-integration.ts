// Desktop integration for the Linux AppImage. Installed packages (deb, rpm)
// ship a .desktop file that registers the app's URL scheme and icon; an
// AppImage is one file anywhere on disk, so it writes its own entry under the
// person's data directory. Without it, the browser can't hand sign-in back to
// the app, and the dock shows a generic icon.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * A path as a .desktop Exec argument (Desktop Entry Specification, "The Exec
 * key"), quoted only when it holds a reserved character: xdg-open's fallback
 * launcher, used outside the big desktops, can't run a quoted program.
 */
export function desktopExecQuote(path: string): string {
  if (!/[\s"'\\><~|&;$*?#()`]/u.test(path)) return path;
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

/** The XDG autostart entry that opens the app, without a window, at login. */
export function autostartDesktopEntry(productName: string, executable: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${productName}`,
    `Exec=${desktopExecQuote(executable)} --hidden`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/**
 * Open the app at login (`$XDG_CONFIG_HOME/autostart`), the way Linux desktops
 * start programs for the signed-in person. An AppImage starts from its own file.
 */
export function installLinuxAutostart(productName: string): void {
  try {
    const entry = autostartPath(productName);
    mkdirSync(dirname(entry), { recursive: true });
    const executable = process.env.APPIMAGE || process.execPath;
    writeIfChanged(entry, autostartDesktopEntry(productName, executable));
  } catch {
    // The app still works; it just doesn't open at login.
  }
}

/** Stop opening the app at login. */
export function removeLinuxAutostart(productName: string): void {
  rmSync(autostartPath(productName), { force: true });
}

function autostartPath(productName: string): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "autostart", `${productName.toLowerCase()}.desktop`);
}
