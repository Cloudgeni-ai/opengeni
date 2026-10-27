// Dictation on Windows: shortcuts are key combinations (Electron's global
// shortcuts), and the text is pasted as Control-V by PowerShell, which every
// Windows has, so the app ships no native module. PowerShell takes a moment
// to start, so it starts when the speech goes to be transcribed.

import { spawn } from "node:child_process";

import type { DesktopDictationPermissionId } from "../../contract";
import { helperPaste } from "./mac";
import { DictationPasteError, type DictationPaste, type DictationPlatform } from "./platform";

const PASTE_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$line = [Console]::In.ReadLine()",
  "if ($null -eq $line) { exit 3 }",
  "[System.Windows.Forms.SendKeys]::SendWait('^v')",
  "[Console]::Out.WriteLine('{\"ok\":true}')",
].join("; ");

export class WindowsDictation implements DictationPlatform {
  readonly platform = "windows" as const;
  readonly modifierPairs = [];
  readonly modifierChords = false;

  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  async permissions(): Promise<{ id: DesktopDictationPermissionId; granted: boolean }[]> {
    return [];
  }

  async requestPermission(): Promise<void> {}

  async pasteSupport(): Promise<{ available: boolean; reason: string | null }> {
    return { available: true, reason: null };
  }

  preparePaste(): DictationPaste {
    const child = this.spawnProcess(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PASTE_SCRIPT],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    return helperPaste(child, (stdout) => {
      if (!stdout.includes('"ok":true')) throw new DictationPasteError("Couldn't paste the text.");
    });
  }
}
