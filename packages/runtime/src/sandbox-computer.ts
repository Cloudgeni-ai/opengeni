// packages/runtime/src/sandbox-computer.ts — the agent computer-use surface (P4.3).
//
// A `Computer` impl backed by xdotool (mouse/keyboard/move/click/type/key) +
// scrot (screenshots), issued through the SAME externally-owned `session` the
// human watches over Channel B. The agent and the human share ONE :0 display —
// zero projection: ffmpeg reads exactly the pixels xdotool draws. Exposed to the
// Agents SDK as a `computerTool` carried by `ComputerUseCapability`, pushed into
// `buildAgentCapabilities` when `computerUseEnabled && desktopCapableBackend`.
//
// This file lives OUTSIDE the @opengeni/runtime/sandbox agent-loop-free leaf
// (it imports `computerTool` from the @openai/agents root, which the leaf forbids)
// and is wired into the agent-loop barrel (packages/runtime/src/index.ts).
//
// ── Adversarial-review fixes folded in (module 05 §Adversarial) ──────────────
//   F1  exec is OPTIONAL on every provider (Modal has only execCommand) — the
//       primitive dual-paths `session.exec ?? session.execCommand`.
//   F2  execCommand returns a FORMATTED STRING with a metadata preamble, not raw
//       stdout — screenshots read the PNG via `session.readFile` (raw bytes) and
//       base64-encode in JS, never parsing the preamble; exit codes come from the
//       established `sandboxCommandExitCode` parser, not a `.exitCode` field.
//   F3  exec/execCommand YIELDS (does not wait) — `sandboxCommandStillRunning` is
//       treated as a retriable failure, and the input commands complete well under
//       the yield window.
//   F4  import paths: `computerTool`/`Computer` from `@openai/agents` (root, via
//       the agents-core star re-export); `Capability`/`requireBoundSession` from
//       `@openai/agents/sandbox`. `Button` is NOT exported — the union is inlined.
//   F5  scroll deltas are model PIXELS (often hundreds) — divided by a notch step
//       and clamped, NOT used as literal wheel-click `--repeat` counts.

import { computerTool, type Computer, type Tool } from "@openai/agents";
import { Capability, type SandboxSessionLike } from "@openai/agents/sandbox";

import { sandboxCommandExitCode, sandboxCommandOutput, sandboxCommandStillRunning } from "./index";

// `requireBoundSession` lives in @openai/agents-core/sandbox/capabilities/base
// but is NOT re-exported from the public @openai/agents/sandbox barrel, so we
// inline the trivial bound-session guard (parity with the SDK's own helper).
function requireBoundSession(capabilityType: string, session?: SandboxSessionLike): SandboxSessionLike {
  if (!session) {
    throw new ComputerUnavailableError(`capability "${capabilityType}" used before bind(session)`);
  }
  return session;
}

// `Button` is intentionally NOT imported (it is not a public export, F4) — the
// union is inlined and kept in lockstep with @openai/agents-core/computer.d.ts.
type ComputerButton = "left" | "right" | "wheel" | "back" | "forward";

const DEFAULT_DISPLAY = ":0";
const DEFAULT_DIMENSIONS: [number, number] = [1280, 800];
// Commands must complete well under this (F3): xdotool/scrot of a 1280x800 PNG is
// sub-second; the wait gives headroom on a cold gVisor box without masking a wedge.
const ACTION_YIELD_MS = 15_000;
// Model scroll deltas are pixels (F5); one wheel "notch" ≈ this many pixels. e2b
// uses a similar divisor. Clamp keeps a runaway delta from spamming the wheel.
const SCROLL_NOTCH_PIXELS = 100;
const SCROLL_MAX_CLICKS = 15;
// screenshot() never hands the model an empty image_url (the SDK turns "" into
// `image_url: ''`, which the model API 400s). A cold/not-yet-painting :0 can yield
// a zero-byte frame on the first scrot; bounded retries with a short pause let a
// momentarily-unpainted-but-live display self-heal before we FAIL LOUD.
const SCREENSHOT_MAX_ATTEMPTS = 3;
const SCREENSHOT_RETRY_DELAY_MS = 400;

export type SandboxComputerOptions = {
  display?: string; // ":0"
  dimensions?: [number, number]; // must match the Xvfb geometry
  runAs?: string; // provider runAs (modal/docker: "sandbox"); undefined otherwise
  typeDelayMs?: number; // xdotool type --delay (default 12ms)
  readOnly?: boolean; // when true, every WRITE action throws ComputerReadOnlyError
  screenshotTmpDir?: string; // "/tmp"
};

// X keysym map for keypress(): model key names → xdotool keysyms.
const KEYSYM: Record<string, string> = {
  ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift",
  cmd: "super", meta: "super", win: "super", super: "super",
  enter: "Return", return: "Return", tab: "Tab", esc: "Escape", escape: "Escape",
  backspace: "BackSpace", delete: "Delete", space: "space",
  up: "Up", down: "Down", left: "Left", right: "Right",
  pageup: "Prior", pagedown: "Next", home: "Home", end: "End",
};
function toKeysym(k: string): string {
  const low = k.toLowerCase();
  if (KEYSYM[low]) return KEYSYM[low];
  if (/^f([1-9]|1[0-2])$/.test(low)) return low.toUpperCase();
  return low.length === 1 ? low : k;
}
const BUTTON_NUM: Record<ComputerButton, number> = { left: 1, wheel: 2, right: 3, back: 8, forward: 9 };

// The structural slice of a provider session computer-use drives. Every field is
// optional because the SDK's SandboxSessionLike leaves exec/execCommand/readFile
// optional (Modal implements execCommand + readFile, not exec — F1).
type ExecResultLike = { output?: string; stdout?: string; stderr?: string; exitCode?: number | null; sessionId?: number };
type ComputerSession = {
  exec?: (args: { cmd: string; runAs?: string; yieldTimeMs?: number; maxOutputTokens?: number }) => Promise<ExecResultLike>;
  execCommand?: (args: { cmd: string; runAs?: string; yieldTimeMs?: number; maxOutputTokens?: number }) => Promise<string>;
  readFile?: (args: { path: string; runAs?: string; maxBytes?: number }) => Promise<string | Uint8Array>;
};

/** No exec/execCommand on the session, or the display is not up. */
export class ComputerUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "ComputerUnavailableError"; }
}
/** A write action attempted while readOnly. */
export class ComputerReadOnlyError extends Error {
  constructor() { super("computer-use is read-only — write actions are disabled"); this.name = "ComputerReadOnlyError"; }
}
/** A nonzero xdotool/scrot exit, OR a command that did not finish before the
 *  yield window (F3 — "still running" is a failure, not a silent success). */
export class ComputerActionError extends Error {
  constructor(public cmd: string, public exitCode: number, public stderr: string) {
    super(`computer action failed (${exitCode}): ${cmd}${stderr ? `\n${stderr}` : ""}`);
    this.name = "ComputerActionError";
  }
}

/**
 * The Computer the agent drives. Every action issues ONE shell line through the
 * externally-owned session (exec ?? execCommand, F1), prefixed with the display.
 * screenshot() does NOT exec scrot-to-base64 (F2 — the execCommand preamble would
 * corrupt the PNG); it scrots to a file and reads the RAW bytes via readFile.
 */
export class SandboxComputer implements Computer {
  readonly environment = "ubuntu" as const;
  readonly dimensions: [number, number];
  private session: ComputerSession;
  private readonly display: string;
  private readonly runAs?: string;
  private readonly typeDelayMs: number;
  private readonly readOnly: boolean;
  private readonly tmp: string;

  constructor(session: SandboxSessionLike, opts: SandboxComputerOptions = {}) {
    this.session = session as unknown as ComputerSession;
    this.display = opts.display ?? DEFAULT_DISPLAY;
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    if (opts.runAs !== undefined) {
      this.runAs = opts.runAs;
    }
    this.typeDelayMs = opts.typeDelayMs ?? 12;
    this.readOnly = opts.readOnly ?? false;
    this.tmp = opts.screenshotTmpDir ?? "/tmp";
  }

  /** Rebind to a freshly resumed-by-id session after a box rollover / re-establish. */
  rebind(session: SandboxSessionLike) { this.session = session as unknown as ComputerSession; }

  // The single command primitive. Dual-paths exec/execCommand (F1), then uses the
  // established string-aware parsers (F2/F3): exitCode from the preamble, and
  // "still running" → a retriable failure. Returns the command OUTPUT body.
  private async x(cmd: string): Promise<string> {
    const args = {
      cmd: `DISPLAY=${this.display} ${cmd}`,
      ...(this.runAs ? { runAs: this.runAs } : {}),
      yieldTimeMs: ACTION_YIELD_MS,
      maxOutputTokens: 4_000,
    };
    let result: ExecResultLike | string;
    if (typeof this.session.exec === "function") {
      result = await this.session.exec(args);
    } else if (typeof this.session.execCommand === "function") {
      result = await this.session.execCommand(args);
    } else {
      throw new ComputerUnavailableError("session cannot run commands (no exec/execCommand)");
    }
    const output = sandboxCommandOutput(result);
    if (sandboxCommandStillRunning(result)) {
      // F3: the command exceeded the yield window — surface, don't treat as success.
      throw new ComputerActionError(cmd, -1, `command did not finish before the yield window:\n${output}`);
    }
    const exitCode = sandboxCommandExitCode(result);
    if (exitCode !== null && exitCode !== 0) {
      throw new ComputerActionError(cmd, exitCode, output);
    }
    return output;
  }

  private guardWrite() {
    if (this.readOnly) throw new ComputerReadOnlyError();
  }
  private shq(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  async screenshot(): Promise<string> {
    // F2: scrot to a file, then read the RAW PNG bytes via readFile and base64 in
    // JS. NEVER `base64 -w0 | execCommand` — the execCommand metadata preamble
    // would prefix the image payload and corrupt the computer_call_result.
    //
    // CRITICAL CONTRACT: this NEVER returns an empty string. The Agents SDK builds
    // the model-facing image as `data:image/png;base64,${output}` — so an empty
    // `output` becomes `image_url: ''`, which the model API rejects with
    // "400 Invalid input[N].output.image_url, expected a valid URL" and kills the
    // turn. An empty/failed frame is therefore a THROW (a clear action failure the
    // SDK surfaces), never a silent "". We also self-heal a transient cold-display
    // frame: bounded retries with a short wait between attempts, so a :0 that is up
    // but momentarily not painting (XFCE/dbus still warming) recovers without
    // failing the turn.
    if (typeof this.session.readFile !== "function") {
      throw new ComputerUnavailableError("session cannot read files (no readFile) — screenshots unavailable");
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < SCREENSHOT_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, SCREENSHOT_RETRY_DELAY_MS));
      }
      const f = `${this.tmp}/og-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
      try {
        await this.x(`scrot --pointer --overwrite ${f}`);
        const data = await this.session.readFile!({
          path: f,
          ...(this.runAs ? { runAs: this.runAs } : {}),
        });
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        if (bytes.length === 0) {
          // A cold/not-yet-painting :0 yields a zero-byte frame. Retry rather than
          // hand the model an empty image_url; throw on the final attempt.
          throw new ComputerUnavailableError("scrot produced an empty screenshot (display not up?)");
        }
        return Buffer.from(bytes).toString("base64");
      } catch (error) {
        lastError = error;
      } finally {
        // Best-effort cleanup on every attempt (success OR failure); never mask the
        // screenshot result.
        await this.x(`rm -f ${f}`).catch(() => undefined);
      }
    }
    // Exhausted retries: FAIL LOUD. A clear throw is the only acceptable outcome —
    // returning "" here would surface to the model as an invalid empty image_url.
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new ComputerUnavailableError("scrot produced an empty screenshot (display not up?)");
  }

  async click(xp: number, yp: number, button: ComputerButton) {
    this.guardWrite();
    await this.x(`xdotool mousemove --sync ${xp} ${yp} click ${BUTTON_NUM[button] ?? 1}`);
  }
  async doubleClick(xp: number, yp: number) {
    this.guardWrite();
    await this.x(`xdotool mousemove --sync ${xp} ${yp} click --repeat 2 --delay 60 1`);
  }
  async move(xp: number, yp: number) {
    this.guardWrite();
    await this.x(`xdotool mousemove --sync ${xp} ${yp}`);
  }
  async scroll(xp: number, yp: number, sx: number, sy: number) {
    this.guardWrite();
    // F5: model deltas are PIXELS — convert to wheel notches, clamp.
    const notches = (px: number): number => Math.min(SCROLL_MAX_CLICKS, Math.max(0, Math.round(Math.abs(px) / SCROLL_NOTCH_PIXELS)));
    const vBtn = sy < 0 ? 4 : 5;
    const hBtn = sx < 0 ? 6 : 7;
    const vN = notches(sy);
    const hN = notches(sx);
    let cmd = `xdotool mousemove --sync ${xp} ${yp}`;
    if (vN) cmd += ` click --repeat ${vN} ${vBtn}`;
    if (hN) cmd += ` click --repeat ${hN} ${hBtn}`;
    await this.x(cmd);
  }
  async type(text: string) {
    this.guardWrite();
    await this.x(`xdotool type --delay ${this.typeDelayMs} -- ${this.shq(text)}`);
  }
  async keypress(keys: string[]) {
    this.guardWrite();
    const combo = keys.map(toKeysym).join("+");
    await this.x(`xdotool key -- ${this.shq(combo)}`);
  }
  async drag(path: [number, number][]) {
    this.guardWrite();
    if (path.length === 0) return;
    const [sx0, sy0] = path[0]!;
    let cmd = `xdotool mousemove --sync ${sx0} ${sy0} mousedown 1`;
    for (const [px, py] of path.slice(1)) cmd += ` mousemove --sync ${px} ${py}`;
    cmd += ` mouseup 1`;
    await this.x(cmd);
  }
  async wait() {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ── The capability (the SDK seam) ────────────────────────────────────────────

export type ComputerUseArgs = {
  dimensions?: [number, number];
  readOnly?: boolean;
  display?: string;
  needsApproval?: boolean | ((ctx: unknown, action: unknown) => boolean | Promise<boolean>);
};

export function computerUse(args: ComputerUseArgs = {}): ComputerUseCapability {
  return new ComputerUseCapability(args);
}

/**
 * A `Capability` subclass merged into the agent's tool set by SandboxAgent
 * (`tools = [...agent.tools, ...capability.tools()]`). `bind(session)` hands it
 * the LIVE externally-owned session, so the agent's actions and the viewers'
 * pixels are one display. `tools()` returns one `computerTool` over a
 * SandboxComputer bound to that session.
 */
export class ComputerUseCapability extends Capability {
  readonly type = "computer-use";
  constructor(private args: ComputerUseArgs = {}) { super(); }

  override tools(): Tool<unknown>[] {
    const session = requireBoundSession("computer-use", this._session);
    const computer = new SandboxComputer(session, {
      ...(this.args.dimensions ? { dimensions: this.args.dimensions } : {}),
      ...(this.args.readOnly !== undefined ? { readOnly: this.args.readOnly } : {}),
      ...(this.args.display ? { display: this.args.display } : {}),
      // The SDK base exposes the bound runAs as a protected field.
      ...(typeof this._runAs === "string" ? { runAs: this._runAs } : {}),
    });
    return [
      computerTool({
        computer,
        ...(this.args.needsApproval !== undefined ? { needsApproval: this.args.needsApproval as never } : {}),
      }) as unknown as Tool<unknown>,
    ];
  }
}
