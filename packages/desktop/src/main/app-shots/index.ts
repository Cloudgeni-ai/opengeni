// App-shots: the person presses a shortcut anywhere, and the window they are
// looking at arrives in their Opengeni composer (picture, app, title and the
// window's text), ready to add a sentence and send. Nothing is sent by
// itself. This controller owns the setting, the shortcut and the hand-off to
// the web app; ./platform.ts is where each operating system plugs in.

import type {
  DesktopAppShotPermissionId,
  DesktopAppShotResult,
  DesktopAppShotSettings,
  DesktopAppShotStatus,
} from "../../contract";
import { AppShotError, type AppShotPlatform } from "./platform";
import { mergeAppShotSettings } from "./settings";

export { AppShotSettingsStore, defaultAppShotSettings } from "./settings";
export { MacAppShots } from "./mac";
export type { AppShotPlatform, CapturedWindow } from "./platform";

export interface AppShotsDeps {
  /** Null where app-shots aren't available yet. */
  platform: AppShotPlatform | null;
  store: { read(): DesktopAppShotSettings; write(settings: DesktopAppShotSettings): void };
  globalShortcut: {
    register(accelerator: string, callback: () => void): boolean;
    unregister(accelerator: string): void;
  };
  /** Bring the app's window to the front. */
  reveal(): void;
  /** Hand the capture (or why there is none) to the web app in the window. */
  deliver(result: DesktopAppShotResult): void;
  /** Settings, permissions or the shortcut's state changed. */
  onChange(): void;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

export class AppShots {
  private settings: DesktopAppShotSettings;
  private shortcutError: string | null = null;
  private stopWatching: (() => void) | null = null;
  private accelerator: string | null = null;
  private capturing = false;
  /** Each settings change; a slower earlier setup that finishes late is undone. */
  private generation = 0;

  constructor(private readonly deps: AppShotsDeps) {
    this.settings = deps.store.read();
  }

  start(): void {
    void this.apply();
  }

  stop(): void {
    this.generation += 1;
    this.teardown();
  }

  async status(): Promise<DesktopAppShotStatus> {
    const platform = this.deps.platform;
    return {
      settings: this.settings,
      supported: platform !== null,
      modifierPairs: platform?.watchModifierPair ? [...platform.modifierPairs] : [],
      permissions: platform ? await platform.permissions().catch(() => []) : [],
      shortcutError: this.shortcutError,
    };
  }

  async update(change: unknown): Promise<DesktopAppShotStatus> {
    const next = mergeAppShotSettings(this.settings, change);
    if (JSON.stringify(next) !== JSON.stringify(this.settings)) {
      this.settings = next;
      this.deps.store.write(next);
      await this.apply();
      this.deps.onChange();
    }
    return await this.status();
  }

  async requestPermission(id: DesktopAppShotPermissionId): Promise<void> {
    await this.deps.platform?.requestPermission(id);
    this.deps.onChange();
  }

  /** What the shortcut does: capture the window in front and hand it over. */
  async trigger(): Promise<void> {
    const platform = this.deps.platform;
    if (!platform || this.capturing) return;
    this.capturing = true;
    const capturedAt = (this.deps.now?.() ?? new Date()).toISOString();
    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      this.deps.reveal();
    };
    try {
      // The app comes forward once the picture is taken, while the window's
      // text is still being read, so the shortcut feels immediate.
      const window = await platform.capture({ onPicture: reveal });
      reveal();
      this.deps.deliver({
        ok: true,
        shot: {
          image: window.image,
          mimeType: "image/png",
          app: window.app,
          ...(window.bundleId ? { bundleId: window.bundleId } : {}),
          title: window.title,
          capturedAt,
          platform: platform.platform,
          ...(window.text ? { text: window.text } : {}),
          ...(window.textTruncated ? { textTruncated: true } : {}),
          ...(window.window ? { window: window.window } : {}),
          ...(window.browser ? { browser: window.browser } : {}),
        },
      });
    } catch (caught) {
      this.deps.log?.("app-shot capture failed", caught);
      reveal();
      const error =
        caught instanceof AppShotError
          ? caught
          : new AppShotError("failed", "Couldn't capture the window.");
      this.deps.deliver({
        ok: false,
        code: error.code,
        message: error.message,
        ...(error.permission ? { permission: error.permission } : {}),
      });
    } finally {
      this.capturing = false;
    }
  }

  private teardown(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    if (this.accelerator) this.deps.globalShortcut.unregister(this.accelerator);
    this.accelerator = null;
  }

  private async apply(): Promise<void> {
    const generation = ++this.generation;
    this.teardown();
    this.shortcutError = null;
    const platform = this.deps.platform;
    if (!this.settings.enabled || !platform) return;
    const shortcut = this.settings.shortcut;
    const trigger = () => void this.trigger();
    if (shortcut.kind === "accelerator") {
      let registered = false;
      try {
        registered = this.deps.globalShortcut.register(shortcut.accelerator, trigger);
      } catch (caught) {
        this.deps.log?.("app-shot shortcut rejected", caught);
      }
      if (registered) this.accelerator = shortcut.accelerator;
      else this.shortcutError = "That key combination is taken or not allowed. Choose another.";
      return;
    }
    if (!platform.watchModifierPair || !platform.modifierPairs.includes(shortcut.modifier)) {
      this.shortcutError = "This computer can't use that key pair. Choose a key combination.";
      return;
    }
    try {
      const stop = await platform.watchModifierPair(shortcut.modifier, trigger, (caught) => {
        if (generation !== this.generation) return;
        this.deps.log?.("app-shot shortcut stopped", caught);
        this.stopWatching = null;
        this.shortcutError = "The shortcut stopped working. Turn app-shots off and on again.";
        this.deps.onChange();
      });
      if (generation !== this.generation) {
        stop();
        return;
      }
      this.stopWatching = stop;
    } catch (caught) {
      if (generation !== this.generation) return;
      this.deps.log?.("app-shot shortcut failed", caught);
      this.shortcutError = "The shortcut couldn't be set up. Turn app-shots off and on again.";
    }
  }
}
