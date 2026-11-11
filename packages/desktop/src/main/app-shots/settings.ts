import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  DesktopAppShotModifier,
  DesktopAppShotPermissionId,
  DesktopAppShotSettings,
  DesktopAppShotShortcut,
} from "../../contract";

const MODIFIERS: readonly DesktopAppShotModifier[] = ["command", "option", "control", "shift"];

/** Off, with both Command keys on macOS and a key combination elsewhere. */
export function defaultAppShotSettings(platform: NodeJS.Platform): DesktopAppShotSettings {
  return {
    enabled: false,
    shortcut:
      platform === "darwin"
        ? { kind: "modifierPair", modifier: "command" }
        : { kind: "accelerator", accelerator: "CommandOrControl+Shift+2" },
  };
}

/**
 * A shortcut as stored or sent by the page, or null when it isn't one.
 * Accelerators are checked by Electron when registered; here only their shape.
 */
export function parseAppShotShortcut(value: unknown): DesktopAppShotShortcut | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind === "modifierPair" &&
    MODIFIERS.includes(candidate.modifier as DesktopAppShotModifier)
  ) {
    return { kind: "modifierPair", modifier: candidate.modifier as DesktopAppShotModifier };
  }
  if (
    candidate.kind === "accelerator" &&
    typeof candidate.accelerator === "string" &&
    /^[A-Za-z0-9+=\-[\];',./`\\ ]{1,100}$/u.test(candidate.accelerator) &&
    candidate.accelerator.includes("+")
  ) {
    return { kind: "accelerator", accelerator: candidate.accelerator.trim() };
  }
  return null;
}

/** Applies a page's partial change; anything malformed keeps the current value. */
export function mergeAppShotSettings(
  current: DesktopAppShotSettings,
  change: unknown,
): DesktopAppShotSettings {
  if (!change || typeof change !== "object") return current;
  const candidate = change as Record<string, unknown>;
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : current.enabled,
    shortcut:
      candidate.shortcut === undefined
        ? current.shortcut
        : (parseAppShotShortcut(candidate.shortcut) ?? current.shortcut),
  };
}

/**
 * The settings in the app's data folder, `app-shots.json`, with the
 * permissions already asked for (macOS shows its own prompt only once).
 */
export class AppShotSettingsStore {
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly platform: NodeJS.Platform,
  ) {
    this.path = join(dataDir, "app-shots.json");
  }

  read(): DesktopAppShotSettings {
    return mergeAppShotSettings(defaultAppShotSettings(this.platform), this.file());
  }

  write(settings: DesktopAppShotSettings): void {
    this.save({ ...this.file(), ...settings });
  }

  requested(): DesktopAppShotPermissionId[] {
    const value = this.file().requested;
    return Array.isArray(value)
      ? value.filter(
          (id): id is DesktopAppShotPermissionId =>
            id === "screenRecording" || id === "accessibility",
        )
      : [];
  }

  markRequested(id: DesktopAppShotPermissionId): void {
    const requested = this.requested();
    if (!requested.includes(id)) this.save({ ...this.file(), requested: [...requested, id] });
  }

  private file(): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private save(value: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
