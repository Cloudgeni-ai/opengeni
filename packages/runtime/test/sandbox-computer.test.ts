import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { testSettings } from "@opengeni/testing";
import { buildAgentCapabilities } from "../src/index";
import {
  SandboxComputer,
  NativeDesktopComputer,
  isNativeDesktopSession,
  ComputerUseCapability,
  computerUse,
  computerFunctionTools,
  ComputerReadOnlyError,
  ComputerUnavailableError,
  ComputerActionError,
  type NativeDesktopSession,
} from "../src/sandbox-computer";
import { KeyAction, PointerAction, PointerButton, type DesktopInputRequest } from "@opengeni/agent-proto";

// The SDK reads hosted-vs-function transport from the bound model instance's
// constructor name (supportsStructuredToolOutputTransport): a name containing
// "ChatCompletions" (and an UNBOUND model) → text/function transport; anything else
// → structured/hosted. These two fakes make the branch explicit in the tests.
class OpenAIResponsesModel {}
class OpenAIChatCompletionsModel {}
/** A structured-transport model instance → ComputerUseCapability emits the HOSTED tool. */
const structuredModel = (): never => new OpenAIResponsesModel() as never;
/** A ChatCompletions-family instance → ComputerUseCapability emits the FUNCTION tools. */
const chatCompletionsModel = (): never => new OpenAIChatCompletionsModel() as never;

// A fake Computer that records every method call so the function-tool routing can be
// asserted without a real desktop. Cast to the SDK `Computer` at the call site.
function makeFakeComputer(opts: { screenshotB64?: string } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const defaultB64 = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])).toString("base64");
  const computer = {
    environment: "ubuntu" as const,
    dimensions: [1280, 800] as [number, number],
    screenshot: async () => { calls.push(["screenshot"]); return opts.screenshotB64 ?? defaultB64; },
    click: async (x: number, y: number, button: string) => { calls.push(["click", x, y, button]); },
    doubleClick: async (x: number, y: number) => { calls.push(["doubleClick", x, y]); },
    move: async (x: number, y: number) => { calls.push(["move", x, y]); },
    scroll: async (x: number, y: number, sx: number, sy: number) => { calls.push(["scroll", x, y, sx, sy]); },
    type: async (text: string) => { calls.push(["type", text]); },
    keypress: async (keys: string[]) => { calls.push(["keypress", keys]); },
    drag: async (path: [number, number][]) => { calls.push(["drag", path]); },
    wait: async () => {},
  };
  return { computer, calls };
}

// Index a tool array by name, and invoke a function tool the SDK way (JSON-string
// input through `.invoke(runContext, input)`).
const toolsByName = (tools: unknown[]): Record<string, unknown> =>
  Object.fromEntries((tools as Array<{ name: string }>).map((t) => [t.name, t]));
const invokeTool = (t: unknown, args: unknown): Promise<unknown> =>
  (t as { invoke: (ctx: never, input: string) => Promise<unknown> }).invoke({} as never, JSON.stringify(args));
const FUNCTION_TOOL_NAMES = [
  "computer_screenshot", "computer_click", "computer_double_click", "computer_move",
  "computer_scroll", "computer_type", "computer_keypress", "computer_drag",
];

// A mock provider session that records every command. By default it mimics
// MODAL: it implements execCommand (the formatted-string contract) and does NOT
// implement exec — the F1 trap the impl must survive. The screenshot read is now a
// `base64 <path>` over execCommand (NOT readFile — Modal's readFile rejects the
// /tmp scrot as "escapes the workspace root"), so the mock returns the PNG bytes
// base64'd INSIDE the execCommand banner for `base64 …` commands.
function makeMockSession(opts: {
  withExec?: boolean; // if true, also implement the structured exec object path
  pngBytes?: Uint8Array; // bytes the screenshot read returns (base64'd over exec)
  failExit?: number; // non-zero exit for the next exec (F2 error detection)
  stillRunning?: boolean; // simulate a yield-without-finish (F3)
  // PNG bytes PER scrot attempt — models a cold :0 that paints on a later
  // retry (e.g. [empty, empty, valid] self-heals on attempt 3). Overrides pngBytes.
  pngBytesPerAttempt?: Uint8Array[];
} = {}) {
  const execCalls: string[] = [];
  // The execCommand contract: a FORMATTED STRING with a metadata preamble (F2).
  const formatted = (body: string, exit = 0): string =>
    `Chunk ID: abc123\nWall time: 0.01 seconds\nProcess exited with code ${exit}\nOutput:\n${body}`;
  const stillRunningStr = `Chunk ID: abc\nProcess running with session ID 7`;

  // The bytes the NEXT `base64 <path>` screenshot read should yield, per attempt.
  let readN = 0;
  const screenshotBytes = (): Uint8Array => {
    if (opts.pngBytesPerAttempt) {
      const i = Math.min(readN, opts.pngBytesPerAttempt.length - 1);
      readN++;
      return opts.pngBytesPerAttempt[i]!;
    }
    return opts.pngBytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  };
  // `true` once a command is the screenshot byte-read (`base64 <abs-path>`, no pipe)
  // rather than an xdotool/scrot/rm action.
  const isScreenshotRead = (cmd: string): boolean => /\bbase64 \/tmp\/og-shot-/.test(cmd);

  const run = (cmd: string): string => {
    execCalls.push(cmd);
    if (isScreenshotRead(cmd)) {
      // The screenshot read returns the PNG bytes base64'd in the banner BODY.
      return formatted(Buffer.from(screenshotBytes()).toString("base64"));
    }
    if (opts.stillRunning) return stillRunningStr;
    return formatted("", opts.failExit ?? 0);
  };

  const session: Record<string, unknown> = {
    execCommand: async (args: { cmd: string }) => run(args.cmd),
  };
  if (opts.withExec) {
    session.exec = async (args: { cmd: string }) => {
      execCalls.push(args.cmd);
      if (isScreenshotRead(args.cmd)) {
        // The exec-object path exposes a structured stdout body (no banner).
        return { output: Buffer.from(screenshotBytes()).toString("base64"), stdout: "", stderr: "", exitCode: 0 };
      }
      if (opts.stillRunning) return { output: "", stdout: "", stderr: "", sessionId: 7 };
      return { output: "", stdout: "", stderr: "", exitCode: opts.failExit ?? 0, wallTimeSeconds: 0.01 };
    };
  }
  return { session, execCalls };
}

describe("SandboxComputer (P4.3 computer-use)", () => {
  test("F1: drives Modal via execCommand (no exec) — actions still work", async () => {
    const { session, execCalls } = makeMockSession();
    const c = new SandboxComputer(session as never);
    await c.click(100, 200, "left");
    expect(execCalls.length).toBe(1);
    expect(execCalls[0]).toContain("xdotool mousemove --sync 100 200 click 1");
    // Every command is DISPLAY-prefixed against :0 (the shared human display).
    expect(execCalls[0]).toContain("DISPLAY=:0");
  });

  // ── The image_url-400 fix: read the /tmp PNG via `base64 <path>` over exec, NOT
  // session.readFile. On Modal, readFile path-validates the path against the
  // /workspace root and THROWS for /tmp ("Sandbox path /tmp/og-shot-*.png escapes
  // the workspace root") — so readFile could never read the scrot, the frame came
  // back empty, and the SDK built `image_url: ''` which 400s the model. The
  // base64-over-exec mechanism (mirroring recording.ts / channel-a fsReadViaExec)
  // is /tmp-readable and binary-safe. ──────────────────────────────────────────
  test("F2/400-FIX: screenshot reads the /tmp PNG via `base64 <path>` over exec (NOT readFile), returns clean base64", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const { session, execCalls } = makeMockSession({ pngBytes: png });
    // The session has NO readFile at all — proving the read does not depend on it.
    expect((session as Record<string, unknown>).readFile).toBeUndefined();
    const c = new SandboxComputer(session as never);
    const shot = await c.screenshot();
    // The screenshot bytes round-trip through base64-over-exec, decoded then
    // re-encoded in JS — clean, no banner.
    expect(shot).toBe(Buffer.from(png).toString("base64"));
    // scrot wrote the /tmp file, then the read was a `base64 <abs /tmp path>` over
    // the command primitive — the path that ISN'T workspace-root-validated.
    expect(execCalls.some((cmd) => cmd.includes("scrot --pointer --overwrite"))).toBe(true);
    const reads = execCalls.filter((cmd) => /\bbase64 \/tmp\/og-shot-.*\.png\b/.test(cmd));
    expect(reads.length).toBe(1);
    // Defensive: the read is base64-direct, NOT a `base64 -w0 | …` piped form (a
    // pipe would risk a banner-corrupted body) and NOT readFile.
    expect(reads[0]).not.toContain("|");
    // The temp file is cleaned up.
    expect(execCalls.some((cmd) => cmd.includes("rm -f /tmp/og-shot-"))).toBe(true);
  });

  test("400-FIX: the exec-object provider path also reads the PNG via base64 (structured stdout body)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { session, execCalls } = makeMockSession({ withExec: true, pngBytes: png });
    const c = new SandboxComputer(session as never);
    const shot = await c.screenshot();
    expect(shot).toBe(Buffer.from(png).toString("base64"));
    expect(execCalls.some((cmd) => /\bbase64 \/tmp\/og-shot-.*\.png\b/.test(cmd))).toBe(true);
  });

  // ── Regression: the "400 Invalid input[N].output.image_url" turn-killer ──────
  // The Agents SDK builds the model-facing image as `data:image/png;base64,${out}`
  // (runner/toolExecution.mjs). An EMPTY screenshot output => `image_url: ''` =>
  // the model API 400s and the computer-use turn dies. screenshot() must NEVER
  // return "" — it throws (a clear action failure) or self-heals via retry.
  test("REGRESSION: a zero-byte (cold/dead :0) frame THROWS — never returns an empty string", async () => {
    const { session } = makeMockSession({ pngBytes: new Uint8Array() }); // empty PNG, every attempt
    // Shrink the warm-up budget so the "genuinely dead display" path fails fast in the
    // test instead of burning the full 30s cold-boot budget (behavior is identical).
    const c = new SandboxComputer(session as never, { screenshotWarmupBudgetMs: 30, screenshotRetryDelayMs: 5 });
    // Failure-sensitive: it must reject (NOT resolve to ""), so an empty image_url
    // can never reach the model.
    const result = await c.screenshot().then((s) => ({ ok: true as const, s }), (e) => ({ ok: false as const, e }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`screenshot() resolved to ${JSON.stringify(result.s)} — an empty image_url would 400 the model turn`);
    expect(result.e).toBeInstanceOf(ComputerUnavailableError);
  });

  test("REGRESSION: a transient cold frame self-heals — empty on attempt 1, valid on a retry", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    // attempt 1 reads 0 bytes (display still warming), attempt 2 paints.
    const { session, execCalls } = makeMockSession({ pngBytesPerAttempt: [new Uint8Array(), png] });
    const c = new SandboxComputer(session as never);
    const shot = await c.screenshot();
    expect(shot).toBe(Buffer.from(png).toString("base64"));
    // Two scrot attempts were made (the retry), and every attempt cleaned up its
    // temp file (no leak across retries).
    const scrots = execCalls.filter((cmd) => cmd.includes("scrot --pointer --overwrite"));
    const cleanups = execCalls.filter((cmd) => cmd.includes("rm -f /tmp/og-shot-"));
    expect(scrots.length).toBe(2);
    expect(cleanups.length).toBe(2);
  });

  test("F2: nonzero exit is DETECTED via the preamble parser (not a silent success)", async () => {
    const { session } = makeMockSession({ failExit: 4 });
    const c = new SandboxComputer(session as never);
    await expect(c.click(1, 1, "left")).rejects.toBeInstanceOf(ComputerActionError);
  });

  test("F3: a 'still running' action yield WARNS and resolves (does not throw) so screenshot() runs", async () => {
    // CHANGED from throw to warn+return: if a click/move/type times out at the
    // yield window and we throw, the SDK catch (toolExecution.mjs) sets output=''
    // and builds `{image_url:""}` → Azure 400. By returning instead, the SDK
    // proceeds to call computer.screenshot() after the action loop, and the model
    // gets the real current frame. The wire-level backstop in
    // computerCallNormalizingFetch is also in place as a second net. Non-zero exit
    // codes (true command errors) still throw — only the still-running case is
    // silenced. screenshot()'s fail-loud + retry contract is preserved.
    const { session } = makeMockSession({ stillRunning: true });
    const c = new SandboxComputer(session as never);
    // move() must RESOLVE (not reject) so the SDK action loop exits cleanly and
    // screenshot() is called afterward.
    await expect(c.move(5, 5)).resolves.toBeUndefined();
  });

  test("F5: scroll converts model pixel deltas to clamped wheel notches (not literal repeat counts)", async () => {
    const { session, execCalls } = makeMockSession();
    const c = new SandboxComputer(session as never);
    await c.scroll(10, 10, 0, 300); // 300px down
    // 300 / 100 = 3 notches (button 5 = down), NOT --repeat 300.
    expect(execCalls[0]).toContain("click --repeat 3 5");
    execCalls.length = 0;
    await c.scroll(10, 10, 0, -100000); // runaway up
    // clamped to SCROLL_MAX_CLICKS=15, button 4 = up.
    expect(execCalls[0]).toContain("click --repeat 15 4");
  });

  test("type single-quote-escapes the text payload", async () => {
    const { session, execCalls } = makeMockSession();
    const c = new SandboxComputer(session as never);
    await c.type("it's a test");
    expect(execCalls[0]).toContain("xdotool type --delay 12");
    // single-quote inside is escaped: '\''
    expect(execCalls[0]).toContain(`'it'\\''s a test'`);
  });

  test("keypress maps key names to xdotool keysyms and joins a chord", async () => {
    const { session, execCalls } = makeMockSession();
    const c = new SandboxComputer(session as never);
    await c.keypress(["ctrl", "c"]);
    expect(execCalls[0]).toContain("xdotool key -- 'ctrl+c'");
    execCalls.length = 0;
    await c.keypress(["cmd", "Enter"]); // cmd->super, Enter->Return
    expect(execCalls[0]).toContain("super+Return");
  });

  test("drag builds a single mousedown→moves→mouseup line", async () => {
    const { session, execCalls } = makeMockSession();
    const c = new SandboxComputer(session as never);
    await c.drag([[0, 0], [10, 10], [20, 20]]);
    expect(execCalls[0]).toContain("mousemove --sync 0 0 mousedown 1");
    expect(execCalls[0]).toContain("mousemove --sync 10 10");
    expect(execCalls[0]).toContain("mouseup 1");
  });

  test("readOnly mode throws on every write but screenshots still work", async () => {
    const { session } = makeMockSession();
    const c = new SandboxComputer(session as never, { readOnly: true });
    await expect(c.click(1, 1, "left")).rejects.toBeInstanceOf(ComputerReadOnlyError);
    await expect(c.type("x")).rejects.toBeInstanceOf(ComputerReadOnlyError);
    await expect(c.keypress(["a"])).rejects.toBeInstanceOf(ComputerReadOnlyError);
    // screenshot is a READ — never gated.
    await expect(c.screenshot()).resolves.toBeString();
  });

  test("a session with neither exec nor execCommand fails loud (ComputerUnavailableError)", async () => {
    const c = new SandboxComputer({ readFile: async () => new Uint8Array() } as never);
    await expect(c.move(1, 1)).rejects.toBeInstanceOf(ComputerUnavailableError);
  });

  test("environment is 'ubuntu' and dimensions default to the stream geometry", () => {
    const { session } = makeMockSession();
    const c = new SandboxComputer(session as never, { dimensions: [1024, 768] });
    expect(c.environment).toBe("ubuntu");
    expect(c.dimensions).toEqual([1024, 768]);
  });
});

// A FAKE self-hosted session presenting the `{ desktopInput, screenshot }` native
// surface. Records every injected DesktopInput event so tests can assert the exact
// protos (event $case + fields + enum values), and returns a configurable PNG.
function makeNativeSession(
  opts: {
    png?: Uint8Array;
    width?: number;
    height?: number;
    nativeWidth?: number;
    nativeHeight?: number;
    // Per-attempt PNG sequence: attempt N returns pngPerAttempt[N] (last value sticks).
    // Used to model a warming capture that returns an empty frame then a real one.
    pngPerAttempt?: Uint8Array[];
    // When set, screenshot() THROWS this per attempt (last value sticks; null = resolve).
    // Models the agent surfacing a capture AgentError (permission denied / null image).
    throwPerAttempt?: (Error | null)[];
  } = {},
) {
  const inputs: NonNullable<DesktopInputRequest["event"]>[] = [];
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  let attempt = 0;
  const at = <T>(arr: T[] | undefined, i: number): T | undefined => (arr ? (arr[Math.min(i, arr.length - 1)]) : undefined);
  const session: NativeDesktopSession = {
    desktopInput: async (event) => {
      if (event) inputs.push(event);
    },
    screenshot: async () => {
      const i = attempt++;
      const toThrow = at(opts.throwPerAttempt, i);
      if (toThrow) throw toThrow;
      return {
        png: at(opts.pngPerAttempt, i) ?? opts.png ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
        width,
        height,
        // Default: native == encoded (no downscale). Tests that exercise the
        // downscale coordinate-scaling override nativeWidth/nativeHeight.
        nativeWidth: opts.nativeWidth ?? width,
        nativeHeight: opts.nativeHeight ?? height,
      };
    },
  };
  return { session, inputs, attempts: () => attempt };
}

// Fast warm-up timing so the retry-loop tests don't wait the 6 s production budget.
const FAST_WARMUP = { screenshotWarmupBudgetMs: 40, screenshotRetryDelayMs: 4 } as const;

describe("NativeDesktopComputer (self-hosted / macOS native inject+capture)", () => {
  test("click emits a POINTER CLICK event with the coords + LEFT button", async () => {
    const { session, inputs } = makeNativeSession();
    const c = new NativeDesktopComputer(session);
    await c.click(100, 200, "left");
    expect(inputs.length).toBe(1);
    const ev = inputs[0]!;
    expect(ev.$case).toBe("pointer");
    if (ev.$case !== "pointer") throw new Error("expected pointer");
    expect(ev.pointer).toEqual({
      x: 100,
      y: 200,
      action: PointerAction.POINTER_ACTION_CLICK,
      button: PointerButton.POINTER_BUTTON_LEFT,
    });
  });

  test("right/wheel clicks map to the RIGHT/MIDDLE pointer buttons", async () => {
    const { session, inputs } = makeNativeSession();
    const c = new NativeDesktopComputer(session);
    await c.click(1, 1, "right");
    await c.click(2, 2, "wheel");
    expect((inputs[0] as { pointer: { button: PointerButton } }).pointer.button).toBe(PointerButton.POINTER_BUTTON_RIGHT);
    expect((inputs[1] as { pointer: { button: PointerButton } }).pointer.button).toBe(PointerButton.POINTER_BUTTON_MIDDLE);
  });

  test("doubleClick emits a DOUBLE_CLICK pointer event (LEFT)", async () => {
    const { session, inputs } = makeNativeSession();
    const c = new NativeDesktopComputer(session);
    await c.doubleClick(5, 6);
    const ev = inputs[0]!;
    if (ev.$case !== "pointer") throw new Error("expected pointer");
    expect(ev.pointer.action).toBe(PointerAction.POINTER_ACTION_DOUBLE_CLICK);
    expect(ev.pointer.button).toBe(PointerButton.POINTER_BUTTON_LEFT);
  });

  test("type emits a TEXT key event (isText:true, PRESS) with the verbatim string", async () => {
    const { session, inputs } = makeNativeSession();
    const c = new NativeDesktopComputer(session);
    await c.type("it's a test");
    const ev = inputs[0]!;
    expect(ev.$case).toBe("key");
    if (ev.$case !== "key") throw new Error("expected key");
    expect(ev.key).toEqual({ key: "it's a test", isText: true, action: KeyAction.KEY_ACTION_PRESS });
  });

  test("keypress emits ONE non-text chord KeyEvent (platform-independent names, PRESS)", async () => {
    const { session, inputs } = makeNativeSession();
    const c = new NativeDesktopComputer(session);
    await c.keypress(["ctrl", "c"]);
    expect(inputs.length).toBe(1);
    const ev = inputs[0]!;
    if (ev.$case !== "key") throw new Error("expected key");
    // Joined with "+", isText:false (interpret as key names — NOT xdotool keysyms).
    expect(ev.key).toEqual({ key: "ctrl+c", isText: false, action: KeyAction.KEY_ACTION_PRESS });
  });

  test("scroll forwards the raw pixel deltas as a ScrollEvent (no notch quantization)", async () => {
    const { session, inputs } = makeNativeSession();
    const c = new NativeDesktopComputer(session);
    await c.scroll(10, 20, -3, 300);
    const ev = inputs[0]!;
    expect(ev.$case).toBe("scroll");
    if (ev.$case !== "scroll") throw new Error("expected scroll");
    expect(ev.scroll).toEqual({ x: 10, y: 20, deltaX: -3, deltaY: 300 });
  });

  test("drag emits DOWN → MOVE(s) → UP pointer events along the path", async () => {
    const { session, inputs } = makeNativeSession();
    const c = new NativeDesktopComputer(session);
    await c.drag([[0, 0], [10, 10], [20, 20]]);
    const actions = inputs.map((ev) => (ev.$case === "pointer" ? ev.pointer.action : -1));
    // DOWN at the start, a MOVE through EACH subsequent waypoint, UP at the last.
    expect(actions).toEqual([
      PointerAction.POINTER_ACTION_DOWN,
      PointerAction.POINTER_ACTION_MOVE,
      PointerAction.POINTER_ACTION_MOVE,
      PointerAction.POINTER_ACTION_UP,
    ]);
    // Down at the start, up at the last waypoint.
    const first = inputs[0]!;
    const last = inputs[inputs.length - 1]!;
    if (first.$case !== "pointer" || last.$case !== "pointer") throw new Error("expected pointers");
    expect([first.pointer.x, first.pointer.y]).toEqual([0, 0]);
    expect([last.pointer.x, last.pointer.y]).toEqual([20, 20]);
  });

  test("COORD-SCALE: after a DOWNSCALED screenshot, clicks scale from encoded→native pixels", async () => {
    // The agent downscaled a 1280×800 native capture to a 640×400 encoded PNG to fit
    // the transport budget. The model clicks in the ENCODED space it saw (640×400);
    // the injected coordinates must be scaled back up 2× to native (1280×800).
    const { session, inputs } = makeNativeSession({
      width: 640,
      height: 400,
      nativeWidth: 1280,
      nativeHeight: 800,
    });
    const c = new NativeDesktopComputer(session);
    await c.screenshot(); // records encoded 640×400 / native 1280×800
    await c.click(320, 200, "left"); // center of the encoded frame
    const ev = inputs[0]!;
    if (ev.$case !== "pointer") throw new Error("expected pointer");
    // 320 * (1280/640) = 640 ; 200 * (800/400) = 400 → center of the NATIVE frame.
    expect([ev.pointer.x, ev.pointer.y]).toEqual([640, 400]);

    // Scroll anchor scales too; the deltas are amounts and pass through unscaled.
    await c.scroll(320, 200, -3, 7);
    const s = inputs[1]!;
    if (s.$case !== "scroll") throw new Error("expected scroll");
    expect(s.scroll).toEqual({ x: 640, y: 400, deltaX: -3, deltaY: 7 });
  });

  test("COORD-SCALE: with NO downscale (native == encoded), coordinates pass through byte-identical", async () => {
    const { session, inputs } = makeNativeSession({ width: 1280, height: 800 }); // native defaults to encoded
    const c = new NativeDesktopComputer(session);
    await c.screenshot();
    await c.click(640, 400, "left");
    const ev = inputs[0]!;
    if (ev.$case !== "pointer") throw new Error("expected pointer");
    expect([ev.pointer.x, ev.pointer.y]).toEqual([640, 400]); // 1.0 factor, unchanged
  });

  test("screenshot returns the base64 of the fake PNG (non-empty, no data-URL prefix)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { session } = makeNativeSession({ png });
    const c = new NativeDesktopComputer(session);
    const shot = await c.screenshot();
    expect(shot).toBe(Buffer.from(png).toString("base64"));
    // Raw base64 — the SDK adds the `data:image/png;base64,` prefix itself.
    expect(shot.startsWith("data:")).toBe(false);
  });

  test("REGRESSION: a persistently empty PNG THROWS (never an empty image_url / blank placeholder)", async () => {
    const { session, attempts } = makeNativeSession({ png: new Uint8Array() });
    const c = new NativeDesktopComputer(session, FAST_WARMUP);
    const result = await c.screenshot().then((s) => ({ ok: true as const, s }), (e) => ({ ok: false as const, e }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`screenshot() resolved to ${JSON.stringify(result.s)} — an empty image_url would 400 the model turn`);
    expect(result.e).toBeInstanceOf(ComputerUnavailableError);
    // It RETRIED across the warm-up budget before failing (not a single-shot throw).
    expect(attempts()).toBeGreaterThan(1);
  });

  test("BLANK-SCREENSHOT FIX: a warming empty FIRST frame self-heals on retry (no blank placeholder)", async () => {
    // The agent's ScreenCaptureKit can hand back an empty first frame right after
    // connect; the old single-shot path turned that into a blank the model misread.
    const real = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { session, attempts } = makeNativeSession({ pngPerAttempt: [new Uint8Array(), new Uint8Array(), real] });
    const c = new NativeDesktopComputer(session, FAST_WARMUP);
    const shot = await c.screenshot();
    expect(shot).toBe(Buffer.from(real).toString("base64"));
    expect(attempts()).toBe(3); // two empty misses, then the real frame
  });

  test("BLANK-SCREENSHOT FIX: a permission (TCC) denial FAILS FAST and loud — no retry, no blank", async () => {
    const denial = new Error("Screen Recording permission is not granted");
    const { session, attempts } = makeNativeSession({ throwPerAttempt: [denial] });
    const c = new NativeDesktopComputer(session, FAST_WARMUP);
    const result = await c.screenshot().then((s) => ({ ok: true as const, s }), (e) => ({ ok: false as const, e }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a denied capture must throw, never resolve to a blank");
    // The AGENT's reason is surfaced verbatim (operator sees "grant Screen Recording").
    expect((result.e as Error).message).toContain("Screen Recording");
    // Terminal denial short-circuits the warm-up budget — exactly ONE attempt.
    expect(attempts()).toBe(1);
  });

  test("readOnly blocks every write but screenshot is always allowed", async () => {
    const { session, inputs } = makeNativeSession();
    const c = new NativeDesktopComputer(session, { readOnly: true });
    await expect(c.click(1, 1, "left")).rejects.toBeInstanceOf(ComputerReadOnlyError);
    await expect(c.doubleClick(1, 1)).rejects.toBeInstanceOf(ComputerReadOnlyError);
    await expect(c.move(1, 1)).rejects.toBeInstanceOf(ComputerReadOnlyError);
    await expect(c.scroll(1, 1, 0, 10)).rejects.toBeInstanceOf(ComputerReadOnlyError);
    await expect(c.type("x")).rejects.toBeInstanceOf(ComputerReadOnlyError);
    await expect(c.keypress(["a"])).rejects.toBeInstanceOf(ComputerReadOnlyError);
    await expect(c.drag([[0, 0], [1, 1]])).rejects.toBeInstanceOf(ComputerReadOnlyError);
    // No write ever reached the session.
    expect(inputs.length).toBe(0);
    // screenshot is a READ — never gated.
    await expect(c.screenshot()).resolves.toBeString();
  });

  test("environment defaults to 'ubuntu' and dimensions default to the stream geometry", () => {
    const { session } = makeNativeSession();
    const c = new NativeDesktopComputer(session, { dimensions: [1024, 768] });
    expect(c.environment).toBe("ubuntu");
    expect(c.dimensions).toEqual([1024, 768]);
  });
});

describe("computer backend selection (native vs xdotool)", () => {
  test("isNativeDesktopSession: true for a {desktopInput,screenshot} session, false for a Modal session", () => {
    const { session: native } = makeNativeSession();
    expect(isNativeDesktopSession(native as never)).toBe(true);
    // The Modal-shaped mock (execCommand only) is NOT native.
    const { session: modal } = makeMockSession();
    expect(isNativeDesktopSession(modal as never)).toBe(false);
  });

  test("ComputerUseCapability bound to a native session drives desktopInput (NOT exec)", async () => {
    const { session, inputs } = makeNativeSession();
    const cap = computerUse({ readOnly: false });
    // Structured transport → the single hosted computerTool over the selected Computer.
    cap.bind(session as never).bindModel("responses", structuredModel());
    const tools = cap.tools();
    expect(tools.length).toBe(1);
    // Reach through the tool to the selected computer and drive a click — it must
    // land on the native desktopInput seam, proving NativeDesktopComputer was chosen.
    const computer = (tools[0] as unknown as { computer: NativeDesktopComputer }).computer;
    expect(computer).toBeInstanceOf(NativeDesktopComputer);
    await computer.click(3, 4, "left");
    expect(inputs.length).toBe(1);
    expect(inputs[0]!.$case).toBe("pointer");
  });

  test("ComputerUseCapability bound to a Modal session selects the xdotool SandboxComputer", () => {
    const { session } = makeMockSession();
    const cap = computerUse({ readOnly: false });
    cap.bind(session as never).bindModel("responses", structuredModel());
    const tools = cap.tools();
    const computer = (tools[0] as unknown as { computer: unknown }).computer;
    expect(computer).toBeInstanceOf(SandboxComputer);
  });
});

describe("ComputerUseCapability (the SDK seam)", () => {
  test("tools() throws before bind(session) and returns one HOSTED computerTool on the structured transport", () => {
    const cap = computerUse({ readOnly: false });
    expect(cap).toBeInstanceOf(ComputerUseCapability);
    expect(cap.type).toBe("computer-use");
    // Unbound → requireBoundSession throws.
    expect(() => cap.tools()).toThrow();
    const { session } = makeMockSession();
    // Structured transport (a non-ChatCompletions model instance) → hosted tool.
    cap.bind(session as never).bindModel("responses", structuredModel());
    const tools = cap.tools();
    expect(tools.length).toBe(1);
    // The computer tool wires the model's computer_use_preview surface.
    expect((tools[0] as { type?: string }).type).toBe("computer");
  });
});

// ── Transport-aware seam: codex/text FUNCTION tools vs the hosted computer tool ──
// Mirrors the SDK filesystem capability, which branches view_image/apply_patch on
// supportsStructuredToolOutputTransport(_modelInstance). ComputerUseCapability now
// emits the hosted `computer_use_preview` tool on the structured transport and a set
// of FUNCTION `computer_*` tools on the text/codex transport (an unbound or
// ChatCompletions-family model), because the codex backend rejects hosted tools.
describe("ComputerUseCapability transport-aware seam", () => {
  test("text transport (no structured model bound) → the 8 FUNCTION computer_* tools", () => {
    const { session } = makeMockSession();
    const cap = computerUse({ readOnly: false });
    cap.bind(session as never); // no bindModel → _modelInstance undefined → text transport
    const names = cap.tools().map((t) => (t as { name?: string }).name);
    expect(names).toEqual(FUNCTION_TOOL_NAMES);
    // Every emitted tool is a function tool (not the hosted "computer" type).
    for (const t of cap.tools()) expect((t as { type?: string }).type).toBe("function");
  });

  test("a ChatCompletions-family model also gets the FUNCTION tools", () => {
    const { session } = makeMockSession();
    const cap = computerUse({});
    cap.bind(session as never).bindModel("gpt", chatCompletionsModel());
    const names = cap.tools().map((t) => (t as { name?: string }).name);
    expect(names).toEqual(FUNCTION_TOOL_NAMES);
  });

  test("structured transport → the single HOSTED computer tool (unchanged)", () => {
    const { session } = makeMockSession();
    const cap = computerUse({});
    cap.bind(session as never).bindModel("responses", structuredModel());
    const tools = cap.tools();
    expect(tools.length).toBe(1);
    expect((tools[0] as { type?: string }).type).toBe("computer");
  });
});

// ── HARDENING: EXPLICIT toolMode overrides the constructor-name sniff ─────────
// The refactor adds `toolMode: "hosted" | "function-image" | "function-text"` so
// tool selection is decided by the caller that knows the provider's true wire
// identity (the worker), NOT inferred from the bound model instance's constructor
// name (which a wrapped/proxied/minified instance would defeat). When toolMode is
// set, tools() OBEYS it and never consults supportsStructuredToolOutputTransport;
// when ABSENT, the legacy sniff behaviour is preserved byte-for-byte.
describe("ComputerUseCapability explicit toolMode (hardening — sniff not consulted)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

  test('toolMode "hosted" → the single HOSTED tool EVEN when a ChatCompletions model is bound', () => {
    const { session } = makeMockSession();
    const cap = computerUse({ toolMode: "hosted" });
    // Bind a ChatCompletions instance: the sniff would say "function tools", so a
    // hosted result PROVES the explicit mode overrode the constructor-name sniff.
    cap.bind(session as never).bindModel("gpt", chatCompletionsModel());
    const tools = cap.tools();
    expect(tools.length).toBe(1);
    expect((tools[0] as { type?: string }).type).toBe("computer");
  });

  test('toolMode "function-image" → the 8 FUNCTION tools EVEN when a structured model is bound; screenshot is a structured image', async () => {
    // A structured model would sniff to the hosted tool; function tools prove override.
    const { session } = makeMockSession({ pngBytes: PNG });
    const cap = computerUse({ toolMode: "function-image" });
    cap.bind(session as never).bindModel("responses", structuredModel());
    const tools = cap.tools();
    expect(tools.map((t) => (t as { name?: string }).name)).toEqual(FUNCTION_TOOL_NAMES);
    for (const t of tools) expect((t as { type?: string }).type).toBe("function");
    // function-image delivers the desktop as a STRUCTURED {type:'image'} tool output
    // (imageFunctionResults=true) — the shape the codex/ChatGPT backend can SEE.
    const shot = toolsByName(tools).computer_screenshot;
    const out = (await invokeTool(shot, {})) as { type?: string; image?: { mediaType?: string } };
    expect(out.type).toBe("image");
    expect(out.image?.mediaType).toBe("image/png");
  });

  test('toolMode "function-text" → the 8 FUNCTION tools; screenshot is a text data-URL string', async () => {
    const { session } = makeMockSession({ pngBytes: PNG });
    const cap = computerUse({ toolMode: "function-text" });
    cap.bind(session as never).bindModel("responses", structuredModel());
    const tools = cap.tools();
    expect(tools.map((t) => (t as { name?: string }).name)).toEqual(FUNCTION_TOOL_NAMES);
    // function-text renders the screenshot as a `data:…;base64` STRING (chat-completions
    // providers can't read structured image tool results) — NOT a {type:'image'} object.
    const shot = toolsByName(tools).computer_screenshot;
    const out = await invokeTool(shot, {});
    expect(out).toBe(PNG_DATA_URL);
  });

  test("REGRESSION: ABSENT toolMode preserves the sniff byte-for-byte (structured→hosted, chat→function)", () => {
    const { session: s1 } = makeMockSession();
    const structured = computerUse({}); // no toolMode
    structured.bind(s1 as never).bindModel("responses", structuredModel());
    expect(structured.tools().length).toBe(1);
    expect((structured.tools()[0] as { type?: string }).type).toBe("computer");

    const { session: s2 } = makeMockSession();
    const chat = computerUse({}); // no toolMode
    chat.bind(s2 as never).bindModel("gpt", chatCompletionsModel());
    expect(chat.tools().map((t) => (t as { name?: string }).name)).toEqual(FUNCTION_TOOL_NAMES);
  });
});

describe("computerFunctionTools (codex text-transport routing)", () => {
  test("emits all 8 computer_* function tools", () => {
    const { computer } = makeFakeComputer();
    const tools = computerFunctionTools(computer as never, false);
    expect(tools.map((t) => (t as { name?: string }).name)).toEqual(FUNCTION_TOOL_NAMES);
    for (const t of tools) expect((t as { type?: string }).type).toBe("function");
  });

  test("click/double_click/move/scroll/type/keypress/drag route to the bound Computer with the exact args", async () => {
    const { computer, calls } = makeFakeComputer();
    const t = toolsByName(computerFunctionTools(computer as never, false));
    await invokeTool(t.computer_click, { x: 10, y: 20 }); // button defaults to left
    await invokeTool(t.computer_click, { x: 1, y: 2, button: "right" });
    await invokeTool(t.computer_double_click, { x: 3, y: 4 });
    await invokeTool(t.computer_move, { x: 5, y: 6 });
    await invokeTool(t.computer_scroll, { x: 7, y: 8, scroll_x: 0, scroll_y: 300 });
    await invokeTool(t.computer_type, { text: "hello" });
    await invokeTool(t.computer_keypress, { keys: ["ctrl", "c"] });
    await invokeTool(t.computer_drag, { path: [{ x: 0, y: 0 }, { x: 9, y: 9 }] });
    expect(calls).toEqual([
      ["click", 10, 20, "left"],
      ["click", 1, 2, "right"],
      ["doubleClick", 3, 4],
      ["move", 5, 6],
      ["scroll", 7, 8, 0, 300],
      ["type", "hello"],
      ["keypress", ["ctrl", "c"]],
      ["drag", [[0, 0], [9, 9]]],
    ]);
  });

  test("computer_screenshot returns a data:image/png;base64 URL built from the Computer's base64 screenshot", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const b64 = Buffer.from(png).toString("base64");
    const { computer, calls } = makeFakeComputer({ screenshotB64: b64 });
    const t = toolsByName(computerFunctionTools(computer as never, false));
    const out = await invokeTool(t.computer_screenshot, {});
    // Exactly the two-step imageOutputFromBytes → renderImageForTextTransport shape,
    // mirroring the SDK's text view_image: a data URL whose bytes are the fake's PNG.
    expect(out).toBe(`data:image/png;base64,${b64}`);
    expect(calls).toContainEqual(["screenshot"]);
  });

  test("readOnly returns a clear message and never touches the Computer for writes; screenshot still works", async () => {
    const { computer, calls } = makeFakeComputer();
    const t = toolsByName(computerFunctionTools(computer as never, true));
    const clickOut = await invokeTool(t.computer_click, { x: 1, y: 1 });
    const typeOut = await invokeTool(t.computer_type, { text: "x" });
    const dragOut = await invokeTool(t.computer_drag, { path: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    expect(String(clickOut)).toContain("read-only");
    expect(String(typeOut)).toContain("read-only");
    expect(String(dragOut)).toContain("read-only");
    // No write ever reached the Computer.
    expect(calls.length).toBe(0);
    // screenshot is a READ — never gated.
    const shot = await invokeTool(t.computer_screenshot, {});
    expect(String(shot).startsWith("data:image/")).toBe(true);
    expect(calls).toEqual([["screenshot"]]);
  });
});

describe("computerFunctionTools image delivery on the codex backend", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const PNG_B64 = Buffer.from(PNG).toString("base64");
  const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

  test("imageFunctionResults=false (default): computer_screenshot returns the text data-URL string", async () => {
    const { computer } = makeFakeComputer({ screenshotB64: PNG_B64 });
    const t = toolsByName(computerFunctionTools(computer as never, false, undefined, false));
    const out = await invokeTool(t.computer_screenshot, {});
    // Chat-completions providers keep the SDK's text view_image rendering EXACTLY.
    expect(out).toBe(PNG_DATA_URL);
  });

  test("imageFunctionResults=true: computer_screenshot returns a structured {type:'image'} tool output", async () => {
    const { computer } = makeFakeComputer({ screenshotB64: PNG_B64 });
    const t = toolsByName(computerFunctionTools(computer as never, false, undefined, true));
    const out = (await invokeTool(t.computer_screenshot, {})) as {
      type: string;
      image: { data: Uint8Array; mediaType: string };
    };
    // NOT a text data-URL string — the structured image the codex backend can SEE.
    expect(typeof out).toBe("object");
    expect(out.type).toBe("image");
    expect(out.image.mediaType).toBe("image/png");
    expect(Array.from(out.image.data)).toEqual(Array.from(PNG));
  });

  // The decisive Candidate-A evidence: the structured {type:'image', image:{data:Uint8Array}}
  // return value NEVER reaches the DB as a Uint8Array. agents-core's getToolCallOutputItem
  // (runner/toolExecution.mjs — normalizeStructuredToolOutput → toInlineImageString/asDataUrl,
  // then convertStructuredToolOutputToInputItem) converts the bytes to a base64 data-URL
  // STRING and persists `{type:'input_image', image:'data:…'}`. That string survives JSON
  // round-trip, and at request time the codex serializer maps `image` → `image_url`.
  test("round-trip: tool result → getToolCallOutputItem → JSON → request wire shape has a non-empty input_image image_url", async () => {
    const { computer } = makeFakeComputer({ screenshotB64: PNG_B64 });
    const t = toolsByName(computerFunctionTools(computer as never, false, undefined, true));
    const toolResult = await invokeTool(t.computer_screenshot, {});

    // Reach the REAL agents-core normalizer that builds the persisted function_call_result
    // (not exported from the package root, so resolve it through @openai/agents' own deps).
    const req = createRequire(import.meta.url);
    const agentsReq = createRequire(req.resolve("@openai/agents"));
    const toolExecPath = join(dirname(agentsReq.resolve("@openai/agents-core")), "runner", "toolExecution.mjs");
    const { getToolCallOutputItem } = (await import(toolExecPath)) as {
      getToolCallOutputItem: (
        toolCall: { name: string; callId: string },
        output: unknown,
      ) => { type: string; callId: string; output: unknown };
    };

    // 1) The tool result becomes the persisted function_call_result raw item.
    const rawItem = getToolCallOutputItem({ name: "computer_screenshot", callId: "call_1" }, toolResult);
    expect(Array.isArray(rawItem.output)).toBe(true);
    const persistedItem = (rawItem.output as Array<Record<string, unknown>>)[0]!;
    // Persisted as an input_image whose `image` is a data-URL STRING — no Uint8Array.
    expect(persistedItem.type).toBe("input_image");
    expect(typeof persistedItem.image).toBe("string");
    expect(persistedItem.image as string).toBe(PNG_DATA_URL);

    // 2) DB round-trip through JSON.stringify/parse (session_history_items persistence).
    const replayed = JSON.parse(JSON.stringify(rawItem.output)) as Array<Record<string, unknown>>;
    // Deep-equal proves nothing degraded (a Uint8Array would round-trip as an
    // object-of-numbers and break this equality + the request serializer below).
    expect(replayed).toEqual(rawItem.output as never);
    const replayedItem = replayed[0]!;
    expect(typeof replayedItem.image).toBe("string");

    // 3) The request-time serializer (agents-openai openaiResponsesModel.mjs
    //    convertStructuredOutputToRequestItem input_image branch: reads `image ?? imageUrl`,
    //    emits `image_url`) turns the replayed item into the codex /responses wire shape.
    const wire = convertInputImageToRequestItem(replayedItem);
    expect(wire.type).toBe("input_image");
    expect(typeof wire.image_url).toBe("string");
    expect((wire.image_url as string).length).toBeGreaterThan(0);
    expect(wire.image_url).toBe(PNG_DATA_URL);
  });
});

// Faithful copy of the input_image branch of agents-openai's private
// convertStructuredOutputToRequestItem (openaiResponsesModel.mjs): it is NOT exported,
// so it is replicated here — the branch reads `image ?? imageUrl` and emits `image_url`.
function convertInputImageToRequestItem(item: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { type: "input_image" };
  const imageValue = (item.image ?? item.imageUrl) as unknown;
  if (typeof imageValue === "string") {
    result.image_url = imageValue;
  }
  if (typeof item.detail === "string") {
    result.detail = item.detail;
  }
  return result;
}

describe("buildAgentCapabilities computer-use gating (P4.3)", () => {
  const types = (s: Parameters<typeof buildAgentCapabilities>[0]) =>
    buildAgentCapabilities(s, []).map((c) => (c as { type?: string }).type);

  test("modal + desktop ON + computerUse ON → computer-use attached", () => {
    const t = types(testSettings({ sandboxBackend: "modal", sandboxDesktopEnabled: true, computerUseEnabled: true }));
    expect(t).toContain("computer-use");
  });

  test("desktop OFF → no computer-use (the headless default is unchanged)", () => {
    const t = types(testSettings({ sandboxBackend: "modal", sandboxDesktopEnabled: false, computerUseEnabled: true }));
    expect(t).not.toContain("computer-use");
  });

  test("computerUse disabled → no computer-use even with desktop on", () => {
    const t = types(testSettings({ sandboxBackend: "modal", sandboxDesktopEnabled: true, computerUseEnabled: false }));
    expect(t).not.toContain("computer-use");
  });

  test("a non-desktop backend never gets computer-use (F18: honest gate)", () => {
    const t = types(testSettings({ sandboxBackend: "none", sandboxDesktopEnabled: true, computerUseEnabled: true }));
    expect(t).not.toContain("computer-use");
  });

  test("codex path (structuredToolTransport:false): computer-use ATTACHED and NEUTRALIZED to FUNCTION tools (no longer suppressed)", () => {
    const desktopOn = testSettings({ sandboxBackend: "modal", sandboxDesktopEnabled: true, computerUseEnabled: true });
    // Structured backend attaches computer-use (as before) — the hosted tool path.
    expect(buildAgentCapabilities(desktopOn, []).map((c) => (c as { type?: string }).type)).toContain("computer-use");
    // On the codex backend it is NO LONGER dropped: it is attached and neutralized so
    // its tools() emits the FUNCTION computer_* tools the codex backend accepts.
    const codexCaps = buildAgentCapabilities(desktopOn, [], { structuredToolTransport: false });
    const codexTypes = codexCaps.map((c) => (c as { type?: string }).type);
    expect(codexTypes).toContain("computer-use");
    // filesystem/shell still present (unchanged).
    expect(codexTypes).toContain("filesystem");
    expect(codexTypes).toContain("shell");
    // Prove the attached capability emits the FUNCTION tools even when the SDK bind
    // chain hands it a STRUCTURED model instance: neutralize overrode bindModel to
    // drop the instance, so tools() falls to the function transport.
    const computerCap = codexCaps.find((c) => (c as { type?: string }).type === "computer-use") as unknown as ComputerUseCapability;
    const { session } = makeMockSession();
    computerCap.bind(session as never).bindModel("responses", structuredModel());
    const names = computerCap.tools().map((t) => (t as { name?: string }).name);
    expect(names).toEqual(FUNCTION_TOOL_NAMES);
  });

  test("explicit computerToolMode is threaded to the capability and OVERRIDES the bound-model sniff", async () => {
    const desktopOn = testSettings({ sandboxBackend: "modal", sandboxDesktopEnabled: true, computerUseEnabled: true });

    // "hosted" → the attached capability emits the hosted tool EVEN with a
    // ChatCompletions model bound (the sniff alone would pick function tools).
    const hostedCaps = buildAgentCapabilities(desktopOn, [], { computerToolMode: "hosted" });
    const hostedCap = hostedCaps.find((c) => (c as { type?: string }).type === "computer-use") as unknown as ComputerUseCapability;
    const { session: s1 } = makeMockSession();
    hostedCap.bind(s1 as never).bindModel("gpt", chatCompletionsModel());
    const hostedTools = hostedCap.tools();
    expect(hostedTools.length).toBe(1);
    expect((hostedTools[0] as { type?: string }).type).toBe("computer");

    // "function-text" → the FUNCTION tools EVEN with a structured model bound, and the
    // screenshot renders as a text data-URL (imageFunctionResults=false).
    const textCaps = buildAgentCapabilities(desktopOn, [], { computerToolMode: "function-text" });
    const textCap = textCaps.find((c) => (c as { type?: string }).type === "computer-use") as unknown as ComputerUseCapability;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { session: s2 } = makeMockSession({ pngBytes: png });
    textCap.bind(s2 as never).bindModel("responses", structuredModel());
    const textTools = textCap.tools();
    expect(textTools.map((t) => (t as { name?: string }).name)).toEqual(FUNCTION_TOOL_NAMES);
    const shot = toolsByName(textTools).computer_screenshot;
    expect(await invokeTool(shot, {})).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);

    // "function-image" → the FUNCTION tools with a STRUCTURED image screenshot.
    const imgCaps = buildAgentCapabilities(desktopOn, [], { computerToolMode: "function-image" });
    const imgCap = imgCaps.find((c) => (c as { type?: string }).type === "computer-use") as unknown as ComputerUseCapability;
    const { session: s3 } = makeMockSession({ pngBytes: png });
    imgCap.bind(s3 as never).bindModel("responses", structuredModel());
    const imgShot = toolsByName(imgCap.tools()).computer_screenshot;
    const imgOut = (await invokeTool(imgShot, {})) as { type?: string; image?: { mediaType?: string } };
    expect(imgOut.type).toBe("image");
    expect(imgOut.image?.mediaType).toBe("image/png");
  });

  test("codex path threads imageFunctionResults:true → the emitted computer_screenshot returns a structured image", async () => {
    const desktopOn = testSettings({ sandboxBackend: "modal", sandboxDesktopEnabled: true, computerUseEnabled: true });
    const codexCaps = buildAgentCapabilities(desktopOn, [], { structuredToolTransport: false });
    const computerCap = codexCaps.find((c) => (c as { type?: string }).type === "computer-use") as unknown as ComputerUseCapability;
    // A MODAL mock session → SandboxComputer; its base64 screenshot read returns PNG bytes.
    const { session } = makeMockSession({ pngBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    computerCap.bind(session as never).bindModel("responses", structuredModel());
    const screenshotTool = computerCap.tools().find((t) => (t as { name?: string }).name === "computer_screenshot");
    const out = (await invokeTool(screenshotTool, {})) as { type?: string; image?: { mediaType?: string } };
    // Structured image (codex sees it), NOT the text data-URL string.
    expect(out.type).toBe("image");
    expect(out.image?.mediaType).toBe("image/png");
  });
});
