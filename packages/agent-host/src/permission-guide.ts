// A small floating guide beside macOS System Settings while the person allows
// one screen-control permission there. It shows what to look for (the app's
// own row and its switch), follows the Settings window as it moves, and
// confirms the moment the permission is allowed. When macOS then offers to quit
// the app (it does for Screen Recording and Input Monitoring), the guide points
// at "Later" and waits for that choice before handing back to the app, so the
// offer isn't left waiting behind it. Electron is passed in, so this package
// doesn't depend on it.
import { spawn, type ChildProcess } from "node:child_process";

import {
  macSystemNames,
  THIS_COMPUTER_PERMISSION_ORDER,
  type ThisComputerPermissionId,
  type ThisComputerSystemNames,
} from "@opengeni/sdk/this-computer";

/** The parts of Electron the guide uses. Pass `require("electron")` or an import of it. */
export interface PermissionGuideElectron {
  BrowserWindow: new (options: Record<string, unknown>) => GuideWindow;
  screen: {
    getDisplayMatching(rect: Rect): { workArea: Rect };
  };
  nativeTheme: { shouldUseDarkColors: boolean };
}

interface GuideWindow {
  loadURL(url: string): Promise<void>;
  showInactive(): void;
  hide(): void;
  close(): void;
  destroy(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  setBounds(bounds: Rect): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setVisibleOnAllWorkspaces?(visible: boolean, options?: Record<string, unknown>): void;
  on(event: "closed", listener: () => void): void;
  webContents: {
    executeJavaScript(code: string): Promise<unknown>;
    on(event: "will-navigate", listener: (event: { preventDefault(): void }) => void): void;
    setWindowOpenHandler?(handler: () => { action: "deny" }): void;
  };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PermissionGuideStep {
  /** One short line: what to do, e.g. "Turn on Acme". */
  title: string;
  /** What the person looks for and what happens next. */
  body: string;
  /** A heads-up about a system prompt that may follow. */
  hint?: string;
}

export interface PermissionGuideLabels {
  /** The list the app's row is in, as System Settings names it. */
  listName: Record<ThisComputerPermissionId, string>;
  step: Record<ThisComputerPermissionId, PermissionGuideStep>;
  /** Shown for a moment once allowed. */
  done: string;
  /**
   * While macOS's own prompt ("… would like to record this computer's
   * screen") is up. `open` and `deny` are its buttons, as macOS names them.
   */
  systemPrompt: { title: string; body: string; open: string; deny: string };
  /**
   * After some permissions macOS offers to quit and reopen the app. It needn't:
   * the agent restarts by itself. `quit` and `later` are the offer's own
   * buttons, as macOS names them in that language.
   */
  quitOffer: { title: string; body: string; quit: string; later: string };
  /** The close button's accessible name. */
  close: string;
  /** "Step 1 of 3". */
  progress(step: number, total: number): string;
}

/**
 * The guide in English. `names` are what macOS calls things on screen, in the
 * Mac's own language (`macSystemNames(app.getPreferredSystemLanguages())`).
 */
export function defaultPermissionGuideLabels(
  appName: string,
  names: ThisComputerSystemNames = macSystemNames([]),
): PermissionGuideLabels {
  const step = {
    title: `Turn on ${appName}`,
    body: `Find ${appName} in the list and turn its switch on. Your Mac may ask for your password.`,
  };
  return {
    listName: names.permissionList,
    step: {
      screenRecording: step,
      accessibility: step,
      inputMonitoring: step,
      files: {
        title: `Turn on ${appName}'s folders`,
        body: `Open ${appName} in the list and turn on Desktop, Documents and Downloads.`,
      },
    },
    done: "Done",
    systemPrompt: {
      title: `Choose ${names.openSettings}`,
      body: `Your Mac asks first. Then turn on ${appName} here.`,
      open: names.openSettings,
      deny: names.deny,
    },
    quitOffer: {
      title: "One more click",
      body: `Choose ${names.later}. ${appName} doesn't need to quit.`,
      quit: names.quit,
      later: names.later,
    },
    close: "Close",
    progress: (current, total) => `Step ${current} of ${total}`,
  };
}

export interface PermissionGuideOptions {
  electron: PermissionGuideElectron;
  appName: string;
  /** The app's icon as a data: URL (PNG), shown in the pictured row. Read once, when first shown. */
  appIcon(): Promise<string> | string;
  labels?: PermissionGuideLabels;
  /** Every permission being asked for, in order, for the step count. */
  order?: readonly ThisComputerPermissionId[];
  /** Bring the app back to the front, e.g. after the last permission. */
  onFinished?(): void;
  /** The person closed the guide. */
  onDismissed?(): void;
}

const WIDTH = 320;
const HEIGHT = 236;
/** Files & Folders pictures the app's row opened, with a folder's switch under it. */
const FILES_HEIGHT = 276;

function guideSize(id: ThisComputerPermissionId | null): { width: number; height: number } {
  return { width: WIDTH, height: id === "files" ? FILES_HEIGHT : HEIGHT };
}
const GAP = 14;
const DONE_MS = 1_400;

/**
 * Finds System Settings' front window about three times a second, without
 * any permission: window bounds and owners are readable by every app. A small
 * Settings window over it is a question Settings is asking, such as the offer
 * to quit the app. Settings counts as in front when the topmost ordinary window
 * is its own or one of the system's prompts over it; the window list is read
 * fresh each time, unlike NSWorkspace's frontmost app, which a script without
 * a running event loop sees only as it was at launch.
 */
const TRACK_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run() {
  var out = $.NSFileHandle.fileHandleWithStandardOutput;
  for (;;) {
    var line = 'null';
    var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.systempreferences');
    if (apps.count > 0) {
      var pid = apps.objectAtIndex(0).processIdentifier;
      var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
      var main = null;
      var small = [];
      var prompt = false;
      var isFront = null;
      for (var i = 0; i < list.length; i++) {
        var w = list[i];
        var b = w.kCGWindowBounds;
        var asking = w.kCGWindowOwnerName === 'universalAccessAuthWarn' || w.kCGWindowOwnerName === 'SecurityAgent';
        if (isFront === null && w.kCGWindowLayer === 0 && b && b.Width >= 100 && b.Height >= 60) {
          isFront = w.kCGWindowOwnerPID === pid || asking;
        }
        if (w.kCGWindowOwnerName === 'universalAccessAuthWarn' && w.kCGWindowLayer === 0) prompt = true;
        if (w.kCGWindowOwnerPID !== pid || w.kCGWindowLayer !== 0 || !b) continue;
        if (b.Width > 300 && b.Height > 200) { main = b; break; }
        if (b.Width >= 150 && b.Height >= 100) small.push(b);
      }
      if (main) {
        var alert = false;
        for (var j = 0; j < small.length; j++) {
          var cx = small[j].X + small[j].Width / 2;
          var cy = small[j].Y + small[j].Height / 2;
          if (cx > main.X && cx < main.X + main.Width && cy > main.Y && cy < main.Y + main.Height) alert = true;
        }
        line = JSON.stringify({ x: main.X, y: main.Y, width: main.Width, height: main.Height, front: !!isFront, alert: alert, prompt: prompt });
      }
    }
    out.writeData($(line + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    delay(0.3);
  }
}
`;

interface SettingsWindow extends Rect {
  front: boolean;
  /** Settings is asking something over its window, e.g. offering to quit the app. */
  alert: boolean;
  /** macOS's own permission prompt is up. */
  prompt: boolean;
}

/** Where the guide goes: beside the Settings window, else inside its corner. */
export function placeGuide(
  settings: Rect,
  workArea: Rect,
  size: { width: number; height: number } = { width: WIDTH, height: HEIGHT },
): Rect & { side: "right" | "left" | "inside" } {
  const y = Math.min(
    Math.max(settings.y + 56, workArea.y + 8),
    workArea.y + workArea.height - size.height - 8,
  );
  const right = settings.x + settings.width + GAP;
  if (right + size.width <= workArea.x + workArea.width - 8) {
    return { x: right, y, ...size, side: "right" };
  }
  const left = settings.x - GAP - size.width;
  if (left >= workArea.x + 8) return { x: left, y, ...size, side: "left" };
  return {
    x: settings.x + settings.width - size.width - 18,
    y: settings.y + settings.height - size.height - 18,
    ...size,
    side: "inside",
  };
}

/**
 * One guide per app. `show` for the permission the person is allowing now,
 * `hide` when they stop; `granted` plays the confirmation, points at "Later"
 * if macOS offers to quit the app, and closes it.
 */
export class PermissionGuide {
  private window: GuideWindow | null = null;
  private tracker: ChildProcess | null = null;
  private current: ThisComputerPermissionId | null = null;
  private side: "right" | "left" | "inside" | null = null;
  private doneTimer: NodeJS.Timeout | null = null;
  /** Settings showed a question over its window when last seen. */
  private alertOpen = false;
  /** Allowed; waiting for the person to answer macOS's offer to quit the app. */
  private offering = false;
  /** Showing the pointer at macOS's own prompt. */
  private prompting = false;
  private icon: string | null = null;
  private labels: PermissionGuideLabels;

  constructor(private readonly options: PermissionGuideOptions) {
    this.labels = options.labels ?? defaultPermissionGuideLabels(options.appName);
  }

  /** New words, e.g. when the person changes the app's language; used from the next step on. */
  setLabels(labels: PermissionGuideLabels): void {
    this.labels = labels;
  }

  /** Guide the person to allow `id`. Only on macOS. */
  show(id: ThisComputerPermissionId): void {
    if (process.platform !== "darwin") return;
    if (this.doneTimer) {
      clearTimeout(this.doneTimer);
      this.doneTimer = null;
    }
    this.current = id;
    this.side = null;
    this.offering = false;
    this.prompting = false;
    this.ensureWindow();
    void this.render();
    this.track();
  }

  /** The permission was allowed: confirm it, then go away, or first point at "Later". */
  granted(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !this.current) return this.hide();
    void window.webContents.executeJavaScript("window.guideDone && window.guideDone()");
    this.doneTimer = setTimeout(() => {
      this.doneTimer = null;
      if (this.alertOpen && this.window && !this.window.isDestroyed()) {
        this.offering = true;
        void this.window.webContents.executeJavaScript("window.guideOffer && window.guideOffer()");
        return;
      }
      this.finish();
    }, DONE_MS);
  }

  hide(): void {
    this.current = null;
    this.offering = false;
    this.prompting = false;
    this.alertOpen = false;
    this.stopTracking();
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  private finish(): void {
    this.hide();
    this.options.onFinished?.();
  }

  private ensureWindow(): void {
    if (this.window && !this.window.isDestroyed()) return;
    const { BrowserWindow } = this.options.electron;
    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      // A panel floats beside System Settings without taking focus from it.
      type: "panel",
      focusable: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        spellcheck: false,
      },
    });
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
    window.on("closed", () => {
      if (this.window !== window) return;
      this.window = null;
      const dismissed = this.current !== null && this.doneTimer === null;
      this.current = null;
      this.stopTracking();
      if (dismissed) this.options.onDismissed?.();
    });
    this.window = window;
  }

  private async render(): Promise<void> {
    if (this.icon === null) {
      this.icon = await Promise.resolve(this.options.appIcon()).catch(() => "");
    }
    const window = this.window;
    const id = this.current;
    if (!window || window.isDestroyed() || !id) return;
    // Allowing Accessibility also allows noticing keyboard and mouse use, so
    // Input Monitoring is a step of its own only when it's still asked for.
    const order =
      this.options.order ??
      THIS_COMPUTER_PERMISSION_ORDER.filter(
        (permission) => permission !== "inputMonitoring" || id === "inputMonitoring",
      );
    const index = Math.max(0, order.indexOf(id));
    const html = guideHtml({
      appName: this.options.appName,
      appIcon: this.icon,
      listName: this.labels.listName[id],
      step: this.labels.step[id],
      progress: order.length > 1 ? this.labels.progress(index + 1, order.length) : "",
      done: this.labels.done,
      systemPrompt: this.labels.systemPrompt,
      quitOffer: this.labels.quitOffer,
      close: this.labels.close,
      dark: this.options.electron.nativeTheme.shouldUseDarkColors,
      side: this.side ?? "right",
      disclosure: id === "files",
    });
    void window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .then(() => {
        // A prompt seen while the page loaded.
        if (this.prompting && !window.isDestroyed()) {
          void window.webContents.executeJavaScript(
            "window.guidePrompt && window.guidePrompt(true)",
          );
        }
      })
      .catch(() => undefined);
  }

  private track(): void {
    if (this.tracker) return;
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", TRACK_SCRIPT], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.tracker = child;
    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      const last = lines.at(-1);
      if (last !== undefined) this.follow(parseSettingsWindow(last));
    });
    child.once("exit", () => {
      if (this.tracker === child) this.tracker = null;
    });
  }

  private stopTracking(): void {
    const child = this.tracker;
    this.tracker = null;
    child?.kill();
  }

  /** Keep beside the Settings window; out of the way while another app is in front. */
  private follow(settings: SettingsWindow | null): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !this.current) return;
    this.alertOpen = settings?.alert ?? false;
    if (this.offering && !this.alertOpen && (!settings || settings.front)) {
      // The person answered the offer (or Settings closed): back to the app.
      this.finish();
      return;
    }
    const prompting = (settings?.prompt ?? false) && !this.offering && this.doneTimer === null;
    if (prompting !== this.prompting) {
      this.prompting = prompting;
      void window.webContents.executeJavaScript(
        `window.guidePrompt && window.guidePrompt(${prompting})`,
      );
    }
    if (!settings || !settings.front) {
      if (window.isVisible() && this.doneTimer === null) window.hide();
      return;
    }
    const { workArea } = this.options.electron.screen.getDisplayMatching(settings);
    const placed = placeGuide(settings, workArea, guideSize(this.current));
    window.setBounds({ x: placed.x, y: placed.y, width: placed.width, height: placed.height });
    if (placed.side !== this.side) {
      this.side = placed.side;
      void window.webContents.executeJavaScript(
        `window.guideSide && window.guideSide(${JSON.stringify(placed.side)})`,
      );
    }
    if (!window.isVisible()) window.showInactive();
  }
}

export function parseSettingsWindow(line: string): SettingsWindow | null {
  try {
    const value = JSON.parse(line) as Partial<SettingsWindow> | null;
    if (!value) return null;
    const { x, y, width, height, front } = value;
    if ([x, y, width, height].some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      return null;
    }
    return {
      x: x!,
      y: y!,
      width: width!,
      height: height!,
      front: front === true,
      alert: value.alert === true,
      prompt: value.prompt === true,
    };
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

/** The guide's page: self-contained, no network, no script beyond its own. */
const CURSOR = `<svg class="cursor" viewBox="0 0 16 16"><path d="M2 1l11 7-5 1-2.5 4.5z" fill="#1d1d1f" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

export function guideHtml(input: {
  appName: string;
  appIcon: string;
  listName: string;
  step: PermissionGuideStep;
  progress: string;
  done: string;
  systemPrompt: PermissionGuideLabels["systemPrompt"];
  quitOffer: PermissionGuideLabels["quitOffer"];
  close: string;
  dark: boolean;
  side: "right" | "left" | "inside";
  /** The app's row opens to switches of its own, as in Files & Folders. */
  disclosure?: boolean;
}): string {
  const icon = /^data:image\/(png|jpeg|svg\+xml);/u.test(input.appIcon) ? input.appIcon : "";
  return `<!doctype html>
<html lang="en" data-theme="${input.dark ? "dark" : "light"}" data-side="${input.side}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root{--bg:rgba(250,250,252,.94);--fg:#1d1d1f;--muted:#6e6e73;--line:rgba(0,0,0,.09);--row:#fff;--accent:#0a84ff;--off:#e3e3e8;--ok:#28a745}
[data-theme=dark]{--bg:rgba(40,40,44,.94);--fg:#f5f5f7;--muted:#a1a1a6;--line:rgba(255,255,255,.1);--row:rgba(255,255,255,.06);--off:#48484d;--ok:#32d74b}
*{box-sizing:border-box;margin:0}
html,body{height:100%;background:transparent;font:13px/1.38 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color:var(--fg);-webkit-user-select:none;user-select:none;overflow:hidden}
.card{position:absolute;inset:6px;border-radius:14px;background:var(--bg);-webkit-backdrop-filter:blur(30px) saturate(1.6);backdrop-filter:blur(30px) saturate(1.6);box-shadow:0 0 0 .5px var(--line),0 10px 30px rgba(0,0,0,.18);padding:14px 16px 14px;display:flex;flex-direction:column;gap:10px}
.arrow{position:absolute;top:30px;width:14px;height:14px;background:var(--bg);transform:rotate(45deg);box-shadow:-.5px .5px 0 var(--line)}
[data-side=right] .arrow{left:0}
[data-side=left] .arrow{right:0;box-shadow:.5px -.5px 0 var(--line)}
[data-side=inside] .arrow{display:none}
.top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.progress{font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--muted);text-transform:uppercase}
.x{appearance:none;border:0;background:transparent;color:var(--muted);width:20px;height:20px;border-radius:10px;font-size:15px;line-height:20px;cursor:default}
.x:hover{background:var(--line)}
h1{font-size:15px;font-weight:650;letter-spacing:-.01em}
.where{font-size:11.5px;color:var(--muted);margin-top:-6px}
.row{position:relative;display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:9px;background:var(--row);box-shadow:0 0 0 .5px var(--line)}
.row img{width:22px;height:22px;border-radius:5px}
.row .name{flex:1;font-weight:500}
.chev{width:10px;height:10px;flex:none;color:var(--muted);transform:rotate(90deg)}
.sub{margin:-6px 0 0 30px;padding:7px 10px}
.bar{flex:1;max-width:120px;height:7px;border-radius:4px;background:var(--off)}
.switch{position:relative;width:32px;height:19px;border-radius:10px;background:var(--off);animation:sw 2.8s ease-in-out infinite}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);animation:knob 2.8s ease-in-out infinite}
.cursor{position:absolute;right:4px;top:18px;width:16px;height:16px;animation:cur 2.8s ease-in-out infinite}
@keyframes sw{0%,38%{background:var(--off)}48%,88%{background:var(--accent)}100%{background:var(--off)}}
@keyframes knob{0%,38%{transform:translateX(0)}48%,88%{transform:translateX(13px)}100%{transform:translateX(0)}}
@keyframes cur{0%{transform:translate(18px,16px);opacity:0}18%{opacity:1}34%,44%{transform:translate(-6px,-6px)}40%{transform:translate(-6px,-6px) scale(.85)}70%{transform:translate(-6px,-6px);opacity:1}88%,100%{transform:translate(18px,16px);opacity:0}}
p{color:var(--fg)}
.hint{font-size:11.5px;color:var(--muted)}
.done{position:absolute;inset:0;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:var(--bg);opacity:0;pointer-events:none;transition:opacity .2s}
.done svg{width:44px;height:44px}
.done circle{fill:var(--ok)}
.done path{stroke:#fff;stroke-width:3.2;fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:30;stroke-dashoffset:30;transition:stroke-dashoffset .35s .12s ease-out}
.done b{font-size:15px}
body.is-done .done{opacity:1}
body.is-done .done path{stroke-dashoffset:0}
.ask{display:contents}
.offer,.prompt{display:none;flex-direction:column;gap:10px}
body.is-prompt .ask{display:none}
body.is-prompt .prompt{display:flex}
body.is-offer .ask{display:none}
body.is-offer .prompt{display:none}
body.is-offer .offer{display:flex}
body.is-offer .done{opacity:0;transition:none}
.alert{position:relative;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:11px;background:var(--row);box-shadow:0 0 0 .5px var(--line)}
.alert.across{flex-direction:row;justify-content:flex-end;gap:8px}
.alert.across .abtn{padding:0 12px;border-radius:7px;height:22px}
.abtn{height:24px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:500;background:var(--off);color:var(--fg)}
.abtn.quit,.abtn.deny{opacity:.45}
.abtn.quit{background:var(--accent);color:#fff}
.abtn.pick{box-shadow:0 0 0 2px var(--accent);animation:ring 1.6s ease-in-out infinite}
.alert .cursor{right:22px;top:auto;bottom:2px;animation:point 1.6s ease-in-out infinite}
.alert.across .cursor{right:auto;left:42%;bottom:-2px}
@keyframes ring{0%,100%{box-shadow:0 0 0 2px var(--accent)}50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 45%,transparent)}}
@keyframes point{0%,100%{transform:translate(6px,6px)}50%{transform:translate(0,0)}}
@media (prefers-reduced-motion:reduce){.switch,.switch::after,.cursor,.abtn.pick{animation:none}.switch{background:var(--accent)}.switch::after{transform:translateX(13px)}.cursor{display:none}}
</style>
</head>
<body>
<div class="arrow"></div>
<div class="card" role="dialog" aria-label="${escapeHtml(input.step.title)}">
  <div class="top"><span class="progress">${escapeHtml(input.progress)}</span><button class="x" aria-label="${escapeHtml(input.close)}" onclick="window.close()">&#215;</button></div>
  <div class="ask">
    <h1>${escapeHtml(input.step.title)}</h1>
    <div class="where">${escapeHtml(input.listName)}</div>
    ${
      input.disclosure
        ? `<div class="row" aria-hidden="true"><svg class="chev" viewBox="0 0 10 10"><path d="M3 1.5L6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>${icon ? `<img src="${icon}" alt="">` : ""}<span class="name">${escapeHtml(input.appName)}</span></div>
    <div class="row sub" aria-hidden="true"><span class="bar"></span><span class="name"></span><span class="switch"></span>
      ${CURSOR}
    </div>`
        : `<div class="row" aria-hidden="true">${icon ? `<img src="${icon}" alt="">` : ""}<span class="name">${escapeHtml(input.appName)}</span><span class="switch"></span>
      ${CURSOR}
    </div>`
    }
    <p>${escapeHtml(input.step.body)}</p>
    ${input.step.hint ? `<p class="hint">${escapeHtml(input.step.hint)}</p>` : ""}
  </div>
  <div class="prompt" aria-live="polite">
    <h1>${escapeHtml(input.systemPrompt.title)}</h1>
    <div class="alert across" aria-hidden="true"><span class="abtn pick">${escapeHtml(input.systemPrompt.open)}</span><span class="abtn deny">${escapeHtml(input.systemPrompt.deny)}</span>
      <svg class="cursor" viewBox="0 0 16 16"><path d="M2 1l11 7-5 1-2.5 4.5z" fill="#1d1d1f" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>
    </div>
    <p>${escapeHtml(input.systemPrompt.body)}</p>
  </div>
  <div class="offer" aria-live="polite">
    <h1>${escapeHtml(input.quitOffer.title)}</h1>
    <div class="alert" aria-hidden="true"><span class="abtn quit">${escapeHtml(input.quitOffer.quit)}</span><span class="abtn pick">${escapeHtml(input.quitOffer.later)}</span>
      <svg class="cursor" viewBox="0 0 16 16"><path d="M2 1l11 7-5 1-2.5 4.5z" fill="#1d1d1f" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>
    </div>
    <p>${escapeHtml(input.quitOffer.body)}</p>
  </div>
  <div class="done" aria-live="polite"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="22"/><path d="M13 22.5l6 6 12-13"/></svg><b>${escapeHtml(input.done)}</b></div>
</div>
<script>
window.guideDone=function(){document.body.classList.add("is-done")};
window.guideOffer=function(){document.body.classList.add("is-offer")};
window.guidePrompt=function(on){document.body.classList.toggle("is-prompt",!!on)};
window.guideSide=function(side){document.documentElement.dataset.side=side};
</script>
</body>
</html>`;
}
