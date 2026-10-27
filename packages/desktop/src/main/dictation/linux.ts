// Dictation on Linux: shortcuts are key combinations (Electron's global
// shortcuts, which need X11 or a desktop with the global shortcuts portal),
// and the text is pasted as Control-V by the tool the desktop allows: xdotool
// on X11, wtype or ydotool on Wayland. Without one, the text is only copied.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { DesktopDictationPermissionId } from "../../contract";
import { DictationPasteError, type DictationPaste, type DictationPlatform } from "./platform";

/** How the text is pasted on this desktop, or why it can't be. */
export type LinuxPasteTool =
  | { tool: "xdotool" | "wtype" | "ydotool"; path: string }
  | { tool: null; reason: string };

export function findOnPath(name: string, path = process.env.PATH ?? ""): string | null {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function linuxPasteTool(
  env: NodeJS.ProcessEnv = process.env,
  find: (name: string) => string | null = (name) => findOnPath(name, env.PATH),
): LinuxPasteTool {
  const wayland = env.XDG_SESSION_TYPE === "wayland" || Boolean(env.WAYLAND_DISPLAY);
  const order = wayland ? (["wtype", "ydotool"] as const) : (["xdotool"] as const);
  for (const tool of order) {
    const path = find(tool);
    if (path) return { tool, path };
  }
  return {
    tool: null,
    reason: wayland
      ? "Install wtype or ydotool so dictation can type into other apps. Until then, the text is copied."
      : "Install xdotool so dictation can type into other apps. Until then, the text is copied.",
  };
}

/** The paste tool's arguments: Control-V, with any held modifiers let go. */
export function linuxPasteArguments(tool: "xdotool" | "wtype" | "ydotool"): string[] {
  if (tool === "xdotool") return ["key", "--clearmodifiers", "ctrl+v"];
  if (tool === "wtype") return ["-M", "ctrl", "-k", "v", "-m", "ctrl"];
  // Linux input event codes: 29 is left Control, 47 is V.
  return ["key", "29:1", "47:1", "47:0", "29:0"];
}

export class LinuxDictation implements DictationPlatform {
  readonly platform = "linux" as const;
  readonly modifierPairs = [];
  readonly modifierChords = false;

  constructor(private readonly tool: () => LinuxPasteTool = () => linuxPasteTool()) {}

  async permissions(): Promise<{ id: DesktopDictationPermissionId; granted: boolean }[]> {
    return [];
  }

  async requestPermission(): Promise<void> {}

  async pasteSupport(): Promise<{ available: boolean; reason: string | null }> {
    const found = this.tool();
    return found.tool
      ? { available: true, reason: null }
      : { available: false, reason: found.reason };
  }

  preparePaste(): DictationPaste {
    return {
      paste: () =>
        new Promise<void>((resolve, reject) => {
          const found = this.tool();
          if (!found.tool) {
            reject(new DictationPasteError(found.reason));
            return;
          }
          execFile(found.path, linuxPasteArguments(found.tool), { timeout: 5_000 }, (error) => {
            if (error) reject(new DictationPasteError("Couldn't paste the text."));
            else resolve();
          });
        }),
      cancel: () => undefined,
    };
  }
}
