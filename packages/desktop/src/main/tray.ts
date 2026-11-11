import {
  Menu,
  nativeImage,
  nativeTheme,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";

import type { DesktopDictationShortcut, ThisComputerPermissionId } from "../contract";
import type { DesktopAppConfig } from "./config";
import type { DictationMenu, DictationMenuAction } from "./dictation";
import {
  TRANSCRIBING_FRAME_MS,
  TRANSCRIBING_FRAMES,
  trayGlyphBitmap,
  type TrayGlyph,
  type TrayGlyphStyle,
} from "./tray-icons";

/** How long the menu bar shows a check after a dictation's text is delivered. */
export const DICTATION_DONE_MS = 800;

/** How often the menu's recording time moves on while a meeting records. */
export const MEETING_TICK_MS = 30_000;

/** A meeting being recorded, as the menu shows it. */
export interface TrayMeeting {
  /** Its name so far; null when it has none. */
  title: string | null;
  paused: boolean;
  /** Recorded time at `at` (a `Date.now()`), excluding pauses; it grows from there unless paused. */
  elapsedMilliseconds: number;
  at: number;
  /** Its page can open it; otherwise the menu only brings its account up. */
  canOpen: boolean;
  /** The account it records in, when the window shows another one. */
  otherAccount: string | null;
}

export type TrayMeetingAction = "open" | "stop";

export interface TrayActions {
  open(): void;
  pause(): void;
  resume(): void;
  allow(permission: ThisComputerPermissionId): void;
  quit(): void;
  /** The dictation items' actions. */
  dictation?(action: DictationMenuAction): void;
  /** The recording meeting's items' actions. */
  meeting?(action: TrayMeetingAction): void;
}

export interface TraySummary {
  installed: boolean;
  connected: boolean;
  running: boolean;
  /** On, but its agent is starting again. Absent means no. */
  reconnecting?: boolean;
  /** On, but the server stopped signing it in: it must be connected again. Absent means no. */
  needsReconnect?: boolean;
  /** Screen-control permissions still to allow, in order. */
  missingPermissions?: readonly ThisComputerPermissionId[];
}

const PERMISSION_LABELS: Record<ThisComputerPermissionId, string> = {
  screenRecording: "Allow Screen Recording…",
  accessibility: "Allow Accessibility…",
  inputMonitoring: "Allow Input Monitoring…",
  files: "Allow Desktop, Documents and Downloads…",
};

/**
 * The menu bar (macOS) or tray item: a meeting being recorded, how a
 * dictation is going and their controls, whether this computer is available
 * to agents, a pause control, any permission still to allow, and a way back
 * to the window. While a dictation is under way its icon shows how it is
 * going; otherwise, while a meeting records, the icon says so.
 */
export class AppTray {
  private readonly tray: Tray;
  private readonly idle: NativeImage;
  private summary: TraySummary | null = null;
  private dictationMenu: DictationMenu | null = null;
  private meeting: TrayMeeting | null = null;
  private meetingTimer: ReturnType<typeof setInterval> | null = null;
  /** The menu is open: rebuilding it then could close it, so wait. */
  private menuOpen = false;
  private stale = false;
  /** The glyph showing; null for the app's icon. */
  private glyph: TrayGlyph | null = null;
  private readonly images = new Map<string, NativeImage>();
  private animation: ReturnType<typeof setInterval> | null = null;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: DesktopAppConfig,
    private readonly actions: TrayActions,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.idle = nativeImage.createFromPath(config.trayIconPath);
    if (platform === "darwin") this.idle.setTemplateImage(true);
    this.tray = new Tray(this.idle);
    this.tray.setToolTip(config.productName);
    if (platform !== "darwin") this.tray.on("click", () => actions.open());
  }

  update(summary: TraySummary): void {
    this.summary = summary;
    this.render();
  }

  /** Dictation's section and icon; null while dictation is off. */
  setDictation(menu: DictationMenu | null): void {
    this.dictationMenu = menu;
    if (menu && menu.activity.phase !== "idle") this.clearDone();
    this.render();
  }

  /** The meeting being recorded; null when none is. */
  setMeeting(meeting: TrayMeeting | null): void {
    this.meeting = meeting;
    if (meeting && !this.meetingTimer) {
      // The recording time is in minutes: move it on now and then.
      this.meetingTimer = setInterval(() => this.render(), MEETING_TICK_MS);
      this.meetingTimer.unref?.();
    } else if (!meeting) {
      this.stopMeetingTimer();
    }
    this.render();
  }

  /** A dictation's text was delivered: a check, briefly. */
  dictationDone(): void {
    this.clearDone();
    this.doneTimer = setTimeout(() => {
      this.doneTimer = null;
      this.showIcon();
    }, DICTATION_DONE_MS);
    this.showIcon();
  }

  destroy(): void {
    this.clearDone();
    this.stopAnimation();
    this.stopMeetingTimer();
    this.tray.destroy();
  }

  private render(): void {
    if (!this.summary) return;
    const { toolTip, template } = trayMenu(
      this.summary,
      this.config.productName,
      this.actions,
      this.dictationMenu,
      this.platform,
      this.meeting,
    );
    this.tray.setToolTip(toolTip);
    if (this.menuOpen) {
      this.stale = true;
    } else {
      const menu = Menu.buildFromTemplate(template);
      menu.on("menu-will-show", () => {
        this.menuOpen = true;
      });
      menu.on("menu-will-close", () => {
        this.menuOpen = false;
        if (!this.stale) return;
        this.stale = false;
        // After the click it closed for has run.
        setTimeout(() => this.render(), 0);
      });
      this.tray.setContextMenu(menu);
    }
    this.showIcon();
  }

  private showIcon(): void {
    const phase = this.dictationMenu?.activity.phase ?? "idle";
    // A dictation is short and wants attention; a meeting shows otherwise.
    const glyph: TrayGlyph | null =
      phase !== "idle" ? phase : this.doneTimer ? "done" : this.meeting ? "meeting" : null;
    if (glyph === this.glyph) return;
    this.glyph = glyph;
    this.stopAnimation();
    if (glyph === "transcribing") {
      let frame = 0;
      this.tray.setImage(this.image(glyph, frame));
      this.animation = setInterval(() => {
        frame = (frame + 1) % TRANSCRIBING_FRAMES;
        this.tray.setImage(this.image("transcribing", frame));
      }, TRANSCRIBING_FRAME_MS);
      return;
    }
    this.tray.setImage(glyph ? this.image(glyph, 0) : this.idle);
  }

  /** Drawn once and kept: a few small images. */
  private image(glyph: TrayGlyph, frame: number): NativeImage {
    const style = trayGlyphStyle(this.platform);
    const key = `${glyph}/${frame}/${style.color.join(",")}`;
    let image = this.images.get(key);
    if (!image) {
      const { buffer, ...size } = trayGlyphBitmap(glyph, style, frame);
      image = nativeImage.createFromBitmap(buffer, size);
      if (this.platform === "darwin") image.setTemplateImage(true);
      this.images.set(key, image);
    }
    return image;
  }

  private stopAnimation(): void {
    if (this.animation) clearInterval(this.animation);
    this.animation = null;
  }

  private stopMeetingTimer(): void {
    if (this.meetingTimer) clearInterval(this.meetingTimer);
    this.meetingTimer = null;
  }

  private clearDone(): void {
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.doneTimer = null;
  }
}

/**
 * Template images on macOS. Elsewhere white on a dark taskbar and near black
 * on a light one, with a red recording dot.
 */
export function trayGlyphStyle(platform: NodeJS.Platform): TrayGlyphStyle {
  if (platform === "darwin") return { size: 18, scale: 2, color: [0, 0, 0] };
  const dark =
    platform === "win32" ? (nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ?? true) : true;
  return {
    size: platform === "win32" ? 16 : 22,
    scale: 2,
    color: dark ? [255, 255, 255] : [28, 28, 28],
    accent: [229, 72, 77],
  };
}

const MODIFIER_WORDS: Record<string, { mac: string; other: string }> = {
  command: { mac: "⌘ Command", other: "Windows" },
  option: { mac: "⌥ Option", other: "Alt" },
  control: { mac: "⌃ Control", other: "Ctrl" },
  shift: { mac: "⇧ Shift", other: "Shift" },
  fn: { mac: "Fn", other: "Fn" },
};

/**
 * A shortcut the menu can't show as a key equivalent, in words: "both ⌥
 * Option keys", "⌃ Control + Fn". Null for a key combination, which the menu
 * shows itself.
 */
export function dictationShortcutWords(
  shortcut: DesktopDictationShortcut,
  platform: NodeJS.Platform,
): string | null {
  const name = (modifier: string) => {
    const words = MODIFIER_WORDS[modifier] ?? { mac: modifier, other: modifier };
    return platform === "darwin" ? words.mac : words.other;
  };
  if (shortcut.kind === "modifierPair") return `both ${name(shortcut.modifier)} keys`;
  if (shortcut.kind === "modifierChord") return shortcut.modifiers.map(name).join(" + ");
  return null;
}

/** Long enough to say what went wrong; the tooltip has the rest. */
const MESSAGE_MAX = 60;

function shorten(message: string): string {
  return message.length <= MESSAGE_MAX
    ? message
    : `${message.slice(0, MESSAGE_MAX - 1).trimEnd()}…`;
}

/** The dictation section: its status while it is under way, and what can be done now. */
function dictationSection(
  menu: DictationMenu,
  actions: TrayActions,
  platform: NodeJS.Platform,
): { status: string | null; items: MenuItemConstructorOptions[] } {
  const act = (action: DictationMenuAction) => () => actions.dictation?.(action);
  const cancel: MenuItemConstructorOptions = {
    label: "Cancel Dictation",
    ...(menu.cancelKeys ? { accelerator: menu.cancelKeys, registerAccelerator: false } : {}),
    click: act({ kind: "cancel" }),
  };
  const activity = menu.activity;
  switch (activity.phase) {
    case "idle": {
      const several = menu.profiles.length > 1;
      return {
        status: null,
        items: [
          ...menu.profiles.map((profile): MenuItemConstructorOptions => {
            const words = dictationShortcutWords(profile.shortcut, platform);
            const name = several ? `Start Dictation: ${profile.name}` : "Start Dictation";
            const keys = words && (menu.mode === "hold" ? `hold ${words}` : words);
            return {
              label: keys ? `${name} (${keys})` : name,
              ...(profile.shortcut.kind === "accelerator"
                ? { accelerator: profile.shortcut.accelerator, registerAccelerator: false }
                : {}),
              click: act({ kind: "start", profileId: profile.id }),
            };
          }),
          {
            label: "Copy Last Dictation",
            enabled: menu.canCopyLast,
            click: act({ kind: "copyLast" }),
          },
        ],
      };
    }
    case "starting":
      return { status: "Dictation: starting…", items: [cancel] };
    case "recording":
      return {
        status: "Dictation: listening",
        items: [{ label: "Finish Dictation", click: act({ kind: "finish" }) }, cancel],
      };
    case "transcribing":
      return { status: "Dictation: transcribing…", items: [cancel] };
    case "failed":
      return {
        status: "Dictation: failed",
        items: [
          ...(activity.message ? [{ label: shorten(activity.message), enabled: false }] : []),
          ...(activity.retryable
            ? [{ label: "Retry Dictation", click: act({ kind: "retry" }) }]
            : []),
          { label: "Dismiss", click: act({ kind: "dismiss" }) },
        ],
      };
  }
}

/** "12 min", "1 h 5 min"; under a minute, "just started". */
export function recordedWords(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The meeting section: what is recording, for how long, and opening or stopping it. */
function meetingSection(
  meeting: TrayMeeting,
  actions: TrayActions,
  now: number,
): MenuItemConstructorOptions[] {
  const recorded =
    meeting.elapsedMilliseconds + (meeting.paused ? 0 : Math.max(0, now - meeting.at));
  const started = meeting.at - meeting.elapsedMilliseconds;
  const what = meeting.title ? shorten(meeting.title) : `Started ${clockTime(started)}`;
  return [
    {
      label: `Meeting: ${meeting.paused ? "paused" : "recording"} · ${recordedWords(recorded)}`,
      enabled: false,
    },
    {
      label: meeting.otherAccount ? `${what} · ${shorten(meeting.otherAccount)}` : what,
      enabled: false,
    },
    {
      label: meeting.canOpen ? "Open Live Transcript" : "Show Recording",
      click: () => actions.meeting?.("open"),
    },
    { label: "Stop Recording", click: () => actions.meeting?.("stop") },
    { type: "separator" },
  ];
}

/** What the tooltip says while a meeting records. */
function meetingTip(meeting: TrayMeeting | null, now: number): string | null {
  if (!meeting) return null;
  const recorded =
    meeting.elapsedMilliseconds + (meeting.paused ? 0 : Math.max(0, now - meeting.at));
  return meeting.paused
    ? `meeting recording paused (${recordedWords(recorded)})`
    : `recording a meeting (${recordedWords(recorded)})`;
}

/** What the tooltip says while a dictation is under way. */
function dictationTip(menu: DictationMenu | null | undefined): string | null {
  const activity = menu?.activity;
  switch (activity?.phase) {
    case "starting":
      return "dictation is starting…";
    case "recording":
      return "dictation is listening";
    case "transcribing":
      return "transcribing your dictation…";
    case "failed":
      return activity.message ? `dictation failed: ${activity.message}` : "dictation failed";
    default:
      return null;
  }
}

/**
 * The tray's tooltip and menu for a summary of this computer, how dictation
 * is going, and the meeting being recorded.
 */
export function trayMenu(
  summary: TraySummary,
  productName: string,
  actions: TrayActions,
  dictation: DictationMenu | null = null,
  platform: NodeJS.Platform = process.platform,
  meeting: TrayMeeting | null = null,
  now: number = Date.now(),
): { toolTip: string; template: MenuItemConstructorOptions[] } {
  const missing = summary.running ? (summary.missingPermissions ?? []) : [];
  const status = !summary.running
    ? "paused"
    : summary.needsReconnect
      ? "needs reconnecting"
      : missing.length > 0
        ? "screen control needs permission"
        : summary.reconnecting
          ? "connecting…"
          : "available to agents";
  const busy = dictationTip(dictation) ?? meetingTip(meeting, now);
  const toolTip = busy
    ? `${productName}: ${busy}`
    : !summary.connected
      ? productName
      : `${productName}: ${
          !summary.running
            ? "this computer is paused"
            : summary.needsReconnect
              ? "this computer needs reconnecting"
              : summary.reconnecting
                ? "connecting this computer…"
                : "this computer is available to agents"
        }`;
  const computer: MenuItemConstructorOptions[] = !summary.connected
    ? []
    : [
        { label: `This computer: ${status}`, enabled: false },
        // Reconnecting needs the account and workspace, which the window has.
        ...(summary.running && summary.needsReconnect
          ? [{ label: "Reconnect This Computer…", click: () => actions.open() }]
          : missing.map((permission) => ({
              label: PERMISSION_LABELS[permission],
              click: () => actions.allow(permission),
            }))),
        summary.running
          ? { label: "Pause This Computer", click: () => actions.pause() }
          : { label: "Resume This Computer", click: () => actions.resume() },
        { type: "separator" },
      ];
  const section = dictation ? dictationSection(dictation, actions, platform) : null;
  const dictationItems: MenuItemConstructorOptions[] = section
    ? [
        ...(section.status ? [{ label: section.status, enabled: false }] : []),
        ...section.items,
        { type: "separator" },
      ]
    : [];
  return {
    toolTip,
    template: [
      ...(meeting ? meetingSection(meeting, actions, now) : []),
      ...dictationItems,
      ...computer,
      { label: `Open ${productName}`, click: () => actions.open() },
      { type: "separator" },
      { label: `Quit ${productName}`, click: () => actions.quit() },
    ],
  };
}
