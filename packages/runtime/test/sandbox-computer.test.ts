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
// MODAL: it implements execCommand (the formatted-string contract) + readFile,
// and does NOT implement exec — the F1 trap the impl must survive.
function makeMockSession(opts: {
  withExec?: boolean; // if true, also implement the structured exec object path
  pngBytes?: Uint8Array; // bytes readFile returns for the screenshot
  failExit?: number; // non-zero exit for the next exec (F2 error detection)
  stillRunning?: boolean; // simulate a yield-without-finish (F3)
} = {}) {
  const execCalls: string[] = [];
  const readFileCalls: { path: string; maxBytes?: number }[] = [];
  // The execCommand contract: a FORMATTED STRING with a metadata preamble (F2).
  const formatted = (body: string, exit = 0): string =>
    `Chunk ID: abc123\nWall time: 0.01 seconds\nProcess exited with code ${exit}\nOutput:\n${body}`;
  const stillRunningStr = `Chunk ID: abc\nProcess running with session ID 7`;

  const run = (cmd: string): string => {
    execCalls.push(cmd);
    if (opts.stillRunning) return stillRunningStr;
    return formatted("", opts.failExit ?? 0);
  };

  const session: Record<string, unknown> = {
    execCommand: async (args: { cmd: string }) => run(args.cmd),
    readFile: async (args: { path: string; maxBytes?: number }) => {
      readFileCalls.push({ path: args.path, ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes } : {}) });
      return opts.pngBytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    },
  };
  if (opts.withExec) {
    session.exec = async (args: { cmd: string }) => {
      execCalls.push(args.cmd);
      if (opts.stillRunning) return { output: "", stdout: "", stderr: "", sessionId: 7 };
      return { output: "", stdout: "", stderr: "", exitCode: opts.failExit ?? 0, wallTimeSeconds: 0.01 };
    };
  }
  return { session, execCalls, readFileCalls };
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

  test("F2: screenshot reads the PNG via readFile (NOT base64-via-execCommand), returns clean base64", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const { session, execCalls, readFileCalls } = makeMockSession({ pngBytes: png });
    const c = new SandboxComputer(session as never);
    const shot = await c.screenshot();
    // The screenshot bytes came from readFile, base64'd in JS — NO preamble.
    expect(shot).toBe(Buffer.from(png).toString("base64"));
    expect(readFileCalls.length).toBe(1);
    expect(readFileCalls[0]!.path).toMatch(/\/tmp\/og-shot-.*\.png$/);
    // scrot wrote the file; the screenshot was NOT a `base64 -w0` exec (F2).
    expect(execCalls.some((c) => c.includes("scrot --pointer --overwrite"))).toBe(true);
    expect(execCalls.some((c) => /base64/.test(c))).toBe(false);
    // The temp file is cleaned up.
    expect(execCalls.some((c) => c.includes("rm -f /tmp/og-shot-"))).toBe(true);
  });

  test("F2: nonzero exit is DETECTED via the preamble parser (not a silent success)", async () => {
    const { session } = makeMockSession({ failExit: 4 });
    const c = new SandboxComputer(session as never);
    await expect(c.click(1, 1, "left")).rejects.toBeInstanceOf(ComputerActionError);
  });

  test("F3: a 'still running' yield is a retriable failure, not a success", async () => {
    const { session } = makeMockSession({ stillRunning: true });
    const c = new SandboxComputer(session as never);
    await expect(c.move(5, 5)).rejects.toBeInstanceOf(ComputerActionError);
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
});
