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
//       stdout — screenshots read the PNG by running `base64 <path>` over the SAME
//       command primitive and stripping the banner (NOT `session.readFile`: Modal's
//       readFile path-validates against the /workspace root and THROWS
//       "Sandbox path /tmp/…png escapes the workspace root", so the /tmp scrot can
//       never be read → empty frame → `image_url: ''` → model 400). This mirrors
//       recording.ts/channel-a fsReadViaExec. Exit codes come from the established
//       `sandboxCommandExitCode` parser, not a `.exitCode` field.
//   F3  exec/execCommand YIELDS (does not wait) — `sandboxCommandStillRunning` is
//       treated as a retriable failure, and the input commands complete well under
//       the yield window.
//   F4  import paths: `computerTool`/`Computer` from `@openai/agents` (root, via
//       the agents-core star re-export); `Capability`/`requireBoundSession` from
//       `@openai/agents/sandbox`. `Button` is NOT exported — the union is inlined.
//   F5  scroll deltas are model PIXELS (often hundreds) — divided by a notch step
//       and clamped, NOT used as literal wheel-click `--repeat` counts.

import { computerTool, tool, type Computer, type Tool } from "@openai/agents";
import { Capability, type SandboxSessionLike } from "@openai/agents/sandbox";
import {
  KeyAction,
  PointerAction,
  PointerButton,
  type DesktopInputRequest,
} from "@opengeni/agent-proto";

import { sandboxCommandExitCode, sandboxCommandOutput, sandboxCommandStillRunning } from "./index";
// `stripExecBanner` is the SAME pure helper recording.ts uses to recover the raw
// command body from Modal's execCommand banner ("…Output:\n<body>"). Imported from
// the agent-loop-free leaf (importing a pure parser FROM the leaf is allowed — the
// leaf boundary only forbids the leaf importing the agent loop, not the reverse).
import { ensureDisplayStack, stripExecBanner } from "./sandbox";

// `requireBoundSession` lives in @openai/agents-core/sandbox/capabilities/base
// but is NOT re-exported from the public @openai/agents/sandbox barrel, so we
// inline the trivial bound-session guard (parity with the SDK's own helper).
function requireBoundSession(
  capabilityType: string,
  session?: SandboxSessionLike,
): SandboxSessionLike {
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
// zero-byte frames for the WHOLE warm-up window of a freshly cold-booted box — Xvfb
// + XFCE + dbus + font-cache under gVisor routinely take 20s+, and the recovery path
// after a machine→sandbox swap ALWAYS hits a stone-cold Modal box on its first turn.
// So we retry across a bounded WALL-CLOCK budget (not a tiny fixed attempt count) with
// a short pause between tries, so that first post-cold / post-swap screenshot self-heals
// as the display warms — then FAIL LOUD once the budget is genuinely spent (a display
// that is dead, not merely warming). ~800ms of retries (the prior 3×400ms) was far too
// short to ride out a cold gVisor XFCE boot, so the turn failed loud on a transient.
const SCREENSHOT_WARMUP_BUDGET_MS = 30_000;
const SCREENSHOT_RETRY_DELAY_MS = 750;
// The screenshot PNG is read back off the box by base64-ing it over the provider's exec
// channel. Modal's exec collects stdout into a BOUNDED buffer that silently EMPTIES a
// single oversized read: a fully-painted 1280x800 desktop PNG (~222 KB) base64s to
// ~296 KB, which trips the cap and returns "" — the blank-frame incident. A partly-
// painted frame (~200 KB base64) slipped under it, which is why this only surfaced once
// the paint gate began delivering FULLY-painted frames. (Channel-A's file read already
// caps its own base64-over-exec output for the same reason; the screenshot read was the
// one large read that didn't bound itself.) We therefore read the file in 3-byte-aligned
// CHUNKS whose per-read base64 (~131 KB) stays well under the cap, then VALIDATE the
// reconstructed byte count against the on-box file size. 98304 = 96 KiB, divisible by 3
// so each chunk's base64 is self-contained (no cross-chunk padding) and concatenating the
// decoded chunks reconstructs the PNG byte-exactly.
const SCREENSHOT_READ_CHUNK_BYTES = 98_304;

export type SandboxComputerOptions = {
  display?: string; // ":0"
  dimensions?: [number, number]; // must match the Xvfb geometry
  runAs?: string; // provider runAs (modal/docker: "sandbox"); undefined otherwise
  typeDelayMs?: number; // xdotool type --delay (default 12ms)
  readOnly?: boolean; // when true, every WRITE action throws ComputerReadOnlyError
  screenshotTmpDir?: string; // "/tmp"
  // How long screenshot() keeps retrying an empty (still-warming) frame before it
  // FAILS LOUD, and the pause between tries. Defaults to the cold-boot warm-up budget;
  // exposed mainly so tests can shrink it (a real caller wants the full budget).
  screenshotWarmupBudgetMs?: number;
  screenshotRetryDelayMs?: number;
  /**
   * One turn-scoped preparation hook, invoked by the first real computer action.
   * The agent may advertise computer-use on every turn, but merely advertising the
   * tool must not boot Xvfb/XFCE or start a recording. The runtime capability owns
   * this hook and uses it to bring up :0 (and optionally notify the worker) only
   * after the model actually chooses a computer tool.
   */
  prepare?: (session: SandboxSessionLike) => Promise<void>;
};

// X keysym map for keypress(): model key names → xdotool keysyms.
const KEYSYM: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "super",
  meta: "super",
  win: "super",
  super: "super",
  enter: "Return",
  return: "Return",
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  space: "space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "Prior",
  pagedown: "Next",
  home: "Home",
  end: "End",
};
function toKeysym(k: string): string {
  const low = k.toLowerCase();
  if (KEYSYM[low]) return KEYSYM[low];
  if (/^f([1-9]|1[0-2])$/.test(low)) return low.toUpperCase();
  return low.length === 1 ? low : k;
}
const BUTTON_NUM: Record<ComputerButton, number> = {
  left: 1,
  wheel: 2,
  right: 3,
  back: 8,
  forward: 9,
};

// The structural slice of a provider session computer-use drives. exec and
// execCommand are optional because the SDK's SandboxSessionLike leaves them
// optional (Modal implements execCommand, not exec — F1). readFile is intentionally
// NOT in this type: screenshots read the /tmp PNG via `base64 <path>` over
// exec/execCommand (readFile path-validates against /workspace and rejects /tmp).
type ExecResultLike = {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  sessionId?: number;
};
type ComputerSession = {
  // A native provider exec returns a structured `ExecResultLike`; the routing proxy
  // fronting a Modal box returns the execCommand banner STRING. Both are handled.
  exec?: (args: {
    cmd: string;
    runAs?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<ExecResultLike | string>;
  execCommand?: (args: {
    cmd: string;
    runAs?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<string>;
};

/** No exec/execCommand on the session, or the display is not up. */
export class ComputerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerUnavailableError";
  }
}
/** The screenshot file read back SHORT of its on-box byte size — a chunk was truncated
 *  by the provider's exec-output cap. This is deterministic, NOT a warm-up transient, so
 *  it fails LOUD immediately with the byte counts (never a silent blank the model would
 *  read as a real empty screen) and is not retried. */
export class ScreenshotReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenshotReadError";
  }
}
/** A write action attempted while readOnly. */
export class ComputerReadOnlyError extends Error {
  constructor() {
    super("computer-use is read-only — write actions are disabled");
    this.name = "ComputerReadOnlyError";
  }
}
/** A nonzero xdotool/scrot exit, OR a command that did not finish before the
 *  yield window (F3 — "still running" is a failure, not a silent success). */
export class ComputerActionError extends Error {
  constructor(
    public cmd: string,
    public exitCode: number,
    public stderr: string,
  ) {
    super(`computer action failed (${exitCode}): ${cmd}${stderr ? `\n${stderr}` : ""}`);
    this.name = "ComputerActionError";
  }
}

/**
 * The Computer the agent drives. Every action issues ONE shell line through the
 * externally-owned session (exec ?? execCommand, F1), prefixed with the display.
 * screenshot() scrots to a /tmp file and reads the RAW bytes by running
 * `base64 <path>` over the SAME command primitive and stripping the banner — NOT
 * `session.readFile` (Modal's readFile path-validates against /workspace and rejects
 * /tmp with "escapes the workspace root", which would yield an empty frame and 400
 * the model). The base64-over-exec path is /tmp-readable and binary-safe.
 */
export class SandboxComputer implements Computer {
  readonly environment = "ubuntu" as const;
  readonly dimensions: [number, number];
  private session: ComputerSession & SandboxSessionLike;
  private readonly display: string;
  private readonly runAs?: string;
  private readonly typeDelayMs: number;
  private readonly readOnly: boolean;
  private readonly tmp: string;
  private readonly screenshotWarmupBudgetMs: number;
  private readonly screenshotRetryDelayMs: number;
  private readonly prepare: ((session: SandboxSessionLike) => Promise<void>) | undefined;
  private prepared = false;
  private preparation: Promise<void> | null = null;

  constructor(session: SandboxSessionLike, opts: SandboxComputerOptions = {}) {
    this.session = session as ComputerSession & SandboxSessionLike;
    this.display = opts.display ?? DEFAULT_DISPLAY;
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    if (opts.runAs !== undefined) {
      this.runAs = opts.runAs;
    }
    this.typeDelayMs = opts.typeDelayMs ?? 12;
    this.readOnly = opts.readOnly ?? false;
    this.tmp = opts.screenshotTmpDir ?? "/tmp";
    this.screenshotWarmupBudgetMs = opts.screenshotWarmupBudgetMs ?? SCREENSHOT_WARMUP_BUDGET_MS;
    this.screenshotRetryDelayMs = opts.screenshotRetryDelayMs ?? SCREENSHOT_RETRY_DELAY_MS;
    this.prepare = opts.prepare;
  }

  /** Rebind to a freshly resumed-by-id session after a box rollover / re-establish. */
  rebind(session: SandboxSessionLike) {
    this.session = session as ComputerSession & SandboxSessionLike;
    this.prepared = false;
    this.preparation = null;
  }

  private async prepareOnce(): Promise<void> {
    if (this.prepared) return;
    if (!this.prepare) {
      // No lazy hook means the caller handed us an already-ready display, which
      // is the historical direct-construction behavior used by embedders/tests.
      this.prepared = true;
      return;
    }
    this.preparation ??= this.prepare(this.session);
    try {
      await this.preparation;
      this.prepared = true;
    } catch (error) {
      // A viewer may have contended the display flock or a provider operation may
      // have failed transiently. Let a later computer call retry; never cache a
      // rejected preparation as the permanent state of the turn.
      this.preparation = null;
      throw error;
    }
  }

  // The single command primitive. Dual-paths exec/execCommand (F1), then uses the
  // established string-aware parsers (F2/F3): exitCode from the preamble, and
  // "still running" → a retriable failure. Returns the command OUTPUT body.
  private async x(cmd: string): Promise<string> {
    await this.prepareOnce();
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
      // F3: the command exceeded the yield window. WARN AND RETURN rather than
      // throw. Throwing here causes the SDK's catch in `_runComputerActionAndScreenshot`
      // to set output='' and build `{image_url:""}` → Azure 400. By returning
      // instead, the SDK proceeds past the action loop and calls computer.screenshot()
      // so the model gets the REAL current frame for its next step.
      //
      // screenshot()'s FAIL-LOUD + retry contract is preserved: if scrot itself
      // times out (very unlikely at 15 s), x() returns here, readScreenshotBytes
      // produces empty bytes, and the retry loop eventually throws. The wire-level
      // backstop in computerCallNormalizingFetch is also in place as a second net.
      console.warn(
        `[SandboxComputer] action command did not finish before the ${ACTION_YIELD_MS}ms yield window — proceeding to screenshot: ${cmd}`,
      );
      return output;
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
    // F2: scrot to a /tmp file, then read the RAW PNG bytes by running `base64
    // <path>` over the SAME command primitive (exec ?? execCommand) and stripping
    // the banner — NOT `session.readFile`. On Modal, readFile path-validates the
    // path against the /workspace root and THROWS for /tmp ("Sandbox path
    // /tmp/og-shot-*.png escapes the workspace root"), so the scrot could never be
    // read → empty frame → `image_url: ''` → the model 400s. The base64-over-exec
    // mechanism (mirroring Channel A's bounded file reads
    // fsReadViaExec) is /tmp-readable and binary-safe. We do NOT use execCommand's
    // body via the `this.x()` parser — that drops the execCommand string body; the
    // banner is stripped explicitly here so the base64 payload survives intact.
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
    let lastError: unknown;
    const deadline = Date.now() + this.screenshotWarmupBudgetMs;
    let attempt = 0;
    // Retry across a WALL-CLOCK budget (not a fixed count): a stone-cold box on the
    // first post-swap / post-cold turn can take 20s+ to paint, and a zero-byte frame
    // is a KNOWN transient during that warm-up — not a reason to fail the turn.
    while (true) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, this.screenshotRetryDelayMs));
      }
      attempt++;
      const f = `${this.tmp}/og-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
      try {
        await this.x(`scrot --pointer --overwrite ${f}`);
        const bytes = await this.readScreenshotBytes(f);
        if (bytes.length === 0) {
          // A cold/not-yet-painting :0 yields a zero-byte frame. Retry rather than
          // hand the model an empty image_url; throw once the budget is spent.
          throw new ComputerUnavailableError(
            "scrot produced an empty screenshot (display not up?)",
          );
        }
        return Buffer.from(bytes).toString("base64");
      } catch (error) {
        lastError = error;
        // A short/truncated read is deterministic (the exec-output cap), not a warm-up
        // transient — retrying only burns the budget and delays a legible failure. Fail
        // loud NOW (the `finally` still cleans up the temp file).
        if (error instanceof ScreenshotReadError) {
          throw error;
        }
      } finally {
        // Best-effort cleanup on every attempt (success OR failure); never mask the
        // screenshot result.
        // If preparation itself failed, scrot never ran and no file exists. Do
        // not route cleanup through x(), because that would retry the expensive
        // display preparation merely to delete a nonexistent path.
        if (this.prepared) {
          await this.x(`rm -f ${f}`).catch(() => undefined);
        }
      }
      // Stop once the warm-up budget is spent — the NEXT sleep would push us past it.
      if (Date.now() + this.screenshotRetryDelayMs >= deadline) {
        break;
      }
    }
    // Exhausted the warm-up budget: FAIL LOUD. A clear throw is the only acceptable
    // outcome — returning "" here would surface to the model as an invalid empty
    // image_url. Reaching here means the display was still dead after ~30s, not merely
    // warming, so a hard action failure is correct.
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new ComputerUnavailableError("scrot produced an empty screenshot (display not up?)");
  }

  // Run a read-only command over the SAME command primitive computer actions use
  // (exec ?? execCommand) and return its RAW stdout body — NOT `session.readFile` (Modal
  // path-validates against /workspace and rejects /tmp) and NOT `this.x()` (its
  // `sandboxCommandOutput` parser drops the execCommand STRING body). exec exposes a
  // structured stdout; execCommand returns the formatted STRING, so we strip its banner
  // ("…Output:\n<body>") to recover the body.
  //
  // ROUTING-PROXY SEAM: when the selfhosted feature is on, the turn's box is wrapped in a
  // `RoutingSandboxSession`, which ALWAYS exposes an `exec` method — but for a Modal-backed
  // box (no native `exec`) that method internally falls back to `execCommand` and returns
  // the formatted STRING, not a `{output}` object. `sandboxCommandOutput` returns "" for a
  // string, so a naive `sandboxCommandOutput(await session.exec())` silently dropped the
  // whole screenshot body → empty read → "display not up" error card on EVERY Modal
  // computer-use turn once routing was enabled. So a STRING exec result is banner-stripped
  // exactly like the direct execCommand path; only a structured object goes to
  // sandboxCommandOutput.
  private async readCmdRaw(cmd: string): Promise<string> {
    const args = {
      cmd,
      ...(this.runAs ? { runAs: this.runAs } : {}),
      yieldTimeMs: ACTION_YIELD_MS,
      // null disables the provider's TOKEN truncation; the byte cap this method chunks
      // around is a separate, lower-level exec-stdout buffer limit.
      maxOutputTokens: null as unknown as number,
    };
    if (typeof this.session.exec === "function") {
      const result = await this.session.exec(args);
      // A routing proxy fronting a Modal box returns the execCommand banner STRING;
      // a native structured exec returns an object. Handle both so neither silently
      // yields an empty body.
      return typeof result === "string" ? stripExecBanner(result) : sandboxCommandOutput(result);
    }
    if (typeof this.session.execCommand === "function") {
      return stripExecBanner(await this.session.execCommand(args));
    }
    throw new ComputerUnavailableError(
      "session cannot run commands (no exec/execCommand) — screenshots unavailable",
    );
  }

  // Read the screenshot PNG bytes off the box. A SINGLE `base64 <file>` over Modal's
  // exec silently returns "" once the base64 exceeds the exec-stdout buffer cap (a full
  // desktop ~296 KB base64 trips it — the blank-frame incident). So we size the file
  // first, then base64 it in SCREENSHOT_READ_CHUNK_BYTES-sized, 3-byte-aligned chunks
  // (each read's base64 stays well under the cap) and reconstruct — validating the total
  // against the on-box size and failing LOUD on any short read rather than handing back a
  // truncated/blank frame. Binary-safe: base64 is plain ASCII over stdout.
  private async readScreenshotBytes(path: string): Promise<Uint8Array> {
    // On-box byte size (tiny output — always safe). A still-warming :0 can yield a
    // zero-byte scrot file; report empty so the caller retries within its warm-up budget.
    const sizeRaw = (await this.readCmdRaw(`wc -c < ${path} 2>/dev/null`)).replace(/[^0-9]/g, "");
    const fileSize = Number.parseInt(sizeRaw, 10);
    if (!Number.isFinite(fileSize) || fileSize <= 0) return new Uint8Array();

    const chunks: Buffer[] = [];
    const nChunks = Math.ceil(fileSize / SCREENSHOT_READ_CHUNK_BYTES);
    for (let i = 0; i < nChunks; i++) {
      // `dd bs=CHUNK skip=i count=1` reads bytes [i*CHUNK, (i+1)*CHUNK); CHUNK % 3 == 0
      // so each chunk's base64 is self-contained and decoded chunks concatenate exactly.
      const raw = await this.readCmdRaw(
        `dd if=${path} bs=${SCREENSHOT_READ_CHUNK_BYTES} skip=${i} count=1 2>/dev/null | base64`,
      );
      chunks.push(Buffer.from(raw.replace(/\s+/g, ""), "base64"));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== fileSize) {
      throw new ScreenshotReadError(
        `screenshot read reconstructed ${bytes.length}B of ${fileSize}B (${nChunks} chunk(s), path=${path}) — a chunk was truncated by the exec-output cap; frame incomplete`,
      );
    }
    return new Uint8Array(bytes);
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
    const notches = (px: number): number =>
      Math.min(SCROLL_MAX_CLICKS, Math.max(0, Math.round(Math.abs(px) / SCROLL_NOTCH_PIXELS)));
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

// ── The native-desktop computer (self-hosted / macOS) ────────────────────────
//
// `SandboxComputer` drives the desktop by shelling out to xdotool/scrot over the
// session's `exec` — which needs those X utilities installed in the box image and
// only works under X11. A SELF-HOSTED machine (macOS OR bring-your-own Linux) has
// neither guarantee, so it drives the desktop NATIVELY over the control plane: the
// Rust agent injects input via CGEvent (macOS) / XTEST (Linux) and captures via
// ScreenCaptureKit / x11, exposed as the two `SelfhostedSession` ops below. No
// xdotool/scrot dependency; works on macOS.

/** The structural slice of a self-hosted session the native computer drives — the
 *  two control-plane ops added in session.ts. Kept structural (NOT an import of
 *  `SelfhostedSession`) so this agent-loop file never hard-couples to the sandbox
 *  leaf; the duck-typed `isNativeDesktopSession` probe (below) selects on it. */
export type NativeDesktopSession = {
  desktopInput(event: DesktopInputRequest["event"]): Promise<void>;
  // `nativeWidth`/`nativeHeight` are the PRE-DOWNSCALE capture geometry (equal to
  // width/height when the agent did not have to shrink the PNG to fit the transport
  // budget). NativeDesktopComputer scales model clicks from the ENCODED pixel space
  // back to native pixels using their ratio before injecting.
  screenshot(): Promise<{
    png: Uint8Array;
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
  }>;
};

/** Model `Button` → wire `PointerButton`. The proto has no back/forward button, so
 *  those degrade to UNSPECIFIED (the agent ignores an unmapped button rather than
 *  mis-clicking). A total record so indexing is exhaustive. */
const POINTER_BUTTON: Record<ComputerButton, PointerButton> = {
  left: PointerButton.POINTER_BUTTON_LEFT,
  right: PointerButton.POINTER_BUTTON_RIGHT,
  wheel: PointerButton.POINTER_BUTTON_MIDDLE,
  back: PointerButton.POINTER_BUTTON_UNSPECIFIED,
  forward: PointerButton.POINTER_BUTTON_UNSPECIFIED,
};

// Native capture (ScreenCaptureKit / x11) can hand back a null/empty FIRST frame in
// the moments right after the agent connects — the capture stream still warming — the
// same class of transient the scrot path retries around for a cold :0. Native capture
// is normally sub-second, so the warm-up budget is much shorter than the scrot path's
// 30 s cold-Modal-box budget; enough to ride a first-frame miss, not enough to hang a
// turn on a genuinely dead capture. A TERMINAL failure (permission denied) short-
// circuits the budget and fails immediately.
const NATIVE_SCREENSHOT_WARMUP_BUDGET_MS = 6_000;
const NATIVE_SCREENSHOT_RETRY_DELAY_MS = 400;

export type NativeDesktopComputerOptions = {
  dimensions?: [number, number]; // the display geometry (must match the capture size)
  environment?: NonNullable<Computer["environment"]>; // "ubuntu" (default) | "mac" | ...; model uses it for OS key conventions
  readOnly?: boolean; // when true, every WRITE action throws ComputerReadOnlyError
  screenshotWarmupBudgetMs?: number; // wall-clock budget to retry a warming/empty first frame
  screenshotRetryDelayMs?: number; // delay between warm-up retries
};

/** A capture failure that RETRYING cannot cure — Screen Recording (TCC) has not been
 *  granted to the agent, so every capture will deny until the user grants it. We fail
 *  FAST on this rather than burn the warm-up budget, and surface the reason verbatim so
 *  the operator sees "grant Screen Recording", not a blank screen. Matches the agent's
 *  `capture_rgba` denial strings ("Screen Recording permission is not granted",
 *  "no shareable content (Screen Recording denied?)"). */
function isTerminalCaptureDenial(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return (
    msg.includes("screen recording") ||
    msg.includes("permission is not granted") ||
    msg.includes("consent")
  );
}

/**
 * A `Computer` that drives a SELF-HOSTED machine's OWN desktop NATIVELY over the
 * control plane (`desktopInput` inject + `screenshot` capture on the bound
 * `SelfhostedSession`) instead of xdotool/scrot over `exec`. Consent + epoch are
 * enforced AGENT-side, so an unconsented inject surfaces the session's mapped
 * control error.
 *
 * screenshot() returns raw base64 with NO data-URL prefix — the EXACT contract of
 * `SandboxComputer.screenshot`: the Agents SDK wraps it as
 * `data:image/png;base64,${output}`, so an empty string would become
 * `image_url: ''` and 400 the model turn. An empty PNG therefore THROWS
 * `ComputerUnavailableError` (mirroring SandboxComputer's empty-guard) — the model
 * never receives an empty image_url.
 */
export class NativeDesktopComputer implements Computer {
  readonly environment: NonNullable<Computer["environment"]>;
  readonly dimensions: [number, number];
  private session: NativeDesktopSession;
  private readonly readOnly: boolean;
  private readonly screenshotWarmupBudgetMs: number;
  private readonly screenshotRetryDelayMs: number;
  // The ENCODED vs NATIVE geometry of the MOST RECENT screenshot the model saw. The
  // model computes click coordinates in the encoded-pixel space of that screenshot;
  // when the agent downscaled the PNG to fit the transport budget, encoded < native,
  // so we scale coordinates back up to native pixels before injecting (the agent's
  // native inject — macOS CGEvent / Linux XTEST — expects native-pixel coordinates,
  // exactly as it received them pre-downscale). Null until the first screenshot;
  // equal encoded==native (or absent) ⇒ scale factor 1.0 ⇒ byte-identical behavior.
  private lastEncoded: [number, number] | null = null;
  private lastNative: [number, number] | null = null;

  constructor(session: NativeDesktopSession, opts: NativeDesktopComputerOptions = {}) {
    this.session = session;
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    // Default "ubuntu" (self-hosted Linux is the near-term target); a macOS session
    // should pass "mac" so the model uses ⌘-based shortcuts — see the coordinate TODO.
    this.environment = opts.environment ?? "ubuntu";
    this.readOnly = opts.readOnly ?? false;
    this.screenshotWarmupBudgetMs =
      opts.screenshotWarmupBudgetMs ?? NATIVE_SCREENSHOT_WARMUP_BUDGET_MS;
    this.screenshotRetryDelayMs = opts.screenshotRetryDelayMs ?? NATIVE_SCREENSHOT_RETRY_DELAY_MS;
  }

  /** Rebind to a freshly resumed-by-id session after a box rollover / re-establish. */
  rebind(session: NativeDesktopSession) {
    this.session = session;
  }

  private guardWrite() {
    if (this.readOnly) throw new ComputerReadOnlyError();
  }

  /** Scale a coordinate the model expressed in the MOST RECENT screenshot's
   *  ENCODED pixel space back to NATIVE pixels. When the last frame was not
   *  downscaled (encoded == native), or no screenshot has been taken yet, this is a
   *  1:1 identity — the byte-identical current behavior. The agent then applies its
   *  own platform mapping (macOS divides native pixels by the backing scale to reach
   *  CGEvent points; Linux XTEST is 1:1) exactly as it did pre-downscale. */
  private toNative(x: number, y: number): { x: number; y: number } {
    const enc = this.lastEncoded;
    const nat = this.lastNative;
    if (!enc || !nat || enc[0] <= 0 || enc[1] <= 0) return { x, y };
    if (enc[0] === nat[0] && enc[1] === nat[1]) return { x, y };
    return {
      x: Math.round((x * nat[0]) / enc[0]),
      y: Math.round((y * nat[1]) / enc[1]),
    };
  }

  private async pointer(
    x: number,
    y: number,
    action: PointerAction,
    button: PointerButton,
  ): Promise<void> {
    // COORDINATE SEAM: the model computes x/y against the pixels of the screenshot it
    // just saw — which the agent may have DOWNSCALED to fit the transport's max
    // payload (a full-res Retina/busy screen exceeds NATS's 1 MiB default). We scale
    // those encoded-pixel coordinates back to native pixels here, using the native
    // geometry the last screenshot reported, so the agent's native inject lands the
    // click where the model intended. When no downscale occurred the factor is 1.0
    // and the coordinates pass through unchanged. Self-hosted Linux (XTEST/x11) and
    // any non-downscaled frame are 1:1 and unaffected.
    const n = this.toNative(x, y);
    await this.session.desktopInput({
      $case: "pointer",
      pointer: { x: n.x, y: n.y, action, button },
    });
  }

  async screenshot(): Promise<string> {
    // CRITICAL CONTRACT (mirrors SandboxComputer.screenshot): NEVER return "". The
    // Agents SDK builds the model image as `data:image/png;base64,${output}`; an
    // empty output → `image_url: ''`. On the hosted computer_use_preview path the SDK
    // catches a throw here, sets output='', and the wire-seam sanitizer rewrites the
    // empty image_url to a BLANK 1×1 placeholder to dodge a 400 — so a capture MISS
    // silently reaches the model as a "blank desktop" it then confidently reports.
    //
    // Native capture (ScreenCaptureKit / x11) can hand back a null/empty FIRST frame
    // in the moments right after the agent connects (the capture stream warming) — the
    // same transient the scrot path retries around for a cold :0. This path previously
    // did a SINGLE capture, so one warm-up miss became a blank. We now RETRY across a
    // bounded budget and, on a terminal failure, FAIL LOUD with the agent's actual
    // reason (logged) — never a silent blank. A permission (TCC) denial is terminal:
    // retrying cannot grant Screen Recording, so we break immediately.
    let lastError: unknown;
    const deadline = Date.now() + this.screenshotWarmupBudgetMs;
    let attempt = 0;
    while (true) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, this.screenshotRetryDelayMs));
      }
      attempt++;
      try {
        const { png, width, height, nativeWidth, nativeHeight } = await this.session.screenshot();
        if (png.length === 0) {
          // A warming capture yields an empty frame — retry rather than hand the model
          // a blank; throw once the budget is spent.
          throw new ComputerUnavailableError(
            "native desktop screenshot returned an empty frame (display not up?)",
          );
        }
        // Record the encoded (what the model sees) vs native geometry of THIS frame so
        // the next click/move/scroll/drag scales its coordinates back to native pixels.
        this.lastEncoded = [width, height];
        this.lastNative = [nativeWidth || width, nativeHeight || height];
        return Buffer.from(png).toString("base64");
      } catch (error) {
        lastError = error;
        // A permission denial will deny on every retry — fail fast with the reason.
        if (isTerminalCaptureDenial(error)) break;
      }
      // Stop once the warm-up budget is spent — the NEXT sleep would push us past it.
      if (Date.now() + this.screenshotRetryDelayMs >= deadline) {
        break;
      }
    }
    // Exhausted the budget (or hit a terminal denial): FAIL LOUD. Log the specific
    // reason so the failure is DIAGNOSABLE (not a silent blank the model misreads),
    // then rethrow — never return "".
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    console.warn(
      `[NativeDesktopComputer] screenshot failed after ${attempt} attempt(s): ${reason}`,
    );
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new ComputerUnavailableError(
      "native desktop screenshot returned an empty frame (display not up?)",
    );
  }

  async click(x: number, y: number, button: ComputerButton) {
    this.guardWrite();
    await this.pointer(
      x,
      y,
      PointerAction.POINTER_ACTION_CLICK,
      POINTER_BUTTON[button] ?? PointerButton.POINTER_BUTTON_LEFT,
    );
  }
  async doubleClick(x: number, y: number) {
    this.guardWrite();
    await this.pointer(
      x,
      y,
      PointerAction.POINTER_ACTION_DOUBLE_CLICK,
      PointerButton.POINTER_BUTTON_LEFT,
    );
  }
  async move(x: number, y: number) {
    this.guardWrite();
    await this.pointer(
      x,
      y,
      PointerAction.POINTER_ACTION_MOVE,
      PointerButton.POINTER_BUTTON_UNSPECIFIED,
    );
  }
  async scroll(x: number, y: number, sx: number, sy: number) {
    this.guardWrite();
    // The scroll ANCHOR (x,y) is a screenshot-pixel position → scale to native like a
    // click. The deltas (sx,sy) are relative scroll AMOUNTS, not positions; the agent
    // owns the platform-appropriate wheel translation, so they pass through unscaled
    // (no xdotool "notch" quantization here — that is an xdotool-specific artifact).
    const n = this.toNative(x, y);
    await this.session.desktopInput({
      $case: "scroll",
      scroll: { x: n.x, y: n.y, deltaX: sx, deltaY: sy },
    });
  }
  async type(text: string) {
    this.guardWrite();
    // A literal text burst: isText:true tells the agent to type the string verbatim
    // (Unicode-aware) rather than interpret it as a key name.
    await this.session.desktopInput({
      $case: "key",
      key: { key: text, isText: true, action: KeyAction.KEY_ACTION_PRESS },
    });
  }
  async keypress(keys: string[]) {
    this.guardWrite();
    // A chord ("ctrl+c") as ONE non-text KeyEvent (isText:false ⇒ interpret as key
    // names). We send the model's PLATFORM-INDEPENDENT key names joined with "+" —
    // NOT xdotool X keysyms (SandboxComputer's toKeysym maps to "Return"/"super"/
    // "Prior", which are X-specific and wrong for the macOS CGEvent path). The agent
    // owns the per-platform key-name → keycode mapping (the KeyEvent.key contract).
    await this.session.desktopInput({
      $case: "key",
      key: { key: keys.join("+"), isText: false, action: KeyAction.KEY_ACTION_PRESS },
    });
  }
  async drag(path: [number, number][]) {
    this.guardWrite();
    if (path.length === 0) return;
    // Press at the start, move through each waypoint with the button held, release at
    // the last point. The agent tracks button state across the DOWN → MOVE… → UP.
    const [sx, sy] = path[0]!;
    await this.pointer(
      sx,
      sy,
      PointerAction.POINTER_ACTION_DOWN,
      PointerButton.POINTER_BUTTON_LEFT,
    );
    for (const [px, py] of path.slice(1)) {
      await this.pointer(
        px,
        py,
        PointerAction.POINTER_ACTION_MOVE,
        PointerButton.POINTER_BUTTON_LEFT,
      );
    }
    const [ex, ey] = path[path.length - 1]!;
    await this.pointer(ex, ey, PointerAction.POINTER_ACTION_UP, PointerButton.POINTER_BUTTON_LEFT);
  }
  async wait() {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Backend-aware SELECTION discriminator: a SELF-HOSTED session exposes the two
 * native control-plane ops (`desktopInput` + `screenshot`); a MODAL session does
 * not (it drives the desktop via xdotool/scrot over `exec`). Duck-typing on those
 * two methods keeps this file from hard-importing `SelfhostedSession` (avoiding an
 * agent-loop ↔ sandbox-leaf import coupling) and is future-proof: any backend that
 * grows native inject/capture is picked up automatically.
 */
export function isNativeDesktopSession(
  session: SandboxSessionLike,
): session is SandboxSessionLike & NativeDesktopSession {
  const s = session as Partial<NativeDesktopSession>;
  return typeof s.desktopInput === "function" && typeof s.screenshot === "function";
}

// ── Function-transport (codex / text backend) computer tools ─────────────────
//
// The SDK emits computer-use ONLY as the HOSTED `computer_use_preview` tool, which
// the codex / ChatGPT backend rejects (it accepts only function/custom/web_search
// tool types) — so on codex the hosted tool is unusable and the agent has nothing
// to drive the desktop with. We mirror EXACTLY how the SDK's filesystem capability
// degrades `view_image` for the text transport: when the bound model does NOT
// support the structured tool-output transport, emit a set of FUNCTION tools that
// route to the SAME bound `Computer`, and hand the model the screen by rendering
// the screenshot image-output as a text-transport data URL — the identical two-step
// `imageOutputFromBytes` → `renderImageForTextTransport` the SDK's text `view_image`
// uses. Those three helpers are NOT public exports of `@openai/agents` /
// `@openai/agents/sandbox` (they live in the SDK's private capabilities/transport +
// shared/media modules, unreachable via the package `exports` map), so — mirroring
// selfhosted/session.ts's local `sniffImageMediaType` — the three tiny pure helpers
// are reimplemented here in lockstep with the SDK.

/** The SDK's tool-output image shape (@openai/agents-core shared/media `ToolOutputImage`). */
type ToolOutputImage = { type: "image"; image: { data: Uint8Array; mediaType: string } };

/** Magic-byte image sniff, in lockstep with the SDK's `sniffImageMediaType`
 *  (shared/media). Screenshots are always PNG (scrot / ScreenCaptureKit / x11), so
 *  an unrecognized header defaults to image/png rather than failing the frame. */
function sniffScreenshotMediaType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
    return "image/gif";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return "image/png";
}

/** Build the SDK `ToolOutputImage` from raw screenshot bytes — the structured shape
 *  the SDK's `imageOutputFromBytes` produces (`{type:'image', image:{data,mediaType}}`). */
function imageOutputFromScreenshotBytes(bytes: Uint8Array): ToolOutputImage {
  return {
    type: "image",
    image: { data: Uint8Array.from(bytes), mediaType: sniffScreenshotMediaType(bytes) },
  };
}

/** Render an image tool-output as a text-transport string, in lockstep with the
 *  SDK's private `renderImageForTextTransport` (capabilities/filesystem). Our image
 *  output always carries `data` as bytes, so it becomes a `data:<mediaType>;base64,…`
 *  URL — the exact form the text-backend `view_image` hands the model. */
function renderImageForTextTransport(output: ToolOutputImage | string): string {
  if (typeof output === "string") return output;
  const { image } = output;
  const mediaType =
    typeof image.mediaType === "string" ? image.mediaType : "application/octet-stream";
  return `data:${mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}

/** Whether the bound model supports the structured tool-output transport, in
 *  lockstep with the SDK's private `supportsStructuredToolOutputTransport`
 *  (capabilities/transport): a ChatCompletions-family model — and an UNBOUND model
 *  (undefined) — does NOT, so it gets the function tools; every other model keeps
 *  the hosted `computer_use_preview` tool. The codex neutralize trick in index.ts
 *  drops `_modelInstance`, so this returns false there and the function tools win. */
function supportsStructuredToolOutputTransport(modelInstance: unknown): boolean {
  if (!modelInstance) return false;
  const constructorName =
    typeof modelInstance === "object" &&
    modelInstance &&
    typeof (modelInstance as { constructor?: unknown }).constructor === "function"
      ? ((modelInstance as { constructor: { name?: string } }).constructor.name ?? "")
      : "";
  return !constructorName.includes("ChatCompletions");
}

const COMPUTER_READ_ONLY_MESSAGE =
  "computer-use is read-only for this session — click, double_click, move, scroll, type, keypress, and drag are disabled. Call computer_screenshot to observe the desktop.";

// The two coordinate properties every pointer tool shares. Raw JSON schema (NOT
// zod: zod is not a @opengeni/runtime dependency) with `strict:false`, mirroring the
// SDK's own `apply_patch` function-tool schema style.
const COORD_PROPS = {
  x: {
    type: "integer",
    description: "X coordinate in the pixels of the most recent computer_screenshot",
  },
  y: {
    type: "integer",
    description: "Y coordinate in the pixels of the most recent computer_screenshot",
  },
} as const;

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * The FUNCTION-transport computer tools for the codex / text backend, each routing
 * to the SAME bound `Computer` the hosted `computer_use_preview` tool would drive.
 * `computer_screenshot` hands the model the desktop two ways, selected by
 * `imageFunctionResults`:
 *   • false (chat-completions providers, the default) → the text-transport
 *     `data:image/png;base64,…` URL (imageOutputFromBytes → renderImageForTextTransport,
 *     the SDK's text `view_image` path) — those backends can't read structured image
 *     tool results.
 *   • true (the codex/ChatGPT backend) → the structured `{type:'image'}` tool output,
 *     which agents-core normalizes into an `input_image` content item inside the
 *     function_call_output — the codex /responses backend accepts and SEES it (a text
 *     data-URL there is just unreadable text). See index.ts for why it's on there.
 * Write tools return a concise confirmation; when read-only they return
 * {@link COMPUTER_READ_ONLY_MESSAGE} instead of throwing, and any action error is
 * returned as a string so a failed action never kills the turn. Exported so it can be
 * unit-tested against a fake `Computer`.
 */
export function computerFunctionTools(
  computer: Computer,
  readOnly: boolean,
  needsApproval?: ComputerUseArgs["needsApproval"],
  imageFunctionResults = false,
): Tool<unknown>[] {
  const approval = needsApproval !== undefined ? { needsApproval: needsApproval as never } : {};
  // Perform a WRITE action, surfacing read-only / failures as a model-readable
  // string rather than an uncaught throw (an uncaught throw becomes a tool error
  // the backend may 400 on, or kills the step).
  const write = async (
    confirmation: string,
    action: () => void | Promise<void>,
  ): Promise<string> => {
    if (readOnly) return COMPUTER_READ_ONLY_MESSAGE;
    try {
      await action();
      return confirmation;
    } catch (error) {
      if (error instanceof ComputerReadOnlyError) return COMPUTER_READ_ONLY_MESSAGE;
      return `computer action failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  return [
    tool({
      name: "computer_screenshot",
      description:
        "Capture the current desktop and return it as an image. Call this FIRST and again after each action — all coordinates for click/move/scroll/drag are pixels of the most recent screenshot.",
      parameters: objectSchema({}, []) as never,
      strict: false,
      execute: async () => {
        // screenshot() returns raw base64 PNG and NEVER an empty string (it throws
        // instead), so the model can't receive an empty image_url.
        const b64 = await computer.screenshot();
        const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
        const image = imageOutputFromScreenshotBytes(bytes);
        // On the codex backend return the structured image output so the model SEES
        // the desktop (agents-core normalizes {type:'image'} → an input_image data-URL
        // content item in the function_call_output); chat-completions providers get
        // the text data-URL string they expect.
        return imageFunctionResults ? image : renderImageForTextTransport(image);
      },
    }),
    tool({
      name: "computer_click",
      description:
        "Click the mouse at (x, y). `button` is one of left|right|wheel|back|forward (default left). Take a computer_screenshot first to find coordinates.",
      parameters: objectSchema(
        {
          ...COORD_PROPS,
          button: {
            type: "string",
            enum: ["left", "right", "wheel", "back", "forward"],
            description: "Mouse button; defaults to left",
          },
        },
        ["x", "y"],
      ) as never,
      strict: false,
      ...approval,
      execute: async (input) => {
        const { x, y, button } = input as { x: number; y: number; button?: ComputerButton };
        return write(`clicked ${button ?? "left"} at (${x}, ${y})`, () =>
          computer.click(x, y, button ?? "left"),
        );
      },
    }),
    tool({
      name: "computer_double_click",
      description:
        "Double-click the left mouse button at (x, y). Take a computer_screenshot first to find coordinates.",
      parameters: objectSchema({ ...COORD_PROPS }, ["x", "y"]) as never,
      strict: false,
      ...approval,
      execute: async (input) => {
        const { x, y } = input as { x: number; y: number };
        return write(`double-clicked at (${x}, ${y})`, () => computer.doubleClick(x, y));
      },
    }),
    tool({
      name: "computer_move",
      description: "Move the mouse cursor to (x, y) without clicking.",
      parameters: objectSchema({ ...COORD_PROPS }, ["x", "y"]) as never,
      strict: false,
      ...approval,
      execute: async (input) => {
        const { x, y } = input as { x: number; y: number };
        return write(`moved to (${x}, ${y})`, () => computer.move(x, y));
      },
    }),
    tool({
      name: "computer_scroll",
      description:
        "Scroll at (x, y) by scroll_x / scroll_y pixels (positive scroll_y scrolls down, negative up; positive scroll_x scrolls right).",
      parameters: objectSchema(
        {
          ...COORD_PROPS,
          scroll_x: {
            type: "integer",
            description: "Horizontal scroll amount in pixels (positive = right)",
          },
          scroll_y: {
            type: "integer",
            description: "Vertical scroll amount in pixels (positive = down)",
          },
        },
        ["x", "y", "scroll_x", "scroll_y"],
      ) as never,
      strict: false,
      ...approval,
      execute: async (input) => {
        const { x, y, scroll_x, scroll_y } = input as {
          x: number;
          y: number;
          scroll_x: number;
          scroll_y: number;
        };
        return write(`scrolled (${scroll_x}, ${scroll_y}) at (${x}, ${y})`, () =>
          computer.scroll(x, y, scroll_x, scroll_y),
        );
      },
    }),
    tool({
      name: "computer_type",
      description:
        "Type a literal text string at the current keyboard focus. Click the target field first.",
      parameters: objectSchema(
        { text: { type: "string", description: "The literal text to type" } },
        ["text"],
      ) as never,
      strict: false,
      ...approval,
      execute: async (input) => {
        const { text } = input as { text: string };
        return write(`typed ${text.length} character(s)`, () => computer.type(text));
      },
    }),
    tool({
      name: "computer_keypress",
      description:
        'Press a key or chord. `keys` is an ordered list pressed together, e.g. ["ctrl","c"] or ["Enter"]. Use key names (ctrl, alt, shift, cmd, enter, tab, esc, arrows…), not characters.',
      parameters: objectSchema(
        {
          keys: {
            type: "array",
            items: { type: "string" },
            description: "Keys pressed together as a chord",
          },
        },
        ["keys"],
      ) as never,
      strict: false,
      ...approval,
      execute: async (input) => {
        const { keys } = input as { keys: string[] };
        return write(`pressed ${keys.join("+")}`, () => computer.keypress(keys));
      },
    }),
    tool({
      name: "computer_drag",
      description:
        "Drag the left mouse button along a path of points. `path` is an ordered list of {x, y} pixels; the button is pressed at the first point, moved through each, and released at the last.",
      parameters: objectSchema(
        {
          path: {
            type: "array",
            description: "Ordered list of points to drag through",
            items: {
              type: "object",
              properties: { x: { type: "integer" }, y: { type: "integer" } },
              required: ["x", "y"],
              additionalProperties: false,
            },
          },
        },
        ["path"],
      ) as never,
      strict: false,
      ...approval,
      execute: async (input) => {
        const { path } = input as { path: Array<{ x: number; y: number }> };
        const points = path.map((p) => [p.x, p.y] as [number, number]);
        return write(`dragged through ${points.length} point(s)`, () => computer.drag(points));
      },
    }),
  ] as unknown as Tool<unknown>[];
}

// ── The capability (the SDK seam) ────────────────────────────────────────────

/**
 * EXPLICIT tool-transport selection, decided by the caller that knows the
 * provider's true wire identity (the worker's model resolution — see agent-turn.ts),
 * NOT inferred from the bound model instance's constructor name. This is the
 * HARDENING seam: `supportsStructuredToolOutputTransport` string-sniffs the
 * constructor for "ChatCompletions", which a wrapped / proxied / minified model
 * instance would defeat — silently handing a chat-completions provider the HOSTED
 * `computer_use_preview` tool it 400s on every turn. When `toolMode` is set, tools()
 * OBEYS it and never consults the sniff:
 *   • "hosted"         → the single hosted `computer_use_preview` tool (Responses backends).
 *   • "function-image" → the FUNCTION `computer_*` tools with screenshots delivered as a
 *                        structured `{type:'image'}` output (the codex/ChatGPT backend,
 *                        which rejects hosted tool types but SEES structured image results).
 *   • "function-text"  → the FUNCTION tools with screenshots rendered as a text
 *                        `data:…;base64` URL (chat-completions providers, which can't read
 *                        structured image tool results).
 */
export type ComputerToolMode = "hosted" | "function-image" | "function-text";

export type ComputerUseArgs = {
  dimensions?: [number, number];
  readOnly?: boolean;
  display?: string;
  needsApproval?: boolean | ((ctx: unknown, action: unknown) => boolean | Promise<boolean>);
  // Deliver screenshots from the FUNCTION tools as a REAL image the model can see
  // (a structured `{type:'image'}` tool output → agents-core normalizes it to an
  // `input_image` content item inside the function_call_output) instead of the text
  // data-URL string. Only the codex/ChatGPT backend can read structured image tool
  // results; chat-completions providers cannot, so this stays OFF (text rendering)
  // by default and is turned on only on the codex path (see index.ts). Ignored when
  // `toolMode` is set (the mode carries its own image-delivery choice).
  imageFunctionResults?: boolean;
  // EXPLICIT transport selection (see {@link ComputerToolMode}). When present, tools()
  // obeys it directly — the constructor-name sniff is NOT consulted. When ABSENT, the
  // legacy sniff behaviour is preserved byte-for-byte (back-compat for any embedder
  // that constructs the capability without threading a mode).
  toolMode?: ComputerToolMode;
  /** Called after the display is ready on the first actual computer action. */
  onReady?: (session: SandboxSessionLike) => Promise<void>;
};

export function computerUse(args: ComputerUseArgs = {}): ComputerUseCapability {
  return new ComputerUseCapability(args);
}

/**
 * A `Capability` subclass merged into the agent's tool set by SandboxAgent
 * (`tools = [...agent.tools, ...capability.tools()]`). `bind(session)` hands it
 * the LIVE externally-owned session, so the agent's actions and the viewers'
 * pixels are one display.
 *
 * `tools()` is TRANSPORT-AWARE, mirroring the SDK's `filesystem()` capability
 * (which branches its `view_image` / `apply_patch` on
 * `supportsStructuredToolOutputTransport(this._modelInstance)`):
 *   • structured transport (the Responses/OpenAI backend) → the single HOSTED
 *     `computer_use_preview` tool over a Computer bound to the session (unchanged).
 *   • text transport (codex / ChatGPT backend — or an unbound model) → a set of
 *     FUNCTION tools ({@link computerFunctionTools}) that route to the SAME Computer,
 *     because the codex backend rejects the hosted computer tool type.
 * The bound model instance is captured by the SDK's `bind().bindRunAs().bindModel()`
 * chain (base `Capability._modelInstance`); the codex path in index.ts neutralizes
 * `bindModel` so `_modelInstance` stays undefined here → the function tools win.
 */
export class ComputerUseCapability extends Capability {
  readonly type = "computer-use";
  constructor(private args: ComputerUseArgs = {}) {
    super();
  }

  override tools(): Tool<unknown>[] {
    const session = requireBoundSession("computer-use", this._session);
    // Backend-aware: a SELF-HOSTED session (macOS OR bring-your-own Linux) drives the
    // desktop NATIVELY (CGEvent/XTEST inject + ScreenCaptureKit/x11 capture over the
    // control plane) — no xdotool/scrot on the user's machine required. Everything
    // else (Modal) keeps the xdotool/scrot-over-exec SandboxComputer. See
    // `isNativeDesktopSession` for the duck-typed discriminator.
    const computer: Computer = isNativeDesktopSession(session)
      ? new NativeDesktopComputer(session, {
          ...(this.args.dimensions ? { dimensions: this.args.dimensions } : {}),
          ...(this.args.readOnly !== undefined ? { readOnly: this.args.readOnly } : {}),
        })
      : new SandboxComputer(session, {
          ...(this.args.dimensions ? { dimensions: this.args.dimensions } : {}),
          ...(this.args.readOnly !== undefined ? { readOnly: this.args.readOnly } : {}),
          ...(this.args.display ? { display: this.args.display } : {}),
          // The SDK base exposes the bound runAs as a protected field.
          ...(typeof this._runAs === "string" ? { runAs: this._runAs } : {}),
          // Crucially lazy: tool registration does no provider work. The first
          // click/type/screenshot boots the display, then lets the worker start
          // any computer-use-only recording. One SandboxComputer instance caches
          // this for the rest of the turn.
          prepare: async (preparedSession) => {
            await ensureDisplayStack(preparedSession);
            await this.args.onReady?.(preparedSession);
          },
        });
    // HARDENING: when the caller declares an EXPLICIT toolMode, obey it and NEVER
    // consult `supportsStructuredToolOutputTransport` — tool selection must not
    // depend on the model instance's constructor name (a wrapped/proxied/minified
    // instance would defeat the "ChatCompletions" string-sniff and silently hand a
    // chat-completions provider the hosted tool it 400s on). The mode is decided by
    // the worker, where provider identity is authoritative (see agent-turn.ts).
    switch (this.args.toolMode) {
      case "hosted":
        return [this.hostedComputerTool(computer)];
      case "function-image":
        return computerFunctionTools(
          computer,
          this.args.readOnly ?? false,
          this.args.needsApproval,
          true,
        );
      case "function-text":
        return computerFunctionTools(
          computer,
          this.args.readOnly ?? false,
          this.args.needsApproval,
          false,
        );
      case undefined:
        break; // fall through to the legacy sniff (back-compat), preserved byte-for-byte
    }
    // Legacy (no toolMode): structured transport keeps the HOSTED computer tool
    // (unchanged); the codex / text backend gets the FUNCTION tools it can call.
    if (supportsStructuredToolOutputTransport(this._modelInstance)) {
      return [this.hostedComputerTool(computer)];
    }
    return computerFunctionTools(
      computer,
      this.args.readOnly ?? false,
      this.args.needsApproval,
      this.args.imageFunctionResults ?? false,
    );
  }

  /** The single HOSTED `computer_use_preview` tool bound to `computer` — identical
   *  construction for the explicit "hosted" mode and the legacy structured-sniff path. */
  private hostedComputerTool(computer: Computer): Tool<unknown> {
    return computerTool({
      computer,
      ...(this.args.needsApproval !== undefined
        ? { needsApproval: this.args.needsApproval as never }
        : {}),
    }) as unknown as Tool<unknown>;
  }
}
