// What Opengeni may do on this computer, as the person set it on the Computer
// use settings page: screen control, the Chrome extension's bridge and the
// microphone. Each switch is enforced here in the app (the agent is started
// without the screen or the bridge; the window refuses the microphone), so
// turning one off stops the use rather than hiding it. Every switch starts
// on, so nothing that worked before stops working; the system permission
// behind each is asked for only when the person turns it on or first uses it.
// Saved switches that can't be read count as off, so a damaged file never
// turns on something the person turned off.
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  DesktopComputerCapabilities,
  DesktopComputerSettings,
  DesktopSystemPermission,
} from "../contract";

export const DEFAULT_COMPUTER_SETTINGS: DesktopComputerSettings = {
  screenControl: true,
  browserExtension: true,
  microphone: true,
};

/** What applies when the saved switches can't be read: nothing. */
export const UNREADABLE_COMPUTER_SETTINGS: DesktopComputerSettings = {
  screenControl: false,
  browserExtension: false,
  microphone: false,
};

type SettingKey = keyof DesktopComputerSettings;
type Problems = Partial<Record<SettingKey, string>>;

const SETTING_KEYS = Object.keys(DEFAULT_COMPUTER_SETTINGS) as SettingKey[];

export const UNREADABLE_PROBLEM = "Your saved choice couldn't be read, so this is off.";
export const UNSAVED_PROBLEM = "Couldn't save this. It applies until Opengeni quits.";
export const OUTDATED_AGENT_PROBLEM =
  "This computer's agent needs an update before this can be turned off.";

/** The system's settings page for the microphone, where it has one. */
export const MICROPHONE_SETTINGS_URL: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  win32: "ms-settings:privacy-microphone",
};

/** Applies a page's partial change; anything that isn't a boolean keeps the current value. */
export function mergeComputerSettings(
  current: DesktopComputerSettings,
  change: unknown,
): DesktopComputerSettings {
  if (!change || typeof change !== "object") return current;
  const candidate = change as Record<string, unknown>;
  const next = { ...current };
  for (const key of SETTING_KEYS) {
    if (typeof candidate[key] === "boolean") next[key] = candidate[key];
  }
  return next;
}

/**
 * Electron's `systemPreferences.getMediaAccessStatus` answer, as the page sees
 * it. Only macOS and Windows have a question to answer.
 */
export function microphonePermission(
  platform: NodeJS.Platform,
  status: string | null,
): DesktopSystemPermission {
  if (platform !== "darwin" && platform !== "win32") return "unknown";
  switch (status) {
    case "granted":
      return "granted";
    case "denied":
    case "restricted":
      return "denied";
    case "not-determined":
      return "notDetermined";
    default:
      return "unknown";
  }
}

/** The saved switches couldn't be read. A missing file is not this: it means the defaults. */
export class ComputerSettingsUnreadable extends Error {}

/** The switches in the app's data folder, `computer-capabilities.json`. */
export class ComputerSettingsStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "computer-capabilities.json");
  }

  /**
   * The saved switches, or the defaults when none were saved yet. Throws
   * `ComputerSettingsUnreadable` for a file that can't be read or parsed; a
   * damaged one is copied to `.corrupt` for a look later and stays in place,
   * so it keeps counting as unreadable until the next save replaces it.
   */
  read(): DesktopComputerSettings {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        return { ...DEFAULT_COMPUTER_SETTINGS };
      }
      throw new ComputerSettingsUnreadable("Couldn't read the Computer use settings", {
        cause: caught,
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (caught) {
      try {
        copyFileSync(this.path, `${this.path}.corrupt`);
      } catch {
        // No copy; the file itself is still there.
      }
      throw new ComputerSettingsUnreadable("The Computer use settings are damaged", {
        cause: caught,
      });
    }
    return mergeComputerSettings(DEFAULT_COMPUTER_SETTINGS, value);
  }

  write(settings: DesktopComputerSettings): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export interface ComputerCapabilitiesDeps {
  platform: NodeJS.Platform;
  store: Pick<ComputerSettingsStore, "read" | "write">;
  /** Electron's `systemPreferences.getMediaAccessStatus("microphone")`; null where it has none. */
  microphoneStatus(): string | null;
  /** Electron's `systemPreferences.askForMediaAccess("microphone")` (macOS only). */
  askForMicrophone(): Promise<boolean>;
  openSystemSettings(url: string): void;
  /** The agent's switches changed: start it again with them. Rejects when it can't. */
  agentSwitchesChanged(): Promise<void>;
  /** Which switches the app can't enforce now (a separately installed agent service). */
  unavailable(): SettingKey[] | Promise<SettingKey[]>;
  /** Why those switches can't be switched, when there is more to say than the default. */
  unavailableReason?(): string | null;
  /**
   * Whether the app's agent honours the screen-control switch; null when
   * unknown. An older agent that doesn't makes the switch unavailable.
   */
  screenControlSwitch?(): Promise<boolean | null>;
  /** Whether this computer was connected with screen control. */
  screenControlConnected(): boolean;
  onChange(): void;
  log?(message: string, caught: unknown): void;
}

export class ComputerCapabilities {
  private settings: DesktopComputerSettings;
  private readonly problems: Problems = {};

  constructor(private readonly deps: ComputerCapabilitiesDeps) {
    try {
      this.settings = deps.store.read();
    } catch (caught) {
      deps.log?.("Couldn't read what Opengeni may do on this computer", caught);
      this.settings = { ...UNREADABLE_COMPUTER_SETTINGS };
      for (const key of SETTING_KEYS) this.problems[key] = UNREADABLE_PROBLEM;
    }
  }

  /** The current switches, for the agent and the window. */
  get current(): DesktopComputerSettings {
    return this.settings;
  }

  async status(): Promise<DesktopComputerCapabilities> {
    let microphone: DesktopSystemPermission = "unknown";
    try {
      microphone = microphonePermission(this.deps.platform, this.deps.microphoneStatus());
    } catch (caught) {
      this.deps.log?.("Couldn't read the microphone permission", caught);
    }
    let unavailable: SettingKey[] = [];
    let screenControlConnected = false;
    try {
      unavailable = [...(await this.deps.unavailable())];
      screenControlConnected = this.deps.screenControlConnected();
    } catch (caught) {
      this.deps.log?.("Couldn't read which switches apply", caught);
    }
    const problems: Problems = { ...this.problems };
    let reason: string | null = null;
    try {
      reason = this.deps.unavailableReason?.() ?? null;
    } catch {
      reason = null;
    }
    if (reason) {
      for (const key of unavailable) problems[key] ??= reason;
    }
    if (!unavailable.includes("screenControl") && this.deps.screenControlSwitch) {
      const honoured = await this.deps.screenControlSwitch().catch(() => null);
      if (honoured === false) {
        unavailable.push("screenControl");
        problems.screenControl = OUTDATED_AGENT_PROBLEM;
      }
    }
    return {
      settings: { ...this.settings },
      microphone,
      unavailable,
      screenControlConnected,
      problems,
    };
  }

  /**
   * Applies a change at once. An agent switch restarts the agent; the answer
   * comes once that's done, with a problem on the row if it couldn't be. A
   * switch that doesn't apply now (another agent serves this computer, or
   * the agent is too old for it) is left as it is.
   */
  async update(change: unknown): Promise<DesktopComputerCapabilities> {
    const unavailable = new Set((await this.status()).unavailable);
    // Merged after the read, so a change applied meanwhile isn't undone.
    const next = { ...mergeComputerSettings(this.settings, change) };
    for (const key of unavailable) next[key] = this.settings[key];
    const changed = SETTING_KEYS.filter((key) => next[key] !== this.settings[key]);
    if (changed.length === 0) return this.status();
    this.settings = next;
    for (const key of changed) delete this.problems[key];
    try {
      this.deps.store.write(next);
    } catch (caught) {
      // Still applied for this run.
      this.deps.log?.("Couldn't save what Opengeni may do on this computer", caught);
      for (const key of changed) this.problems[key] = UNSAVED_PROBLEM;
    }
    this.deps.onChange();
    const agentKeys = changed.filter((key) => key !== "microphone");
    if (agentKeys.length > 0) {
      try {
        await this.deps.agentSwitchesChanged();
      } catch (caught) {
        this.deps.log?.("Couldn't restart this computer's agent", caught);
        const reason = caught instanceof Error && caught.message ? ` ${caught.message}` : "";
        for (const key of agentKeys) {
          this.problems[key] = `Couldn't restart the agent with this change.${reason}`;
        }
        this.deps.onChange();
      }
    }
    return this.status();
  }

  /**
   * Turning the microphone on when the system hasn't asked yet asks now;
   * when it was refused, its settings page opens. The switch turns on either way.
   */
  async requestMicrophone(): Promise<DesktopComputerCapabilities> {
    if (!this.settings.microphone) await this.update({ microphone: true });
    const permission = (await this.status()).microphone;
    if (permission === "notDetermined" && this.deps.platform === "darwin") {
      await this.deps.askForMicrophone().catch((caught: unknown) => {
        this.deps.log?.("Couldn't ask for the microphone", caught);
        return false;
      });
      this.deps.onChange();
    } else if (permission === "denied" || permission === "notDetermined") {
      const url = MICROPHONE_SETTINGS_URL[this.deps.platform];
      if (url) this.deps.openSystemSettings(url);
    }
    return this.status();
  }
}
