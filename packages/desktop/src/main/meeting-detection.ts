// Call detection: when a call app (Zoom, Teams, Slack, Meet in a browser)
// starts using the microphone, offer to record the meeting; when the call the
// app is recording ends, offer to stop. The bundled audio helper reports
// which processes use a microphone (`--watch-microphone`, no permission
// needed); this module decides which of them is a call and when to ask. It
// never starts or stops a recording itself: the person chooses on the
// notification, and the page carries it out.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DesktopMeetingDetectionStatus, DesktopMeetingRequest } from "../contract";

/** One process using a microphone, as the helper reports it. */
export interface MicrophoneUser {
  pid: number;
  name: string;
  path: string | null;
  bundleId: string | null;
  /** Executable paths of the apps it belongs to, nearest first. */
  owners: string[];
}

export interface CallApp {
  /** Stable id, e.g. "zoom". */
  id: string;
  /** The name people know, e.g. "Zoom". */
  name: string;
  /** A browser: the microphone may be a call or something else. */
  browser: boolean;
  /** A name for the meeting, e.g. "Zoom meeting". */
  title: string;
}

interface KnownApp {
  id: string;
  name: string;
  browser?: boolean;
  title?: string;
  /** macOS bundle ids. */
  bundleIds: readonly string[];
  /** Executable or stream names, compared without case, ".exe" or punctuation. */
  names: readonly string[];
}

const KNOWN_APPS: readonly KnownApp[] = [
  {
    id: "zoom",
    name: "Zoom",
    bundleIds: ["us.zoom.xos"],
    names: ["zoom.us", "zoom", "zoomwebviewhost"],
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    title: "Teams meeting",
    bundleIds: ["com.microsoft.teams2", "com.microsoft.teams"],
    names: ["ms-teams", "msteams", "teams", "microsoft teams", "teams-for-linux"],
  },
  {
    id: "slack",
    name: "Slack",
    title: "Slack huddle",
    bundleIds: ["com.tinyspeck.slackmacgap"],
    names: ["slack"],
  },
  {
    id: "webex",
    name: "Webex",
    bundleIds: ["com.cisco.webexmeetingsapp", "cisco-systems.spark"],
    names: ["webex", "webexmta", "ciscocollabhost", "atmgr", "ciscowebexstart"],
  },
  {
    id: "facetime",
    name: "FaceTime",
    title: "FaceTime call",
    bundleIds: ["com.apple.facetime"],
    names: ["facetime", "avconferenced"],
  },
  {
    id: "discord",
    name: "Discord",
    title: "Discord call",
    bundleIds: ["com.hnc.discord"],
    names: ["discord"],
  },
  {
    id: "skype",
    name: "Skype",
    title: "Skype call",
    bundleIds: ["com.skype.skype"],
    names: ["skype"],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    title: "WhatsApp call",
    bundleIds: ["net.whatsapp.whatsapp", "desktop.whatsapp"],
    names: ["whatsapp"],
  },
  {
    id: "chrome",
    name: "Google Chrome",
    browser: true,
    bundleIds: ["com.google.chrome", "com.google.chrome.beta", "com.google.chrome.canary"],
    names: ["chrome", "google chrome", "google-chrome", "google-chrome-stable"],
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    browser: true,
    bundleIds: ["com.microsoft.edgemac"],
    names: ["msedge", "microsoft edge", "microsoft-edge"],
  },
  {
    id: "firefox",
    name: "Firefox",
    browser: true,
    bundleIds: ["org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition"],
    names: ["firefox", "firefox-esr", "firefox-bin"],
  },
  {
    id: "safari",
    name: "Safari",
    browser: true,
    bundleIds: ["com.apple.safari"],
    names: ["safari"],
  },
  {
    id: "arc",
    name: "Arc",
    browser: true,
    bundleIds: ["company.thebrowser.browser"],
    names: ["arc"],
  },
  {
    id: "brave",
    name: "Brave",
    browser: true,
    bundleIds: ["com.brave.browser"],
    names: ["brave", "brave browser", "brave-browser"],
  },
  {
    id: "chromium",
    name: "Chromium",
    browser: true,
    bundleIds: ["org.chromium.chromium"],
    names: ["chromium", "chromium-browser"],
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    browser: true,
    bundleIds: ["com.vivaldi.vivaldi"],
    names: ["vivaldi", "vivaldi-stable"],
  },
];

function normalized(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.exe$/u, "")
    .replace(/[^a-z0-9]/gu, "");
}

function fileName(path: string): string {
  return path.split(/[/\\]/u).pop() ?? path;
}

const BY_NAME = new Map<string, KnownApp>();
const BY_BUNDLE = new Map<string, KnownApp>();
for (const known of KNOWN_APPS) {
  for (const name of known.names) BY_NAME.set(normalized(name), known);
  for (const bundleId of known.bundleIds) BY_BUNDLE.set(bundleId.toLowerCase(), known);
}

function callApp(known: KnownApp): CallApp {
  return {
    id: known.id,
    name: known.name,
    browser: known.browser === true,
    title: known.title ?? (known.browser ? "Meeting" : `${known.name} meeting`),
  };
}

/** A macOS helper's bundle id often extends its app's: com.google.Chrome.helper. */
function byBundleId(bundleId: string): KnownApp | null {
  let candidate = bundleId.toLowerCase();
  for (;;) {
    const known = BY_BUNDLE.get(candidate);
    if (known) return known;
    const dot = candidate.lastIndexOf(".");
    if (dot <= 0) return null;
    candidate = candidate.slice(0, dot);
  }
}

function byPath(path: string): KnownApp | null {
  const named = BY_NAME.get(normalized(fileName(path)));
  if (named) return named;
  // A macOS helper inside an app bundle: /Applications/Slack.app/Contents/Frameworks/...
  const bundle = /([^/]+)\.app\//u.exec(path);
  return bundle?.[1] ? (BY_NAME.get(normalized(bundle[1])) ?? null) : null;
}

/** The call app a microphone user belongs to, or null for anything else. */
export function identifyCallApp(user: MicrophoneUser): CallApp | null {
  const known =
    (user.bundleId ? byBundleId(user.bundleId) : null) ??
    (user.path ? byPath(user.path) : null) ??
    BY_NAME.get(normalized(user.name)) ??
    user.owners.map(byPath).find((match) => match !== null) ??
    null;
  return known ? callApp(known) : null;
}

/**
 * The folder that holds the app's own executables, so its helpers (and the
 * web app's own microphone) never count as a call: the `.app` bundle on
 * macOS, the install folder elsewhere.
 */
export function ownAppRoot(execPath: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    const end = execPath.indexOf(".app/");
    if (end >= 0) return execPath.slice(0, end + ".app/".length);
  }
  const cut = Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\"));
  return cut >= 0 ? execPath.slice(0, cut + 1) : execPath;
}

/** How the app recognizes its own processes. */
export interface OwnApp {
  pid: number;
  /** macOS: the app's bundle id, which its helpers' ids start with. */
  bundlePrefix: string;
  /** From {@link ownAppRoot}. */
  root: string;
  platform: NodeJS.Platform;
}

function underRoot(path: string, root: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? path.toLowerCase().startsWith(root.toLowerCase())
    : path.startsWith(root);
}

export function isOwnApp(user: MicrophoneUser, own: OwnApp): boolean {
  if (user.pid === own.pid) return true;
  if (user.bundleId && own.bundlePrefix && user.bundleId.startsWith(own.bundlePrefix)) return true;
  // The nearest owner only: further up a parent chain is a shell or the desktop.
  return [user.path, user.owners[0] ?? null].some(
    (path) => path !== null && underRoot(path, own.root, own.platform),
  );
}

export type WatchEvent =
  | { kind: "users"; users: MicrophoneUser[] }
  | { kind: "error"; code: string; message: string };

/** Parse one line of the helper's output. */
export function parseWatchLine(line: string): WatchEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.event === "error") {
    return {
      kind: "error",
      code: typeof event.code === "string" ? event.code : "unknown",
      message: typeof event.message === "string" ? event.message : "",
    };
  }
  if (event.event !== "microphone" || !Array.isArray(event.users)) return null;
  const users: MicrophoneUser[] = [];
  for (const entry of event.users as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const user = entry as Record<string, unknown>;
    if (typeof user.pid !== "number" || typeof user.name !== "string") continue;
    users.push({
      pid: user.pid,
      name: user.name,
      path: typeof user.path === "string" ? user.path : null,
      bundleId: typeof user.bundleId === "string" ? user.bundleId : null,
      owners: Array.isArray(user.owners)
        ? user.owners.filter((owner): owner is string => typeof owner === "string")
        : [],
    });
  }
  return { kind: "users", users };
}

/** A call must hold the microphone this long before the app asks. */
export const PROMPT_AFTER_MS = 3_000;
/** A call app that lets go of the microphone this long has ended its call. */
export const ENDED_AFTER_MS = 8_000;

export type MeetingPrompt = { kind: "record"; app: CallApp } | { kind: "stop"; app: CallApp };

export interface ShownPrompt {
  close(): void;
}

interface TrackedCall {
  app: CallApp;
  since: number;
  lastSeen: number;
  active: boolean;
  asked: boolean;
}

/**
 * When to ask. Pure: fed microphone users and the time, it shows and closes
 * prompts through `show`. A call is asked about once, after it has held the
 * microphone for a few seconds, and never while the page records; a recording
 * made during calls offers to stop once all of them have ended.
 */
export class MeetingPrompter {
  private readonly calls = new Map<string, TrackedCall>();
  private recording = false;
  /** The calls going on while the page records. */
  private recorded = new Set<string>();
  private shown: { prompt: MeetingPrompt; handle: ShownPrompt } | null = null;
  private enabled = true;

  constructor(
    private readonly own: OwnApp,
    private readonly show: (prompt: MeetingPrompt) => ShownPrompt,
  ) {}

  setEnabled(enabled: boolean, now: number): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.calls.clear();
      this.recorded.clear();
      this.close();
    }
    this.evaluate(now);
  }

  /** The microphone users the helper reported. */
  observe(users: readonly MicrophoneUser[], now: number): void {
    if (!this.enabled) return;
    const active = new Map<string, CallApp>();
    for (const user of users) {
      if (isOwnApp(user, this.own)) continue;
      const app = identifyCallApp(user);
      if (app) active.set(app.id, app);
    }
    for (const [id, call] of this.calls) {
      if (call.active && !active.has(id)) {
        call.active = false;
        call.lastSeen = now;
      }
    }
    for (const [id, app] of active) {
      const call = this.calls.get(id);
      if (!call) {
        // A call already going on when recording started isn't asked about.
        this.calls.set(id, { app, since: now, lastSeen: now, active: true, asked: this.recording });
      } else {
        // Back within the grace period (a mute, a device switch): the same call.
        call.active = true;
        call.lastSeen = now;
      }
    }
    if (this.recording) for (const id of active.keys()) this.recorded.add(id);
    this.evaluate(now);
  }

  /** Whether the page records a meeting. */
  setRecording(recording: boolean, now: number): void {
    if (recording === this.recording) return;
    this.recording = recording;
    this.recorded = new Set(
      recording ? [...this.calls].filter(([, call]) => call.active).map(([id]) => id) : [],
    );
    // Whichever prompt is up no longer applies.
    this.close();
    // Calls that were going on are this recording's; don't offer them again after it.
    for (const call of this.calls.values()) call.asked = true;
    this.evaluate(now);
  }

  /** Run about once a second: the prompts depend on how long things have lasted. */
  evaluate(now: number): void {
    for (const [id, call] of this.calls) {
      if (call.active || now - call.lastSeen < ENDED_AFTER_MS) continue;
      this.calls.delete(id);
      if (this.shown?.prompt.kind === "record" && this.shown.prompt.app.id === id) this.close();
      if (this.recording && this.recorded.delete(id) && this.recorded.size === 0) {
        this.present({ kind: "stop", app: call.app });
      }
    }
    if (!this.enabled || this.recording) return;
    for (const call of this.calls.values()) {
      if (call.asked || !call.active || now - call.since < PROMPT_AFTER_MS) continue;
      call.asked = true;
      // A call app's question isn't replaced by a browser's.
      if (this.shown?.prompt.kind === "record" && !this.shown.prompt.app.browser) continue;
      this.present({ kind: "record", app: call.app });
    }
  }

  /** The person acted on the prompt; it is gone. */
  dismissed(prompt: MeetingPrompt): void {
    if (this.shown?.prompt === prompt) this.shown = null;
  }

  /** The call apps holding the microphone now. */
  activeCalls(): string[] {
    return [...this.calls.values()].filter((call) => call.active).map((call) => call.app.id);
  }

  private present(prompt: MeetingPrompt): void {
    this.close();
    this.shown = { prompt, handle: this.show(prompt) };
  }

  private close(): void {
    const shown = this.shown;
    this.shown = null;
    shown?.handle.close();
  }
}

/** The notification's words for a prompt. */
export function promptText(
  prompt: MeetingPrompt,
  platform: NodeJS.Platform,
): { title: string; body: string; action: string } {
  // Only macOS shows action buttons; elsewhere clicking the notification is the action.
  const buttons = platform === "darwin";
  if (prompt.kind === "record") {
    const started = prompt.app.browser
      ? `${prompt.app.name} is using your microphone.`
      : `A call in ${prompt.app.name} started.`;
    return {
      title: "Record this meeting?",
      body: buttons ? started : `${started} Click to record it.`,
      action: "Record",
    };
  }
  const ended = `${prompt.app.name} stopped using your microphone.`;
  return {
    title: "Meeting over?",
    body: buttons ? `${ended} The recording is still going.` : `${ended} Click to stop recording.`,
    action: "Stop recording",
  };
}

/** The request the page gets when the person acts on a prompt. */
export function promptRequest(prompt: MeetingPrompt): DesktopMeetingRequest {
  return prompt.kind === "record"
    ? { kind: "record", app: prompt.app.name, title: prompt.app.title }
    : { kind: "stop", app: prompt.app.name };
}

/** The switch, in the app's data folder (`meetings.json`). On unless turned off. */
export class MeetingDetectionStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "meetings.json");
  }

  enabled(): boolean {
    return this.file().detectCalls !== false;
  }

  setEnabled(enabled: boolean): void {
    const value = { ...this.file(), detectCalls: enabled };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private file(): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}

const PROBLEMS: Record<string, string> = {
  sound_server_unavailable:
    "Calls can't be noticed because no sound server (PulseAudio or PipeWire) is running.",
};

export interface MeetingDetectionOptions {
  /** The bundled audio helper, or null when the app has none. */
  helperPath: string | null;
  /** Whether the helper works on this OS version. */
  available: boolean;
  own: OwnApp;
  store: { enabled(): boolean; setEnabled(enabled: boolean): void };
  /** Show a prompt as a notification; `act` runs when the person chooses it. */
  notify(prompt: MeetingPrompt, act: () => void): ShownPrompt;
  /** The person chose a prompt: bring the window up and tell the page. */
  request(request: DesktopMeetingRequest): void;
  onChange(): void;
  log(message: string, error?: unknown): void;
  spawnProcess?: typeof spawn;
  now?: () => number;
}

const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 60_000;

/**
 * Runs the helper's microphone watch while detection is on, feeds the
 * prompter, and restarts the helper (with back-off) if it exits.
 */
export class MeetingDetection {
  private readonly prompter: MeetingPrompter;
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private restart: NodeJS.Timeout | null = null;
  private restartDelay = RESTART_MIN_MS;
  private problem: string | null = null;
  private running = false;
  private readonly recordingPages = new Set<number>();

  constructor(private readonly options: MeetingDetectionOptions) {
    this.prompter = new MeetingPrompter(options.own, (prompt) =>
      options.notify(prompt, () => {
        this.prompter.dismissed(prompt);
        options.request(promptRequest(prompt));
      }),
    );
  }

  status(): DesktopMeetingDetectionStatus {
    return {
      enabled: this.options.store.enabled(),
      available: this.usable(),
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }

  update(change: unknown): DesktopMeetingDetectionStatus {
    const enabled =
      change && typeof change === "object" ? (change as { enabled?: unknown }).enabled : undefined;
    if (typeof enabled === "boolean" && enabled !== this.options.store.enabled()) {
      this.options.store.setEnabled(enabled);
      this.apply();
      this.options.onChange();
    }
    return this.status();
  }

  /** A page started or stopped recording a meeting (or went away: false). */
  setRecording(pageId: number, recording: boolean): void {
    if (recording) this.recordingPages.add(pageId);
    else this.recordingPages.delete(pageId);
    this.prompter.setRecording(this.recordingPages.size > 0, this.now());
  }

  start(): void {
    this.apply();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.restart) clearTimeout(this.restart);
    this.restart = null;
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin?.end();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, 3_000).unref?.();
    }
    this.prompter.observe([], this.now());
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private usable(): boolean {
    return Boolean(this.options.helperPath) && this.options.available;
  }

  private apply(): void {
    const wanted = this.usable() && this.options.store.enabled();
    this.prompter.setEnabled(wanted, this.now());
    if (wanted && !this.running) {
      this.running = true;
      this.spawnHelper();
      this.timer = setInterval(() => this.prompter.evaluate(this.now()), 1_000);
      this.timer.unref?.();
    } else if (!wanted && this.running) {
      this.stop();
    }
  }

  private spawnHelper(): void {
    if (!this.options.helperPath || !this.running) return;
    const spawnProcess = this.options.spawnProcess ?? spawn;
    let child: ChildProcess;
    try {
      child = spawnProcess(this.options.helperPath, ["--watch-microphone"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      this.options.log("Call detection could not start its helper.", error);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => {
      buffered += text;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        const event = line ? parseWatchLine(line) : null;
        if (event) this.receive(event);
      }
    });
    child.on("error", (error) => this.options.log("Call detection helper failed.", error));
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.prompter.observe([], this.now());
      this.scheduleRestart();
    });
  }

  private receive(event: WatchEvent): void {
    if (event.kind === "users") {
      this.restartDelay = RESTART_MIN_MS;
      this.setProblem(null);
      this.prompter.observe(event.users, this.now());
      return;
    }
    this.options.log(`Call detection: ${event.code}: ${event.message}`);
    this.setProblem(PROBLEMS[event.code] ?? "Calls can't be noticed on this computer right now.");
  }

  private scheduleRestart(): void {
    if (!this.running || this.restart) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
    this.restart = setTimeout(() => {
      this.restart = null;
      this.spawnHelper();
    }, delay);
    this.restart.unref?.();
  }

  private setProblem(problem: string | null): void {
    if (problem === this.problem) return;
    this.problem = problem;
    this.options.onChange();
  }
}
