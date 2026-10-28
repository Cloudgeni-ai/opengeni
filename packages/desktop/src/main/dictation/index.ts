// Dictation from anywhere: the person presses a shortcut in any app, speaks,
// presses it again (or lets go of it), and the text is typed where they were
// typing. The app owns the shortcuts, the small window that shows how a
// dictation is going, and where the text goes. A signed-in page records and
// transcribes with the person's account (`DesktopDictationHost` in
// `@opengeni/react/desktop-dictation`), so a dictation is an ordinary
// recording: kept until its text arrives, private to the person, and deleted
// once its text is taken. ./platform.ts is where each operating system plugs in.

import { randomUUID } from "node:crypto";

import {
  DESKTOP_IPC,
  type DesktopDictationAction,
  type DesktopDictationAudio,
  type DesktopDictationHistoryEntry,
  type DesktopDictationPermissionId,
  type DesktopDictationProfile,
  type DesktopDictationReport,
  type DesktopDictationRequest,
  type DesktopDictationSettings,
  type DesktopDictationShortcutProblem,
  type DesktopDictationStatus,
} from "../../contract";
import type { DictationHudAction, DictationHudState } from "./hud-state";
import {
  DictationPasteError,
  type DictationModifierWatch,
  type DictationPaste,
  type DictationPlatform,
} from "./platform";
import { mergeDictationSettings } from "./settings";
import { ENGLISH_DICTATION_WORDS, fillDictationWords, type DictationWords } from "./words";

export {
  DICTATION_AUDIO_MAX_BYTES,
  DICTATION_HISTORY_MAX,
  DICTATION_PROFILES_MAX,
  DICTATION_VOCABULARY_MAX,
  DictationSettingsStore,
  defaultDictationSettings,
  mergeDictationSettings,
  parseDictationAudio,
  parseDictationShortcut,
} from "./settings";
export { MacDictation } from "./mac";
export { WindowsDictation } from "./windows";
export { LinuxDictation, linuxPasteTool } from "./linux";
export { DictationPasteError } from "./platform";
export type {
  DictationModifierEvents,
  DictationModifierWatch,
  DictationPaste,
  DictationPlatform,
} from "./platform";
export type { DictationHudAction, DictationHudState } from "./hud-state";

/** How long a hold must last before it is a dictation rather than a tap. */
export const DICTATION_HOLD_SETTLE_MS = 150;
/** How long the page may take to start recording before the dictation fails. */
export const DICTATION_START_TIMEOUT_MS = 15_000;
/** The person's clipboard comes back this long after the text is pasted. */
export const DICTATION_CLIPBOARD_RESTORE_MS = 1_000;
const NOTICE_MS = 2_500;
const ERROR_NOTICE_MS = 8_000;
const ESCAPE = "Escape";

/** A page that records for the shortcuts. */
export interface DictationTarget {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  /** A hidden page keeps full speed while it records (Electron's WebContents). */
  getBackgroundThrottling?(): boolean;
  setBackgroundThrottling?(allowed: boolean): void;
}

/** What was on the clipboard before the text replaced it, to put back. */
export interface DictationClipboard<Snapshot = unknown> {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  /** What it holds now, to put back; null when that can't be read. */
  snapshot(): Promise<Snapshot | null>;
  restore(snapshot: Snapshot): Promise<void>;
}

/** The small window that shows how a dictation is going. */
export interface DictationHudView {
  show(state: DictationHudState): void;
  onAction(listener: (action: DictationHudAction) => void): void;
}

export interface DictationDeps {
  /** Null where dictation isn't available. */
  platform: DictationPlatform | null;
  store: {
    read(): DesktopDictationSettings;
    write(settings: DesktopDictationSettings): void;
    history(): DesktopDictationHistoryEntry[];
    /** Keep a finished dictation, with its speech when the page sent it. */
    remember(entry: DesktopDictationHistoryEntry, audio?: DesktopDictationAudio | null): void;
    /** A kept dictation's new text, after it was transcribed again. */
    replaceText(id: string, text: string): void;
    /** A kept dictation's speech; null when there is none. */
    audio(id: string): DesktopDictationAudio | null;
    clearHistory(): void;
  };
  globalShortcut: {
    register(accelerator: string, callback: () => void): boolean;
    unregister(accelerator: string): void;
  };
  clipboard: DictationClipboard;
  hud: DictationHudView;
  /** The app's name, for "Open Acme and sign in to dictate". */
  productName: string;
  /** What dictation says outside the page, in the app's language. English by default. */
  words?: () => DictationWords;
  /** Bring the app's window to the front. */
  reveal(): void;
  /**
   * No signed-in page is open to record: open one without showing it, when
   * the app can. Dictation starts once it listens.
   */
  wake?: () => void;
  /** Of the pages listening, the one to record with; the newest by default. */
  chooseTarget?: (targets: readonly DictationTarget[]) => DictationTarget | undefined;
  now?: () => number;
  createId?: () => string;
  log?: (message: string, error?: unknown) => void;
}

type Phase = "starting" | "recording" | "transcribing" | "failed";

interface Active {
  id: string;
  profile: DesktopDictationProfile;
  target: DictationTarget;
  phase: Phase;
  startedAt: number | null;
  level: number | null;
  /** Stop as soon as recording starts: the shortcut was let go while it started. */
  stopRequested: boolean;
  /** Held down rather than toggled. */
  hold: boolean;
  paste: DictationPaste | null;
  watchdog: ReturnType<typeof setTimeout> | null;
  /** The page's own throttling setting, put back when the dictation ends. */
  throttled: boolean | null;
  /**
   * Kept speech transcribed again rather than recorded: its text replaces the
   * kept dictation's, and is typed only when the retry shortcut asked for it.
   */
  again: { entryId: string; type: boolean } | null;
}

export class Dictation {
  private shortcutErrors: { profileId: string; problem: DesktopDictationShortcutProblem }[] = [];
  private actionShortcutErrors: {
    action: DesktopDictationAction;
    problem: DesktopDictationShortcutProblem;
  }[] = [];
  private accelerators: string[] = [];
  private stopWatching: (() => void) | null = null;
  /** Each settings change; a slower earlier setup that finishes late is undone. */
  private generation = 0;
  private readonly targets: DictationTarget[] = [];
  private active: Active | null = null;
  private escape = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** A shortcut pressed while no page could record: it starts once one listens. */
  private waiting: { profileId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: DictationDeps) {
    deps.hud.onAction((action) => this.onHudAction(action));
  }

  /** Read each time: until the person saves, the defaults follow the app (its language). */
  private get settings(): DesktopDictationSettings {
    return this.deps.store.read();
  }

  start(): void {
    void this.apply();
  }

  stop(): void {
    this.generation += 1;
    this.teardown();
    this.clearWaiting();
    if (this.active) this.finish();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Something the status reads changed outside the controller (a permission). */
  refresh(): void {
    this.changed();
  }

  async status(): Promise<DesktopDictationStatus> {
    const platform = this.deps.platform;
    return {
      settings: this.settings,
      supported: platform !== null,
      platform: platform?.platform ?? currentPlatform(),
      modifierPairs: platform?.watchModifiers ? [...platform.modifierPairs] : [],
      modifierChords: Boolean(platform?.watchModifiers && platform.modifierChords),
      permissions: platform ? await platform.permissions().catch(() => []) : [],
      shortcutErrors: this.settings.enabled ? [...this.shortcutErrors] : [],
      actionShortcutErrors: this.settings.enabled ? [...this.actionShortcutErrors] : [],
      paste: platform
        ? await platform.pasteSupport().catch(() => ({ available: false, blocker: null }))
        : { available: false, blocker: "unsupported" as const },
      ready: this.liveTargets().length > 0,
    };
  }

  async update(change: unknown): Promise<DesktopDictationStatus> {
    const current = this.settings;
    const next = mergeDictationSettings(current, change);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      this.deps.store.write(next);
      if (!next.enabled && this.active) this.cancel();
      await this.apply();
      this.changed();
    }
    return await this.status();
  }

  async requestPermission(id: DesktopDictationPermissionId): Promise<void> {
    await this.deps.platform?.requestPermission(id);
    this.changed();
  }

  /** Dictation is on: the app should keep running, and open at login. */
  get enabled(): boolean {
    return this.settings.enabled;
  }

  history(): DesktopDictationHistoryEntry[] {
    return this.deps.store.history();
  }

  historyAudio(id: string): DesktopDictationAudio | null {
    return this.deps.store.audio(id);
  }

  /** Transcribe a kept dictation's speech again; its new text replaces the old. */
  transcribeAgain(id: string): void {
    this.again(id, false);
  }

  clearHistory(): void {
    this.deps.store.clearHistory();
    this.changed();
  }

  /** A page starts or stops recording for the shortcuts. */
  listen(target: DictationTarget, listening: boolean): void {
    const index = this.targets.indexOf(target);
    if (index >= 0) this.targets.splice(index, 1);
    if (listening) this.targets.push(target);
    else if (this.active?.target === target && this.active.phase !== "failed") {
      this.fail(this.words().pageClosed, false);
    }
    if (listening && this.waiting && !this.active) {
      const { profileId } = this.waiting;
      this.clearWaiting();
      this.begin(profileId, false);
    }
    this.changed();
  }

  /** How the page's dictation is going. */
  report(target: DictationTarget, report: DesktopDictationReport): void {
    const active = this.active;
    if (!active || active.target !== target || report.dictationId !== active.id) return;
    switch (report.phase) {
      case "recording":
        this.clearWatchdog();
        if (active.phase === "starting" || active.phase === "recording") {
          active.phase = "recording";
          active.startedAt = report.startedAt;
          active.level = report.level;
          if (active.stopRequested) this.finishSpeaking();
          else this.showRecording();
        }
        return;
      case "transcribing":
        this.clearWatchdog();
        active.phase = "transcribing";
        this.preparePaste();
        this.show({ kind: "transcribing", label: this.label(active.profile) });
        return;
      case "done":
        void this.deliver(active, report.text, report.audio ?? null);
        return;
      case "failed":
        this.fail(report.message, report.retryable);
        return;
      case "cancelled":
        this.finish();
        this.show({ kind: "hidden" });
        return;
    }
  }

  /** What a toggle shortcut does: start, or stop the dictation under way. */
  press(profileId: string): void {
    if (this.waiting) {
      // Pressed again before a page could record: never mind.
      this.clearWaiting();
      this.show({ kind: "hidden" });
      return;
    }
    const active = this.active;
    if (active) {
      if (active.phase === "starting" || active.phase === "recording") this.finishSpeaking();
      else if (active.phase === "failed") {
        this.dismiss();
        this.begin(profileId, false);
      }
      return;
    }
    this.begin(profileId, false);
  }

  private onModifierDown(profileId: string): void {
    if (this.settings.mode !== "hold") return;
    if (this.active && this.active.phase !== "failed") return;
    this.clearHoldTimer();
    // A tap is not a dictation: only a hold that lasts starts one.
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.active?.phase === "failed") this.dismiss();
      this.begin(profileId, true);
    }, DICTATION_HOLD_SETTLE_MS);
  }

  private onModifierUp(profileId: string, clean: boolean): void {
    if (this.settings.mode !== "hold") {
      if (clean) this.press(profileId);
      return;
    }
    if (this.holdTimer) {
      this.clearHoldTimer();
      return;
    }
    const active = this.active;
    if (!active?.hold || active.profile.id !== profileId) return;
    if (active.phase !== "starting" && active.phase !== "recording") return;
    // Another key joined: it was a key combination, not speech.
    if (clean) this.finishSpeaking();
    else this.cancel();
  }

  private begin(profileId: string, hold: boolean): void {
    if (!this.settings.enabled || this.active) return;
    const profile = this.settings.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return;
    const target = this.target();
    if (!target) {
      const wake = this.deps.wake;
      if (!wake || hold) {
        this.notice("info", this.fill(this.words().signIn), ["open"]);
        return;
      }
      // Open a page in the background, and start once it is ready to record.
      this.clearWaiting();
      this.waiting = {
        profileId,
        timer: setTimeout(() => {
          this.waiting = null;
          if (!this.active) {
            this.notice("info", this.fill(this.words().signIn), ["open"]);
          }
        }, DICTATION_START_TIMEOUT_MS),
      };
      this.show({ kind: "starting", label: this.label(profile) });
      try {
        wake();
      } catch (caught) {
        this.deps.log?.("dictation couldn't open a page", caught);
      }
      return;
    }
    const id = (this.deps.createId ?? randomUUID)();
    let throttled: boolean | null = null;
    try {
      throttled = target.getBackgroundThrottling?.() ?? null;
      if (throttled) target.setBackgroundThrottling?.(false);
    } catch {
      throttled = null;
    }
    this.active = {
      id,
      profile,
      target,
      phase: "starting",
      startedAt: null,
      level: null,
      stopRequested: false,
      hold,
      paste: null,
      throttled,
      again: null,
      watchdog: setTimeout(() => {
        if (this.active?.id === id && this.active.phase === "starting") {
          this.send({ kind: "cancel", dictationId: id });
          this.fail(this.fill(this.words().noStart), false);
        }
      }, DICTATION_START_TIMEOUT_MS),
    };
    this.registerEscape();
    this.show({ kind: "starting", label: this.label(profile) });
    this.send({
      kind: "start",
      dictationId: id,
      profileId: profile.id,
      language: profile.language,
      vocabulary: this.settings.vocabulary ?? [],
    });
  }

  /**
   * Transcribe a kept dictation's speech again with its shortcut's language
   * now and the current vocabulary. `type` puts the text where the person is
   * typing, as a dictation does (the retry shortcut).
   */
  private again(entryId: string, type: boolean): void {
    if (this.active || this.waiting) return;
    const entry = this.deps.store.history().find((item) => item.id === entryId);
    const audio = entry ? this.deps.store.audio(entryId) : null;
    if (!entry || !audio) {
      this.notice("info", this.words().nothingToRetry ?? ENGLISH_DICTATION_WORDS.nothingToRetry!);
      return;
    }
    const target = this.target();
    if (!target) {
      this.notice("info", this.fill(this.words().signIn), ["open"]);
      return;
    }
    // The shortcut it was dictated with, when it is still there, for its language now.
    const shortcut =
      this.settings.profiles.find((profile) => profile.name === entry.profileName) ??
      this.settings.profiles.find((profile) => profile.language === entry.language);
    const profile: DesktopDictationProfile = shortcut ?? {
      ...this.settings.profiles[0]!,
      name: entry.profileName,
      language: entry.language,
    };
    const id = (this.deps.createId ?? randomUUID)();
    this.active = {
      id,
      profile,
      target,
      phase: "transcribing",
      startedAt: null,
      level: null,
      stopRequested: false,
      hold: false,
      paste: null,
      throttled: null,
      again: { entryId, type },
      // A page that can't transcribe kept speech never answers.
      watchdog: setTimeout(() => {
        if (this.active?.id === id && this.active.watchdog) {
          this.send({ kind: "cancel", dictationId: id });
          this.fail(this.fill(this.words().noStart), false);
        }
      }, DICTATION_START_TIMEOUT_MS),
    };
    this.registerEscape();
    this.preparePaste();
    this.show({ kind: "transcribing", label: this.label(profile) });
    this.send({
      kind: "transcribe",
      dictationId: id,
      profileId: profile.id,
      language: profile.language,
      vocabulary: this.settings.vocabulary ?? [],
      audio,
    });
  }

  /** The retry shortcut: a failed dictation again, or else the newest kept one. */
  private retryLast(): void {
    if (!this.settings.enabled) return;
    const active = this.active;
    if (active) {
      if (active.phase === "failed") this.retry();
      return;
    }
    const newest = this.deps.store.history().find((entry) => entry.audio);
    if (!newest) {
      this.notice("info", this.words().nothingToRetry ?? ENGLISH_DICTATION_WORDS.nothingToRetry!);
      return;
    }
    this.again(newest.id, true);
  }

  /** Escape and the cancel shortcut: throw the dictation away, or let a failed one go. */
  private cancelFromKeys(): void {
    if (this.waiting) {
      this.clearWaiting();
      this.show({ kind: "hidden" });
      return;
    }
    if (this.active?.phase === "failed") this.dismiss();
    else this.cancel();
  }

  /** Stop listening and transcribe. */
  private finishSpeaking(): void {
    const active = this.active;
    if (!active) return;
    if (active.phase === "starting") {
      active.stopRequested = true;
      return;
    }
    if (active.phase !== "recording") return;
    active.phase = "transcribing";
    this.preparePaste();
    this.show({ kind: "transcribing", label: this.label(active.profile) });
    this.send({ kind: "stop", dictationId: active.id });
  }

  /** Throw the dictation away. */
  private cancel(): void {
    const active = this.active;
    if (!active) return;
    this.send({ kind: "cancel", dictationId: active.id });
    this.finish();
    this.show({ kind: "hidden" });
  }

  /** Let a failed dictation go; it stays saved, for the composer to offer. */
  private dismiss(): void {
    const active = this.active;
    if (!active) return;
    this.send({ kind: "dismiss", dictationId: active.id });
    this.finish();
    this.show({ kind: "hidden" });
  }

  private retry(): void {
    const active = this.active;
    if (active?.phase !== "failed") return;
    active.phase = "transcribing";
    this.registerEscape();
    this.preparePaste();
    this.show({ kind: "transcribing", label: this.label(active.profile) });
    this.send({ kind: "retry", dictationId: active.id });
  }

  private fail(message: string, retryable: boolean): void {
    const active = this.active;
    if (!active) return;
    this.clearWatchdog();
    active.phase = "failed";
    active.paste?.cancel();
    active.paste = null;
    this.show({
      kind: "notice",
      tone: "error",
      message,
      actions: retryable ? ["retry", "dismiss"] : ["dismiss"],
    });
  }

  private async deliver(
    active: Active,
    raw: string,
    audio: DesktopDictationAudio | null,
  ): Promise<void> {
    const text = raw.trim();
    const paste = active.paste;
    active.paste = null;
    this.finish();
    if (!text) {
      paste?.cancel();
      this.notice("info", this.words().noSpeech);
      return;
    }
    if (active.again) {
      this.deps.store.replaceText(active.again.entryId, text);
      this.changed();
      if (!active.again.type) {
        paste?.cancel();
        this.show({ kind: "hidden" });
        return;
      }
    } else {
      this.deps.store.remember(
        {
          id: active.id,
          text,
          at: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
          profileName: active.profile.name,
          language: active.profile.language,
        },
        audio,
      );
      this.changed();
    }
    const output = this.settings.output;
    const clipboard = this.deps.clipboard;
    if (output === "copy" || !paste) {
      paste?.cancel();
      await clipboard
        .writeText(text)
        .catch((caught: unknown) => this.deps.log?.("dictation copy failed", caught));
      if (output === "copy") {
        this.notice("success", this.words().copiedOnly);
        return;
      }
      const support = await this.deps.platform?.pasteSupport().catch(() => null);
      const blocker = support?.blocker ?? "unsupported";
      this.notice(
        "error",
        this.copiedBecause(this.words().pasteBlocked[blocker]),
        blocker === "accessibility" ? ["allow"] : [],
      );
      return;
    }
    const previous = output === "paste" ? await clipboard.snapshot().catch(() => null) : null;
    try {
      await clipboard.writeText(text);
      await paste.paste();
    } catch (caught) {
      this.deps.log?.("dictation paste failed", caught);
      const blocker = caught instanceof DictationPasteError ? caught.blocker : null;
      const words = this.words();
      this.notice(
        "error",
        this.copiedBecause(blocker ? words.pasteBlocked[blocker] : words.pasteFailed),
        blocker === "accessibility" ? ["allow"] : [],
      );
      return;
    }
    this.show({ kind: "hidden" });
    if (previous !== null) {
      // Put the person's clipboard back once the app has read the text, unless
      // they copied something else meanwhile.
      setTimeout(() => {
        void clipboard
          .readText()
          .then((current) => (current === text ? clipboard.restore(previous) : undefined))
          .catch((caught: unknown) =>
            this.deps.log?.("dictation clipboard restore failed", caught),
          );
      }, DICTATION_CLIPBOARD_RESTORE_MS);
    }
  }

  private onHudAction(action: DictationHudAction): void {
    switch (action) {
      case "stop":
        this.finishSpeaking();
        return;
      case "cancel":
        this.cancelFromKeys();
        return;
      case "retry":
        this.retry();
        return;
      case "dismiss":
        if (this.active?.phase === "failed") this.dismiss();
        else this.show({ kind: "hidden" });
        return;
      case "allow":
        this.show({ kind: "hidden" });
        void this.requestPermission("accessibility").catch(() => undefined);
        return;
      case "open":
        this.show({ kind: "hidden" });
        this.deps.reveal();
        return;
    }
  }

  /** The dictation is over: stop watching it. */
  private finish(): void {
    const active = this.active;
    if (!active) return;
    if (active.watchdog) clearTimeout(active.watchdog);
    active.paste?.cancel();
    if (active.throttled && !active.target.isDestroyed()) {
      try {
        active.target.setBackgroundThrottling?.(true);
      } catch {
        // The page is going away.
      }
    }
    this.active = null;
    this.unregisterEscape();
  }

  private clearWaiting(): void {
    if (this.waiting) clearTimeout(this.waiting.timer);
    this.waiting = null;
  }

  private preparePaste(): void {
    const active = this.active;
    const platform = this.deps.platform;
    if (!active || active.paste || !platform || this.settings.output === "copy") return;
    // Kept speech transcribed again from the settings only replaces the kept text.
    if (active.again && !active.again.type) return;
    try {
      active.paste = platform.preparePaste();
    } catch (caught) {
      this.deps.log?.("dictation paste helper failed", caught);
    }
  }

  private send(request: DesktopDictationRequest): void {
    const target = this.active?.target;
    if (target && !target.isDestroyed()) target.send(DESKTOP_IPC.dictationRequest, request);
  }

  private showRecording(): void {
    const active = this.active;
    if (active?.phase !== "recording") return;
    this.show({
      kind: "recording",
      startedAt: active.startedAt ?? Date.now(),
      level: active.level,
      label: this.label(active.profile),
      hold: active.hold,
    });
  }

  private show(state: DictationHudState): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.deps.hud.show(state);
  }

  private notice(
    tone: "info" | "success" | "error",
    message: string,
    actions: DictationHudAction[] = [],
  ): void {
    this.show({ kind: "notice", tone, message, actions: [...actions, "dismiss"] });
    this.noticeTimer = setTimeout(
      () => {
        this.noticeTimer = null;
        if (!this.active) this.deps.hud.show({ kind: "hidden" });
      },
      tone === "error" ? ERROR_NOTICE_MS : NOTICE_MS,
    );
  }

  /** The profile's name, when there is more than one to tell apart. */
  private label(profile: DesktopDictationProfile): string | null {
    return this.settings.profiles.length > 1 ? profile.name : null;
  }

  private words(): DictationWords {
    return this.deps.words?.() ?? ENGLISH_DICTATION_WORDS;
  }

  /** The app's name in a sentence. */
  private fill(template: string): string {
    return fillDictationWords(template, { product: this.deps.productName });
  }

  /** The text is on the clipboard because it couldn't be typed. */
  private copiedBecause(reason: string): string {
    return fillDictationWords(this.words().copied, { reason });
  }

  private target(): DictationTarget | undefined {
    const live = this.liveTargets();
    return this.deps.chooseTarget?.(live) ?? live.at(-1);
  }

  private liveTargets(): DictationTarget[] {
    for (let index = this.targets.length - 1; index >= 0; index -= 1) {
      if (this.targets[index]!.isDestroyed()) this.targets.splice(index, 1);
    }
    return [...this.targets];
  }

  private registerEscape(): void {
    if (this.escape) return;
    try {
      this.escape = this.deps.globalShortcut.register(ESCAPE, () => this.cancelFromKeys());
    } catch (caught) {
      this.deps.log?.("dictation escape shortcut rejected", caught);
    }
  }

  private unregisterEscape(): void {
    if (!this.escape) return;
    this.escape = false;
    this.deps.globalShortcut.unregister(ESCAPE);
  }

  private clearWatchdog(): void {
    if (this.active?.watchdog) clearTimeout(this.active.watchdog);
    if (this.active) this.active.watchdog = null;
  }

  private clearHoldTimer(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** A key combination for as long as dictation is on; false when it can't be had. */
  private register(accelerator: string, run: () => void): boolean {
    let registered = false;
    try {
      registered = this.deps.globalShortcut.register(accelerator, run);
    } catch (caught) {
      this.deps.log?.("dictation shortcut rejected", caught);
    }
    if (registered) this.accelerators.push(accelerator);
    return registered;
  }

  private teardown(): void {
    this.clearHoldTimer();
    this.stopWatching?.();
    this.stopWatching = null;
    for (const accelerator of this.accelerators) this.deps.globalShortcut.unregister(accelerator);
    this.accelerators = [];
  }

  private async apply(): Promise<void> {
    const generation = ++this.generation;
    this.teardown();
    this.shortcutErrors = [];
    this.actionShortcutErrors = [];
    const platform = this.deps.platform;
    if (!this.settings.enabled || !platform) return;
    const actions: [DesktopDictationAction, string | undefined, () => void][] = [
      ["retry", this.settings.retryShortcut?.accelerator, () => this.retryLast()],
      ["cancel", this.settings.cancelShortcut?.accelerator, () => this.cancelFromKeys()],
    ];
    for (const [action, accelerator, run] of actions) {
      if (!accelerator) continue;
      if (this.register(accelerator, run)) continue;
      this.actionShortcutErrors.push({ action, problem: "taken" });
    }
    const watches: DictationModifierWatch[] = [];
    for (const profile of this.settings.profiles) {
      const shortcut = profile.shortcut;
      if (shortcut.kind === "accelerator") {
        if (!this.register(shortcut.accelerator, () => this.press(profile.id))) {
          this.shortcutErrors.push({
            profileId: profile.id,
            problem: "taken",
          });
        }
        continue;
      }
      const supported =
        platform.watchModifiers &&
        (shortcut.kind === "modifierPair"
          ? platform.modifierPairs.includes(shortcut.modifier)
          : platform.modifierChords);
      if (!supported) {
        this.shortcutErrors.push({
          profileId: profile.id,
          problem: "unsupported",
        });
        continue;
      }
      watches.push({ id: profile.id, shortcut });
    }
    if (watches.length === 0 || !platform.watchModifiers) return;
    try {
      const stop = await platform.watchModifiers(
        watches,
        {
          onDown: (id) => this.onModifierDown(id),
          onUp: (id, clean) => this.onModifierUp(id, clean),
        },
        (caught) => {
          if (generation !== this.generation) return;
          this.deps.log?.("dictation shortcut stopped", caught);
          this.stopWatching = null;
          this.shortcutErrors.push(
            ...watches.map((watch) => ({
              profileId: watch.id,
              problem: "stopped" as const,
            })),
          );
          this.changed();
        },
      );
      if (generation !== this.generation) {
        stop();
        return;
      }
      this.stopWatching = stop;
    } catch (caught) {
      if (generation !== this.generation) return;
      this.deps.log?.("dictation shortcut failed", caught);
      this.shortcutErrors.push(
        ...watches.map((watch) => ({
          profileId: watch.id,
          problem: "failed" as const,
        })),
      );
    }
  }
}

function currentPlatform(): DesktopDictationStatus["platform"] {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}
