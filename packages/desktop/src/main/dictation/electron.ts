// Dictation wired to Electron: the clipboard, global shortcuts, the dictation
// window and this operating system's paste. One call for any Electron app.

import { clipboard, ClipboardItem, globalShortcut, shell } from "electron";

import type { DesktopDictationPermissionId } from "../../contract";
import { DictationHud } from "./hud";
import { Dictation, type DictationClipboard, type DictationDeps } from "./index";
import { LinuxDictation } from "./linux";
import { MacDictation } from "./mac";
import type { DictationPlatform } from "./platform";
import { DictationSettingsStore } from "./settings";
import { WindowsDictation } from "./windows";

/** Each clipboard entry as its formats, read in full so it can be written back. */
type ClipboardSnapshot = Record<string, Blob | Electron.ClipboardBookmark>[];

/** The system clipboard, with what it held put back after a paste. */
export function electronClipboard(): DictationClipboard<ClipboardSnapshot> {
  return {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
    snapshot: async () =>
      await Promise.all(
        (await clipboard.read()).map(async (item) =>
          Object.fromEntries(
            await Promise.all(
              item.types.map(async (type) => [type, await item.getType(type)] as const),
            ),
          ),
        ),
      ),
    restore: async (snapshot) => {
      const items = snapshot.filter((entry) => Object.keys(entry).length > 0);
      if (items.length === 0) clipboard.clear();
      else await clipboard.write(items.map((entry) => new ClipboardItem(entry)));
    },
  };
}

export interface CreateDesktopDictationOptions {
  /** The app's name, as people know it ("Open Vatra to dictate"). */
  productName: string;
  /** Where the settings and recent dictations are kept: `app.getPath("userData")`. */
  dataDir: string;
  /** Bring the app's window to the front. */
  reveal(): void;
  /** macOS: show a guide beside System Settings while the person allows a permission. */
  guide?: (id: DesktopDictationPermissionId | null, granted?: boolean) => void;
  /** Override the operating system's side, for tests or other platforms. */
  platform?: DictationPlatform | null;
  chooseTarget?: DictationDeps["chooseTarget"];
  /** Open a signed-in page without showing it, so dictation works from the menu bar. */
  wake?: DictationDeps["wake"];
  log?: (message: string, error?: unknown) => void;
}

/**
 * Dictation for an Electron app. Answer the page with `handleDictationIpc`,
 * call `start()` once the app is ready and `stop()` as it quits.
 */
export function createDesktopDictation(options: CreateDesktopDictationOptions): Dictation {
  const store = new DictationSettingsStore(options.dataDir, process.platform);
  let dictation: Dictation | null = null;
  const platform =
    options.platform !== undefined
      ? options.platform
      : process.platform === "darwin"
        ? new MacDictation({
            openSystemSettings: (url) => void shell.openExternal(url),
            guide: options.guide ?? (() => undefined),
            requested: () => store.requested(),
            markRequested: (id) => store.markRequested(id),
            onPermissionsChange: () => void dictation?.refresh(),
          })
        : process.platform === "win32"
          ? new WindowsDictation()
          : process.platform === "linux"
            ? new LinuxDictation()
            : null;
  dictation = new Dictation({
    platform,
    store,
    globalShortcut,
    clipboard: electronClipboard(),
    hud: new DictationHud(),
    productName: options.productName,
    reveal: options.reveal,
    ...(options.chooseTarget ? { chooseTarget: options.chooseTarget } : {}),
    ...(options.wake ? { wake: options.wake } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  return dictation;
}
