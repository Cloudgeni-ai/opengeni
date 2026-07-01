import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { buildAgentCapabilities } from "../src/index";
import {
  SandboxComputer,
  ComputerUseCapability,
  computerUse,
  ComputerReadOnlyError,
  ComputerUnavailableError,
  ComputerActionError,
} from "../src/sandbox-computer";

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
    const c = new SandboxComputer(session as never);
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

describe("ComputerUseCapability (the SDK seam)", () => {
  test("tools() throws before bind(session) and returns one computerTool after", () => {
    const cap = computerUse({ readOnly: false });
    expect(cap).toBeInstanceOf(ComputerUseCapability);
    expect(cap.type).toBe("computer-use");
    // Unbound → requireBoundSession throws.
    expect(() => cap.tools()).toThrow();
    const { session } = makeMockSession();
    cap.bind(session as never);
    const tools = cap.tools();
    expect(tools.length).toBe(1);
    // The computer tool wires the model's computer_use_preview surface.
    expect((tools[0] as { type?: string }).type).toBe("computer");
  });
});

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

  test("codex path (structuredToolTransport:false): NO computer-use even with desktop fully on — the hosted computer tool has no function fallback and would 400 the whole turn", () => {
    const desktopOn = testSettings({ sandboxBackend: "modal", sandboxDesktopEnabled: true, computerUseEnabled: true });
    // Same settings that DO attach computer-use on every other backend...
    expect(buildAgentCapabilities(desktopOn, []).map((c) => (c as { type?: string }).type)).toContain("computer-use");
    // ...are suppressed on the codex backend, which rejects the hosted computer tool.
    const onCodex = buildAgentCapabilities(desktopOn, [], { structuredToolTransport: false }).map((c) => (c as { type?: string }).type);
    expect(onCodex).not.toContain("computer-use");
    // filesystem/shell/skills still present — only the unsupported hosted tool is dropped.
    expect(onCodex).toContain("filesystem");
    expect(onCodex).toContain("shell");
  });
});
