import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { testSettings } from "@opengeni/testing";
import { buildAgentCapabilities, buildOpenGeniAgent } from "../src/index";
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
  ScreenshotReadError,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_READ_CHUNKS,
  SCREENSHOT_READ_CHUNK_BYTES,
  type NativeDesktopSession,
} from "../src/sandbox-computer";
import { RoutingSandboxSession } from "../src/sandbox";
import {
  KeyAction,
  PointerAction,
  PointerButton,
  type DesktopInputRequest,
} from "@opengeni/agent-proto";

// The SDK reads hosted-vs-function transport from the bound model instance's
// constructor name (supportsStructuredToolOutputTransport): a name containing
// "ChatCompletions" (and an UNBOUND model) → text/function transport; anything else
// → structured/hosted. These two fakes make the branch explicit in the tests.
class OpenAIResponsesModel {
  readonly transport = "responses";
}
class OpenAIChatCompletionsModel {
  readonly transport = "chat-completions";
}
/** A structured-transport model instance → ComputerUseCapability emits the HOSTED tool. */
const structuredModel = (): never => new OpenAIResponsesModel() as never;
/** A ChatCompletions-family instance → ComputerUseCapability emits the FUNCTION tools. */
const chatCompletionsModel = (): never => new OpenAIChatCompletionsModel() as never;

// A fake Computer that records every method call so the function-tool routing can be
// asserted without a real desktop. Cast to the SDK `Computer` at the call site.
function makeFakeComputer(opts: { screenshotB64?: string } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const defaultB64 = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])).toString(
    "base64",
  );
  const computer = {
    environment: "ubuntu" as const,
    dimensions: [1280, 800] as [number, number],
    screenshot: async () => {
      calls.push(["screenshot"]);
      return opts.screenshotB64 ?? defaultB64;
    },
    click: async (x: number, y: number, button: string) => {
      calls.push(["click", x, y, button]);
    },
    doubleClick: async (x: number, y: number) => {
      calls.push(["doubleClick", x, y]);
    },
    move: async (x: number, y: number) => {
      calls.push(["move", x, y]);
    },
    scroll: async (x: number, y: number, sx: number, sy: number) => {
      calls.push(["scroll", x, y, sx, sy]);
    },
    type: async (text: string) => {
      calls.push(["type", text]);
    },
    keypress: async (keys: string[]) => {
      calls.push(["keypress", keys]);
    },
    drag: async (path: [number, number][]) => {
      calls.push(["drag", path]);
    },
    wait: async () => {},
  };
  return { computer, calls };
}

// Index a tool array by name, and invoke a function tool the SDK way (JSON-string
// input through `.invoke(runContext, input)`).
const toolsByName = (tools: unknown[]): Record<string, unknown> =>
  Object.fromEntries((tools as Array<{ name: string }>).map((t) => [t.name, t]));
const invokeTool = (t: unknown, args: unknown): Promise<unknown> =>
  (t as { invoke: (ctx: never, input: string) => Promise<unknown> }).invoke(
    {} as never,
    JSON.stringify(args),
  );
const FUNCTION_TOOL_NAMES = [
  "computer_screenshot",
  "computer_click",
  "computer_double_click",
  "computer_move",
  "computer_scroll",
  "computer_type",
  "computer_keypress",
  "computer_drag",
];

// A mock provider session that records every command. By default it mimics
// MODAL: it implements execCommand (the formatted-string contract) and does NOT
// implement exec — the F1 trap the impl must survive. The screenshot read is now a
// `base64 <path>` over execCommand (NOT readFile — Modal's readFile rejects the
// /tmp scrot as "escapes the workspace root"), so the mock returns the PNG bytes
// base64'd INSIDE the execCommand banner for `base64 …` commands.
function makeMockSession(
  opts: {
    withExec?: boolean; // if true, also implement the structured exec object path
    pngBytes?: Uint8Array; // bytes the screenshot read returns (base64'd over exec)
    failExit?: number; // non-zero exit for the next exec (F2 error detection)
    stillRunning?: boolean; // simulate a yield-without-finish (F3)
    // PNG bytes PER scrot attempt — models a cold :0 that paints on a later
    // retry (e.g. [empty, empty, valid] self-heals on attempt 3). Overrides pngBytes.
    pngBytesPerAttempt?: Uint8Array[];
    // Simulate the Modal exec-output cap truncating EACH `dd … | base64` chunk to at most
    // this many decoded bytes — the read then reconstructs short and must fail LOUD.
    truncateChunkBytes?: number;
    // Override the exact wc stdout body to exercise strict parsing and hard bounds.
    sizeOutput?: string | ((actualSize: number) => string);
    // Make cleanup return a settled nonzero result so primary-error settlement can prove
    // cleanup was attempted without being masked by a second failure.
    cleanupExit?: number;
    // Model the RoutingSandboxSession fronting a Modal box: it EXPOSES an `exec` method
    // (so typeof session.exec === "function"), but for a Modal backend that method falls
    // back to execCommand and returns the formatted banner STRING — NOT a {output} object.
    proxyExecString?: boolean;
  } = {},
) {
  const execCalls: string[] = [];
  // The execCommand contract: a FORMATTED STRING with a metadata preamble (F2).
  const formatted = (body: string, exit = 0): string =>
    `Chunk ID: abc123\nWall time: 0.01 seconds\nProcess exited with code ${exit}\nOutput:\n${body}`;
  const stillRunningStr = `Chunk ID: abc\nProcess running with session ID 7`;

  // The PNG bytes for each scrot attempt.
  let readN = 0;
  const nextAttemptBytes = (): Uint8Array => {
    if (opts.pngBytesPerAttempt) {
      const i = Math.min(readN, opts.pngBytesPerAttempt.length - 1);
      readN++;
      return opts.pngBytesPerAttempt[i]!;
    }
    return opts.pngBytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  };
  // The screenshot read is now two-phase: `wc -c < <path>` sizes the file (latching THIS
  // attempt's bytes), then `dd if=<path> bs=B skip=i count=1 | base64` reads each 3-byte-
  // aligned chunk. The mock models the box filesystem: wc -c advances to the next attempt
  // and returns its length; each dd returns the base64 of that byte-range.
  let attemptBytes: Uint8Array = new Uint8Array();
  const readBody = (cmd: string): string | null => {
    const screenshotPath = cmd.match(/\/tmp\/og-shot-[A-Za-z0-9.-]+\.png/)?.[0];
    if (screenshotPath && cmd.includes("wc -c <")) {
      attemptBytes = nextAttemptBytes();
      return typeof opts.sizeOutput === "function"
        ? opts.sizeOutput(attemptBytes.length)
        : (opts.sizeOutput ?? String(attemptBytes.length));
    }
    const cm = cmd.match(/\bdd if=.*? bs=(\d+) skip=(\d+)/);
    if (screenshotPath && cm) {
      const bs = Number(cm[1]!),
        skip = Number(cm[2]!);
      let slice = attemptBytes.slice(skip * bs, (skip + 1) * bs);
      if (opts.truncateChunkBytes !== undefined) slice = slice.slice(0, opts.truncateChunkBytes);
      return Buffer.from(slice).toString("base64");
    }
    return null;
  };

  const run = (cmd: string): string => {
    execCalls.push(cmd);
    if (cmd.includes("opengeni-desktop-up")) {
      return formatted("OPENGENI_DESKTOP_UP port=6080 geometry=1280x800 dpi=96");
    }
    const body = readBody(cmd);
    if (body !== null) return formatted(body);
    if (cmd.includes("rm -f --") && opts.cleanupExit !== undefined) {
      return formatted("", opts.cleanupExit);
    }
    if (opts.stillRunning) return stillRunningStr;
    return formatted("", opts.failExit ?? 0);
  };

  const session: Record<string, unknown> = {
    execCommand: async (args: { cmd: string }) => run(args.cmd),
  };
  if (opts.proxyExecString) {
    // The routing proxy's exec() resolves to the execCommand banner STRING (Modal has
    // no native exec). readCmdRaw must banner-strip it, NOT feed it to
    // sandboxCommandOutput (which returns "" for a string).
    session.exec = async (args: { cmd: string }) => run(args.cmd);
  } else if (opts.withExec) {
    session.exec = async (args: { cmd: string }) => {
      execCalls.push(args.cmd);
      const body = readBody(args.cmd);
      if (body !== null) {
        // The exec-object path exposes a structured stdout body (no banner).
        return { output: body, stdout: "", stderr: "", exitCode: 0 };
      }
      if (opts.stillRunning) return { output: "", stdout: "", stderr: "", sessionId: 7 };
      return {
        output: "",
        stdout: "",
        stderr: "",
        exitCode: opts.failExit ?? 0,
        wallTimeSeconds: 0.01,
      };
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
    // scrot wrote the /tmp file, then the read was size-then-chunk over the command
    // primitive — the /tmp path that ISN'T workspace-root-validated, NOT readFile.
    expect(execCalls.some((cmd) => cmd.includes("scrot --pointer --overwrite"))).toBe(true);
    // The read sizes the file (`wc -c`) then base64s it in `dd … | base64` chunks — the
    // chunked form that stays under Modal's exec-output cap (a single `base64 <file>`
    // silently empties a full-frame read).
    expect(execCalls.some((cmd) => cmd.includes("wc -c <") && cmd.includes("/tmp/og-shot-"))).toBe(
      true,
    );
    const chunkReads = execCalls.filter(
      (cmd) => cmd.includes("dd if=") && cmd.includes("/tmp/og-shot-") && cmd.includes("| base64"),
    );
    expect(chunkReads.length).toBe(1); // a 6-byte PNG is a single chunk
    // The temp file is cleaned up.
    expect(execCalls.some((cmd) => cmd.includes("rm -f --") && cmd.includes("/tmp/og-shot-"))).toBe(
      true,
    );
  });

  test("400-FIX: the exec-object provider path also reads the PNG via the chunked read (structured stdout body)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { session, execCalls } = makeMockSession({ withExec: true, pngBytes: png });
    const c = new SandboxComputer(session as never);
    const shot = await c.screenshot();
    expect(shot).toBe(Buffer.from(png).toString("base64"));
    expect(execCalls.some((cmd) => cmd.includes("wc -c <") && cmd.includes("/tmp/og-shot-"))).toBe(
      true,
    );
    expect(
      execCalls.some(
        (cmd) =>
          cmd.includes("dd if=") && cmd.includes("/tmp/og-shot-") && cmd.includes("| base64"),
      ),
    ).toBe(true);
  });

  test("ROUTING-PROXY-FIX: a proxy exec() that returns the execCommand banner STRING is banner-stripped, not dropped to ''", async () => {
    // The RoutingSandboxSession (selfhosted enabled) fronting a Modal box exposes `exec`,
    // but it resolves to the formatted execCommand STRING. A naive
    // sandboxCommandOutput(string) === "" made `wc -c` read as 0 → empty frame → the
    // "display not up" error card on EVERY Modal computer-use turn. Multi-chunk so the
    // chunked dd|base64 reads also flow through the string path.
    const png = new Uint8Array(250_000);
    for (let i = 0; i < png.length; i++) png[i] = (i * 2654435761) & 0xff;
    const { session, execCalls } = makeMockSession({ proxyExecString: true, pngBytes: png });
    const c = new SandboxComputer(session as never);
    const shot = await c.screenshot();
    expect(shot).toBe(Buffer.from(png).toString("base64")); // full frame, byte-exact — NOT empty
    // Drove the read through the exec() (proxy string) path, not execCommand directly.
    expect(execCalls.some((cmd) => cmd.includes("wc -c <") && cmd.includes("/tmp/og-shot-"))).toBe(
      true,
    );
    expect(
      execCalls.filter(
        (cmd) =>
          cmd.includes("dd if=") && cmd.includes("/tmp/og-shot-") && cmd.includes("| base64"),
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("ROUTING-PROXY-FIX: an execCommand-only backend does not duplicate machine-parsed stdout", async () => {
    const png = new Uint8Array(250_000);
    for (let i = 0; i < png.length; i++) png[i] = (i * 31 + 7) & 0xff;
    const { session, execCalls } = makeMockSession({ pngBytes: png });
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({
        session: session as never,
        sandboxId: null,
        kind: "modal",
      }),
    });

    // RoutingSandboxSession.exec() preserves the Modal banner body in both
    // `output` and `stdout`. Screenshot parsing must select stdout once rather
    // than feed the display-oriented aggregate into the strict integer parser.
    const c = new SandboxComputer(proxy as never);
    const shot = await c.screenshot();

    expect(shot).toBe(Buffer.from(png).toString("base64"));
    expect(
      execCalls.filter(
        (cmd) =>
          cmd.includes("dd if=") && cmd.includes("/tmp/og-shot-") && cmd.includes("| base64"),
      ).length,
    ).toBe(3);
  });

  // ── The exec-output-cap fix: a fully-painted 1280x800 desktop PNG (~222 KB) base64s
  // to ~296 KB, which trips Modal's exec-stdout buffer cap and silently returns "" from a
  // single `base64 <file>` — the blank-frame incident. The chunked read reconstructs the
  // FULL frame from cap-safe pieces, and a truncated chunk fails LOUD (never a blank). ──
  test("CAP-FIX: a large multi-chunk PNG reconstructs byte-exactly from `dd … | base64` chunks", async () => {
    // 250 KB — larger than one 96 KiB chunk (3 chunks), and past the ~256 KB cap for a
    // single read. Deterministic pseudo-random bytes so a mis-sliced chunk would corrupt.
    const png = new Uint8Array(250_000);
    for (let i = 0; i < png.length; i++) png[i] = (i * 31 + 7) & 0xff;
    const { session, execCalls } = makeMockSession({ pngBytes: png });
    const c = new SandboxComputer(session as never);
    const shot = await c.screenshot();
    expect(shot).toBe(Buffer.from(png).toString("base64"));
    // 250000 / 98304 = 3 chunks.
    const chunkReads = execCalls.filter(
      (cmd) => cmd.includes("dd if=") && cmd.includes("/tmp/og-shot-") && cmd.includes("| base64"),
    );
    expect(chunkReads.length).toBe(3);
  });

  test("CAP-FIX: a chunk truncated by the exec cap FAILS LOUD (ScreenshotReadError), never a silent blank", async () => {
    const png = new Uint8Array(250_000).fill(0x42);
    // Every chunk comes back truncated to 1000 bytes → the reconstruction is short.
    const { session } = makeMockSession({ pngBytes: png, truncateChunkBytes: 1000 });
    const c = new SandboxComputer(session as never, {
      screenshotWarmupBudgetMs: 30,
      screenshotRetryDelayMs: 5,
    });
    const result = await c.screenshot().then(
      (s) => ({ ok: true as const, s }),
      (e) => ({ ok: false as const, e }),
    );
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error("screenshot() resolved on a truncated read — a short frame must fail loud");
    expect(result.e).toBeInstanceOf(ScreenshotReadError);
    expect((result.e as ScreenshotReadError).code).toBe("truncated_read");
    // The message carries the expected and reconstructed byte counts for diagnosis.
    expect(String((result.e as Error).message)).toMatch(/reconstructed 1000B of 98304B/);
  });

  test("P0: strict wc parser rejects wrapper contamination, negatives, multiple values, and non-decimals without admitting a chunk", async () => {
    const malformed = [
      "Chunk ID: abc123\nWall time: 0.01\nOutput:\n4",
      "-1",
      "+1",
      "1 2",
      "1\n2",
      "1.0",
      "",
    ];
    for (const sizeOutput of malformed) {
      const { session, execCalls } = makeMockSession({ sizeOutput });
      const c = new SandboxComputer(session as never);
      const error = await c.screenshot().catch((value) => value);
      expect(error).toBeInstanceOf(ScreenshotReadError);
      expect((error as ScreenshotReadError).code).toBe("invalid_size_output");
      expect(execCalls.some((cmd) => /\bdd if=/.test(cmd))).toBe(false);
      expect(execCalls.some((cmd) => cmd.includes("rm -f --"))).toBe(true);
      // scrot + wc + cleanup: malicious size output cannot grow provider calls.
      expect(execCalls.length).toBeLessThanOrEqual(3);
    }
  });

  test("P0: strict wc parser accepts one bounded decimal with explicit space/tab/CRLF framing", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { session } = makeMockSession({ pngBytes: png, sizeOutput: " \t0004 \t\r\n" });
    const c = new SandboxComputer(session as never);
    await expect(c.screenshot()).resolves.toBe(Buffer.from(png).toString("base64"));
  });

  test("P0: huge and overflow wc values fail at the byte cap before any chunk admission", async () => {
    for (const sizeOutput of [
      String(MAX_SCREENSHOT_BYTES + 1),
      String(Number.MAX_SAFE_INTEGER),
      "9".repeat(1_000),
    ]) {
      const { session, execCalls } = makeMockSession({ sizeOutput });
      const c = new SandboxComputer(session as never);
      const error = await c.screenshot().catch((value) => value);
      expect(error).toBeInstanceOf(ScreenshotReadError);
      expect((error as ScreenshotReadError).code).toBe("size_limit_exceeded");
      expect(execCalls.some((cmd) => /\bdd if=/.test(cmd))).toBe(false);
      expect(execCalls.length).toBeLessThanOrEqual(3);
    }
  });

  test("P0: exact maximum byte/chunk boundary succeeds with a hard provider-call ceiling", async () => {
    const png = new Uint8Array(MAX_SCREENSHOT_BYTES).fill(0x5a);
    const { session, execCalls } = makeMockSession({ pngBytes: png });
    const c = new SandboxComputer(session as never, { screenshotReadbackTimeoutMs: 5_000 });
    const shot = await c.screenshot();
    expect(Buffer.from(shot, "base64").byteLength).toBe(MAX_SCREENSHOT_BYTES);
    const chunks = execCalls.filter((cmd) => /\bdd if=/.test(cmd));
    expect(chunks.length).toBe(MAX_SCREENSHOT_READ_CHUNKS);
    expect(MAX_SCREENSHOT_READ_CHUNKS).toBe(
      Math.floor((MAX_SCREENSHOT_BYTES - 1) / SCREENSHOT_READ_CHUNK_BYTES) + 1,
    );
    // Exactly scrot + wc + bounded chunks + cleanup.
    expect(execCalls.length).toBe(MAX_SCREENSHOT_READ_CHUNKS + 3);
  });

  test("P0: aggregate readback timeout aborts the in-flight provider call, admits no later chunk, and cleans up", async () => {
    const calls: Array<{ cmd: string; signal?: AbortSignal }> = [];
    const formatted = (body: string, exit = 0): string =>
      `Chunk ID: bounded\nProcess exited with code ${exit}\nOutput:\n${body}`;
    const bytes = new Uint8Array(SCREENSHOT_READ_CHUNK_BYTES * 3).fill(0x41);
    let hungSignal: AbortSignal | undefined;
    const session = {
      execCommand: async (args: { cmd: string; signal?: AbortSignal }): Promise<string> => {
        calls.push(args);
        if (args.cmd.includes("scrot --pointer")) return formatted("");
        if (args.cmd.includes("wc -c <")) return formatted(String(bytes.length));
        const chunk = args.cmd.match(/\bdd if=.* skip=(\d+)/);
        if (chunk?.[1] === "0") {
          return formatted(
            Buffer.from(bytes.slice(0, SCREENSHOT_READ_CHUNK_BYTES)).toString("base64"),
          );
        }
        if (chunk?.[1] === "1") {
          hungSignal = args.signal;
          return await new Promise<string>(() => undefined);
        }
        if (args.cmd.includes("rm -f --")) return formatted("");
        return formatted("", 75);
      },
    };
    // Keep this far below the production 15s deadline while leaving enough event-loop
    // headroom for the reserved cleanup admission under a loaded parallel test runner.
    const c = new SandboxComputer(session as never, { screenshotReadbackTimeoutMs: 200 });
    const error = await c.screenshot().catch((value) => value);
    expect(error).toBeInstanceOf(ScreenshotReadError);
    expect((error as ScreenshotReadError).code).toBe("read_timeout");
    expect(hungSignal?.aborted).toBe(true);
    expect(calls.some(({ cmd }) => /\bdd if=.* skip=2/.test(cmd))).toBe(false);
    expect(calls.some(({ cmd }) => cmd.includes("rm -f --"))).toBe(true);
    expect(calls.length).toBe(5); // scrot, wc, chunk 0, hung chunk 1, cleanup
  });

  test("P0: turn abort stops new chunk admissions and still runs remote cleanup", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const formatted = (body: string, exit = 0): string =>
      `Chunk ID: abort\nProcess exited with code ${exit}\nOutput:\n${body}`;
    const session = {
      execCommand: async (args: { cmd: string; signal?: AbortSignal }): Promise<string> => {
        calls.push(args.cmd);
        if (args.cmd.includes("scrot --pointer")) return formatted("");
        if (args.cmd.includes("wc -c <")) {
          return formatted(String(SCREENSHOT_READ_CHUNK_BYTES * 2));
        }
        if (/\bdd if=.* skip=0/.test(args.cmd)) {
          queueMicrotask(() => controller.abort(new Error("turn cancelled")));
          return await new Promise<string>(() => undefined);
        }
        if (args.cmd.includes("rm -f --")) return formatted("");
        return formatted("", 75);
      },
    };
    const c = new SandboxComputer(session as never, {
      abortSignal: controller.signal,
      screenshotReadbackTimeoutMs: 1_000,
    });
    const error = await c.screenshot().catch((value) => value);
    expect(error).toBeInstanceOf(ScreenshotReadError);
    expect((error as ScreenshotReadError).code).toBe("aborted");
    expect(calls.some((cmd) => /\bdd if=.* skip=1/.test(cmd))).toBe(false);
    expect(calls.some((cmd) => cmd.includes("rm -f --"))).toBe(true);
    expect(calls.length).toBe(4); // scrot, wc, first chunk, cleanup
  });

  test("P0: cleanup failure is recorded on the primary typed read failure without masking it", async () => {
    const { session, execCalls } = makeMockSession({
      sizeOutput: "wrapper 123 output 4",
      cleanupExit: 75,
    });
    const c = new SandboxComputer(session as never);
    const error = await c.screenshot().catch((value) => value);
    expect(error).toBeInstanceOf(ScreenshotReadError);
    expect((error as ScreenshotReadError).code).toBe("invalid_size_output");
    expect((error as ScreenshotReadError).cleanupFailed).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes("rm -f --"))).toBe(true);
  });

  test("P0: an unsettled scrot outcome is typed, cleaned, and never replayed as a warm-up retry", async () => {
    const { session, execCalls } = makeMockSession({ stillRunning: true });
    const c = new SandboxComputer(session as never, {
      screenshotWarmupBudgetMs: 100,
      screenshotRetryDelayMs: 1,
    });
    const error = await c.screenshot().catch((value) => value);
    expect(error).toBeInstanceOf(ScreenshotReadError);
    expect((error as ScreenshotReadError).code).toBe("capture_outcome_unknown");
    expect(execCalls.some((cmd) => cmd.includes("wc -c <"))).toBe(false);
    expect(execCalls.filter((cmd) => cmd.includes("scrot --pointer")).length).toBe(1);
    expect(execCalls.some((cmd) => cmd.includes("rm -f --"))).toBe(true);
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
    const c = new SandboxComputer(session as never, {
      screenshotWarmupBudgetMs: 30,
      screenshotRetryDelayMs: 5,
    });
    // Failure-sensitive: it must reject (NOT resolve to ""), so an empty image_url
    // can never reach the model.
    const result = await c.screenshot().then(
      (s) => ({ ok: true as const, s }),
      (e) => ({ ok: false as const, e }),
    );
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error(
        `screenshot() resolved to ${JSON.stringify(result.s)} — an empty image_url would 400 the model turn`,
      );
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
    const cleanups = execCalls.filter(
      (cmd) => cmd.includes("rm -f --") && cmd.includes("/tmp/og-shot-"),
    );
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
    const sentinel = "synthetic-command-text-123456";
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    const { session } = makeMockSession({ stillRunning: true });
    const c = new SandboxComputer(session as never);
    // type() must RESOLVE (not reject) so the SDK action loop exits cleanly and
    // screenshot() is called afterward.
    try {
      await expect(c.type(sentinel)).resolves.toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([
      [
        "[SandboxComputer] action command did not finish before the yield window; proceeding to screenshot",
        {
          errorClass: "ComputerActionTimeoutError",
          errorCode: "command_yield_timeout",
          origin: "sandbox-computer",
        },
      ],
    ]);
    expect(JSON.stringify(warnings)).not.toContain(sentinel);
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
    await c.drag([
      [0, 0],
      [10, 10],
      [20, 20],
    ]);
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
    screenshotImpl?: NativeDesktopSession["screenshot"];
  } = {},
) {
  const inputs: NonNullable<DesktopInputRequest["event"]>[] = [];
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  let attempt = 0;
  const at = <T>(arr: T[] | undefined, i: number): T | undefined =>
    arr ? arr[Math.min(i, arr.length - 1)] : undefined;
  const session: NativeDesktopSession = {
    desktopInput: async (event) => {
      if (event) inputs.push(event);
    },
    screenshot: async () => {
      const i = attempt++;
      if (opts.screenshotImpl) return await opts.screenshotImpl();
      const toThrow = at(opts.throwPerAttempt, i);
      if (toThrow) throw toThrow;
      return {
        png:
          at(opts.pngPerAttempt, i) ??
          opts.png ??
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
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
    expect((inputs[0] as { pointer: { button: PointerButton } }).pointer.button).toBe(
      PointerButton.POINTER_BUTTON_RIGHT,
    );
    expect((inputs[1] as { pointer: { button: PointerButton } }).pointer.button).toBe(
      PointerButton.POINTER_BUTTON_MIDDLE,
    );
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
    expect(ev.key).toEqual({
      key: "it's a test",
      isText: true,
      action: KeyAction.KEY_ACTION_PRESS,
    });
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
    await c.drag([
      [0, 0],
      [10, 10],
      [20, 20],
    ]);
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

  test("a bounded valid screenshot returns raw base64 without a data-URL prefix", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { session } = makeNativeSession({ png });
    const c = new NativeDesktopComputer(session);
    const shot = await c.screenshot();
    expect(shot).toBe(Buffer.from(png).toString("base64"));
    // Raw base64 — the SDK adds the `data:image/png;base64,` prefix itself.
    expect(shot.startsWith("data:")).toBe(false);
  });

  test("an oversized native PNG is rejected before function-image serialization", async () => {
    const { session, attempts } = makeNativeSession({
      png: new Uint8Array(MAX_SCREENSHOT_BYTES + 1),
    });
    const c = new NativeDesktopComputer(session);
    const screenshot = toolsByName(computerFunctionTools(c as never, false))["computer_screenshot"];
    const output = await invokeTool(screenshot, {});
    expect(output).toBe(
      `computer screenshot failed [size_limit_exceeded]: native screenshot byte size exceeds the ${MAX_SCREENSHOT_BYTES}B safety limit`,
    );
    expect(String(output)).not.toContain("data:image/png;base64,");
    expect(attempts()).toBe(1);
  });

  test("a stalled native provider capture fails at the aggregate readback deadline", async () => {
    const { session, attempts } = makeNativeSession({
      screenshotImpl: async () => await new Promise<never>(() => {}),
    });
    const c = new NativeDesktopComputer(session, { screenshotReadbackTimeoutMs: 10 });
    const result = await c.screenshot().then(
      () => null,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(ScreenshotReadError);
    expect((result as ScreenshotReadError).code).toBe("read_timeout");
    expect(attempts()).toBe(1);
  });

  test("repeated timeouts never accumulate native provider captures and settlement admits one fresh call", async () => {
    type Result = Awaited<ReturnType<NativeDesktopSession["screenshot"]>>;
    const resolvers: Array<(value: Result) => void> = [];
    let started = 0;
    let pending = 0;
    const { session } = makeNativeSession({
      screenshotImpl: async () => {
        started += 1;
        pending += 1;
        return await new Promise<Result>((resolve) => {
          resolvers.push((value) => {
            pending -= 1;
            resolve(value);
          });
        });
      },
    });
    const c = new NativeDesktopComputer(session, { screenshotReadbackTimeoutMs: 5 });

    const first = await c.screenshot().then(
      () => null,
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(ScreenshotReadError);
    expect((first as ScreenshotReadError).code).toBe("read_timeout");
    const second = await c.screenshot().then(
      () => null,
      (error: unknown) => error,
    );
    expect(second).toBeInstanceOf(ScreenshotReadError);
    expect((second as ScreenshotReadError).code).toBe("capture_outcome_unknown");
    expect({ started, pending }).toEqual({ started: 1, pending: 1 });

    const valid = {
      png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      width: 1280,
      height: 800,
      nativeWidth: 1280,
      nativeHeight: 800,
    };
    resolvers[0]!(valid);
    await Bun.sleep(0);

    const fresh = c.screenshot();
    expect({ started, pending }).toEqual({ started: 2, pending: 1 });
    resolvers[1]!(valid);
    await expect(fresh).resolves.toBe(Buffer.from(valid.png).toString("base64"));
    expect({ started, pending }).toEqual({ started: 2, pending: 0 });
  });

  test("an in-flight abort ignores a late native result without mutating screenshot geometry", async () => {
    const controller = new AbortController();
    let settleProvider!: (value: Awaited<ReturnType<NativeDesktopSession["screenshot"]>>) => void;
    const providerResult = new Promise<Awaited<ReturnType<NativeDesktopSession["screenshot"]>>>(
      (resolve) => {
        settleProvider = resolve;
      },
    );
    const { session, attempts, inputs } = makeNativeSession({
      screenshotImpl: async () => await providerResult,
    });
    const c = new NativeDesktopComputer(session, { abortSignal: controller.signal });
    const request = c.screenshot();
    await Promise.resolve();
    controller.abort();
    const result = await request.then(
      () => null,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(ScreenshotReadError);
    expect((result as ScreenshotReadError).code).toBe("aborted");
    expect(attempts()).toBe(1);

    settleProvider({
      png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      width: 640,
      height: 400,
      nativeWidth: 1280,
      nativeHeight: 800,
    });
    await Promise.resolve();
    await c.click(10, 20, "left");
    const event = inputs[0];
    if (event?.$case !== "pointer") throw new Error("expected pointer");
    expect([event.pointer.x, event.pointer.y]).toEqual([10, 20]);
  });

  test("REGRESSION: a persistently empty PNG THROWS (never an empty image_url / blank placeholder)", async () => {
    const { session, attempts } = makeNativeSession({ png: new Uint8Array() });
    const c = new NativeDesktopComputer(session, FAST_WARMUP);
    const result = await c.screenshot().then(
      (s) => ({ ok: true as const, s }),
      (e) => ({ ok: false as const, e }),
    );
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error(
        `screenshot() resolved to ${JSON.stringify(result.s)} — an empty image_url would 400 the model turn`,
      );
    expect(result.e).toBeInstanceOf(ComputerUnavailableError);
    // It RETRIED across the warm-up budget before failing (not a single-shot throw).
    expect(attempts()).toBeGreaterThan(1);
  });

  test("BLANK-SCREENSHOT FIX: a warming empty FIRST frame self-heals on retry (no blank placeholder)", async () => {
    // The agent's ScreenCaptureKit can hand back an empty first frame right after
    // connect; the old single-shot path turned that into a blank the model misread.
    const real = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { session, attempts } = makeNativeSession({
      pngPerAttempt: [new Uint8Array(), new Uint8Array(), real],
    });
    const c = new NativeDesktopComputer(session, FAST_WARMUP);
    const shot = await c.screenshot();
    expect(shot).toBe(Buffer.from(real).toString("base64"));
    expect(attempts()).toBe(3); // two empty misses, then the real frame
  });

  test("BLANK-SCREENSHOT FIX: a permission (TCC) denial FAILS FAST and loud — no retry, no blank", async () => {
    const sentinel = "synthetic-screen-recording-denial-123456";
    const denial = new Error(`Screen Recording permission is not granted: ${sentinel}`);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    const { session, attempts } = makeNativeSession({ throwPerAttempt: [denial] });
    const c = new NativeDesktopComputer(session, FAST_WARMUP);
    const result = await c
      .screenshot()
      .then(
        (s) => ({ ok: true as const, s }),
        (e) => ({ ok: false as const, e }),
      )
      .finally(() => {
        console.warn = originalWarn;
      });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a denied capture must throw, never resolve to a blank");
    // The AGENT's reason is surfaced verbatim (operator sees "grant Screen Recording").
    expect((result.e as Error).message).toContain("Screen Recording");
    expect((result.e as Error).message).toContain(sentinel);
    expect(JSON.stringify(warnings)).not.toContain(sentinel);
    expect(warnings[0]?.[1]).toEqual({
      errorClass: "ComputerUnavailableError",
      errorCode: "screenshot_capture_failed",
      origin: "sandbox-computer",
    });
    // Terminal denial short-circuits the warm-up budget — exactly ONE attempt.
    expect(attempts()).toBe(1);
  });

  test("screenshot public status projection tolerates hostile proxies and rethrows the exact failure", async () => {
    const sentinel = "synthetic-screenshot-hostile-status-proxy-123456";
    const source = new Error(`Screen Recording permission is not granted: ${sentinel}`);
    const exactFailure = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "status" || property === "statusCode") {
          throw new Error(`hostile public status getter: ${sentinel}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    const { session, attempts } = makeNativeSession({ throwPerAttempt: [exactFailure] });
    const computer = new NativeDesktopComputer(session, FAST_WARMUP);
    try {
      const result = await computer.screenshot().then(
        () => null,
        (error) => error,
      );
      expect(result).toBe(exactFailure);
      expect(attempts()).toBe(1);
      expect(warnings).toEqual([
        [
          "[NativeDesktopComputer] screenshot failed after the capture retry budget",
          {
            errorClass: "ComputerUnavailableError",
            errorCode: "screenshot_capture_failed",
            origin: "sandbox-computer",
          },
        ],
      ]);
      expect(JSON.stringify(warnings)).not.toContain(sentinel);
    } finally {
      console.warn = originalWarn;
    }
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
    await expect(
      c.drag([
        [0, 0],
        [1, 1],
      ]),
    ).rejects.toBeInstanceOf(ComputerReadOnlyError);
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
    const cap = computerUse({ readOnly: false, toolMode: "hosted" });
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

  test("ComputerUseCapability threads an already-aborted turn fence into native capture", async () => {
    const controller = new AbortController();
    controller.abort();
    const { session, attempts } = makeNativeSession();
    const cap = computerUse({
      abortSignal: controller.signal,
      readOnly: false,
      toolMode: "hosted",
    });
    cap.bind(session as never).bindModel("responses", structuredModel());
    const computer = (cap.tools()[0] as unknown as { computer: NativeDesktopComputer }).computer;
    const result = await computer.screenshot().then(
      () => null,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(ScreenshotReadError);
    expect((result as ScreenshotReadError).code).toBe("aborted");
    expect(attempts()).toBe(0);
  });

  test("ComputerUseCapability bound to a Modal session selects the xdotool SandboxComputer", () => {
    const { session } = makeMockSession();
    const cap = computerUse({ readOnly: false, toolMode: "hosted" });
    cap.bind(session as never).bindModel("responses", structuredModel());
    const tools = cap.tools();
    const computer = (tools[0] as unknown as { computer: unknown }).computer;
    expect(computer).toBeInstanceOf(SandboxComputer);
  });
});

describe("ComputerUseCapability (the SDK seam)", () => {
  test("tools() throws before bind(session) and returns one HOSTED computerTool on the structured transport", () => {
    const cap = computerUse({ readOnly: false, toolMode: "hosted" });
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

describe("ComputerUseCapability omitted transport fails closed", () => {
  test("unbound, chat, and responses model routes cannot expose screenshot tools or base64 text", () => {
    const { session: unprovenSession } = makeMockSession();
    const unproven = computerUse({});
    unproven.bind(unprovenSession as never);
    expect(unproven.tools()).toEqual([]);

    const { session: chatSession } = makeMockSession();
    const chat = computerUse({});
    chat.bind(chatSession as never).bindModel("gpt", chatCompletionsModel());
    expect(chat.tools()).toEqual([]);

    const { session: responsesSession } = makeMockSession();
    const responses = computerUse({});
    responses.bind(responsesSession as never).bindModel("responses", structuredModel());
    expect(responses.tools()).toEqual([]);
  });
});

// ── HARDENING: EXPLICIT toolMode overrides the constructor-name sniff ─────────
// The refactor adds an explicit hosted/function-image/disabled tool mode so
// tool selection is decided by the caller that knows the provider's true wire
// identity (the worker), NOT inferred from the bound model instance's constructor
// name (which a wrapped/proxied/minified instance would defeat). tools() obeys the
// explicit mode, while an absent mode fails closed.
describe("ComputerUseCapability explicit toolMode (hardening — sniff not consulted)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

  test('toolMode "function-text" fails closed with no computer tools', () => {
    const { session } = makeMockSession({ pngBytes: PNG });
    const cap = computerUse({ toolMode: "function-text" });
    cap.bind(session as never).bindModel("responses", structuredModel());
    const tools = cap.tools();
    expect(tools).toEqual([]);
  });

  test('toolMode "disabled" fails closed with no computer tools', () => {
    const { session } = makeMockSession({ pngBytes: PNG });
    const cap = computerUse({ toolMode: "disabled" });
    cap.bind(session as never).bindModel("responses", structuredModel());
    expect(cap.tools()).toEqual([]);
  });

  test("REGRESSION: ABSENT toolMode never falls through constructor sniffing", () => {
    const { session: s1 } = makeMockSession();
    const structured = computerUse({}); // no toolMode
    structured.bind(s1 as never).bindModel("responses", structuredModel());
    expect(structured.tools()).toEqual([]);

    const { session: s2 } = makeMockSession();
    const chat = computerUse({}); // no toolMode
    chat.bind(s2 as never).bindModel("gpt", chatCompletionsModel());
    expect(chat.tools()).toEqual([]);
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
    await invokeTool(t.computer_drag, {
      path: [
        { x: 0, y: 0 },
        { x: 9, y: 9 },
      ],
    });
    expect(calls).toEqual([
      ["click", 10, 20, "left"],
      ["click", 1, 2, "right"],
      ["doubleClick", 3, 4],
      ["move", 5, 6],
      ["scroll", 7, 8, 0, 300],
      ["type", "hello"],
      ["keypress", ["ctrl", "c"]],
      [
        "drag",
        [
          [0, 0],
          [9, 9],
        ],
      ],
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

  test("computer_screenshot settles a readback failure with its typed error code", async () => {
    const failure = new ScreenshotReadError(
      "invalid_size_output",
      "screenshot byte-size command returned malformed or multiple values",
    );
    const computer = {
      ...makeFakeComputer().computer,
      screenshot: async () => {
        throw failure;
      },
    };
    const screenshot = toolsByName(computerFunctionTools(computer as never, false))[
      "computer_screenshot"
    ];
    const output = await invokeTool(screenshot, {});
    expect(output).toBe(
      "computer screenshot failed [invalid_size_output]: screenshot byte-size command returned malformed or multiple values",
    );
  });

  test("readOnly returns a clear message and never touches the Computer for writes; screenshot still works", async () => {
    const { computer, calls } = makeFakeComputer();
    const t = toolsByName(computerFunctionTools(computer as never, true));
    const clickOut = await invokeTool(t.computer_click, { x: 1, y: 1 });
    const typeOut = await invokeTool(t.computer_type, { text: "x" });
    const dragOut = await invokeTool(t.computer_drag, {
      path: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    });
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
    const toolExecPath = join(
      dirname(agentsReq.resolve("@openai/agents-core")),
      "runner",
      "toolExecution.mjs",
    );
    const { getToolCallOutputItem } = (await import(toolExecPath)) as {
      getToolCallOutputItem: (
        toolCall: { name: string; callId: string },
        output: unknown,
      ) => { type: string; callId: string; output: unknown };
    };

    // 1) The tool result becomes the persisted function_call_result raw item.
    const rawItem = getToolCallOutputItem(
      { name: "computer_screenshot", callId: "call_1" },
      toolResult,
    );
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
    const t = types(
      testSettings({
        sandboxBackend: "modal",
        sandboxDesktopEnabled: true,
        computerUseEnabled: true,
      }),
    );
    expect(t).toContain("computer-use");
  });

  test("desktop OFF → no computer-use (the headless default is unchanged)", () => {
    const t = types(
      testSettings({
        sandboxBackend: "modal",
        sandboxDesktopEnabled: false,
        computerUseEnabled: true,
      }),
    );
    expect(t).not.toContain("computer-use");
  });

  test("computerUse disabled → no computer-use even with desktop on", () => {
    const t = types(
      testSettings({
        sandboxBackend: "modal",
        sandboxDesktopEnabled: true,
        computerUseEnabled: false,
      }),
    );
    expect(t).not.toContain("computer-use");
  });

  test("a non-desktop backend never gets computer-use (runtime contract: honest gate)", () => {
    const t = types(
      testSettings({
        sandboxBackend: "none",
        sandboxDesktopEnabled: true,
        computerUseEnabled: true,
      }),
    );
    expect(t).not.toContain("computer-use");
  });

  test("structuredToolTransport alone is not proof: omitted computer mode stays attached but exposes no tools", () => {
    const desktopOn = testSettings({
      sandboxBackend: "modal",
      sandboxDesktopEnabled: true,
      computerUseEnabled: true,
    });
    // Computer-use remains represented as a capability so explicit worker modes can
    // activate it, but public construction without a proven mode exposes no tools.
    expect(
      buildAgentCapabilities(desktopOn, []).map((c) => (c as { type?: string }).type),
    ).toContain("computer-use");
    const codexCaps = buildAgentCapabilities(desktopOn, [], { structuredToolTransport: false });
    const codexTypes = codexCaps.map((c) => (c as { type?: string }).type);
    expect(codexTypes).toContain("computer-use");
    // filesystem/shell still present (unchanged).
    expect(codexTypes).toContain("filesystem");
    expect(codexTypes).toContain("shell");
    // Neither the filesystem transport option nor a model constructor proves a
    // screenshot transport for computer use.
    const computerCap = codexCaps.find(
      (c) => (c as { type?: string }).type === "computer-use",
    ) as unknown as ComputerUseCapability;
    const { session } = makeMockSession();
    computerCap.bind(session as never).bindModel("responses", structuredModel());
    expect(computerCap.tools()).toEqual([]);
  });

  test("explicit computerToolMode is threaded to the capability and OVERRIDES the bound-model sniff", async () => {
    const desktopOn = testSettings({
      sandboxBackend: "modal",
      sandboxDesktopEnabled: true,
      computerUseEnabled: true,
    });

    // "hosted" → the attached capability emits the hosted tool EVEN with a
    // ChatCompletions model bound (the sniff alone would pick function tools).
    const hostedCaps = buildAgentCapabilities(desktopOn, [], { computerToolMode: "hosted" });
    const hostedCap = hostedCaps.find(
      (c) => (c as { type?: string }).type === "computer-use",
    ) as unknown as ComputerUseCapability;
    const { session: s1 } = makeMockSession();
    hostedCap.bind(s1 as never).bindModel("gpt", chatCompletionsModel());
    const hostedTools = hostedCap.tools();
    expect(hostedTools.length).toBe(1);
    expect((hostedTools[0] as { type?: string }).type).toBe("computer");

    // "function-text" is a deprecated fail-closed alias: providers without a proven
    // visual image transport receive no computer capability.
    const textCaps = buildAgentCapabilities(desktopOn, [], { computerToolMode: "function-text" });
    const textCap = textCaps.find(
      (c) => (c as { type?: string }).type === "computer-use",
    ) as unknown as ComputerUseCapability;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { session: s2 } = makeMockSession({ pngBytes: png });
    textCap.bind(s2 as never).bindModel("responses", structuredModel());
    const textTools = textCap.tools();
    expect(textTools).toEqual([]);

    // "function-image" → the FUNCTION tools with a STRUCTURED image screenshot.
    const imgCaps = buildAgentCapabilities(desktopOn, [], { computerToolMode: "function-image" });
    const imgCap = imgCaps.find(
      (c) => (c as { type?: string }).type === "computer-use",
    ) as unknown as ComputerUseCapability;
    const { session: s3 } = makeMockSession({ pngBytes: png });
    imgCap.bind(s3 as never).bindModel("responses", structuredModel());
    const imgShot = toolsByName(imgCap.tools()).computer_screenshot;
    const imgOut = (await invokeTool(imgShot, {})) as {
      type?: string;
      image?: { mediaType?: string };
    };
    expect(imgOut.type).toBe("image");
    expect(imgOut.image?.mediaType).toBe("image/png");
  });

  test("buildOpenGeniAgent omitted mode cannot expose screenshot base64 on a chat/unproven route", () => {
    const desktopOn = testSettings({
      sandboxBackend: "modal",
      sandboxDesktopEnabled: true,
      computerUseEnabled: true,
    });
    const agent = buildOpenGeniAgent(desktopOn, [], { structuredToolTransport: false });
    const computerCap = ((agent as unknown as { capabilities: unknown[] }).capabilities ?? []).find(
      (c) => (c as { type?: string }).type === "computer-use",
    ) as unknown as ComputerUseCapability;
    const { session } = makeMockSession({
      pngBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    computerCap.bind(session as never).bindModel("gpt", chatCompletionsModel());
    expect(computerCap.tools()).toEqual([]);
  });
});

describe("lazy computer-use preparation", () => {
  test("advertising tools is side-effect free; first action starts :0 once, then invokes onReady", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      sandboxDesktopEnabled: true,
      computerUseEnabled: true,
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { session, execCalls } = makeMockSession({ pngBytes: png });
    const readySessions: unknown[] = [];
    const caps = buildAgentCapabilities(settings, [], {
      computerToolMode: "function-image",
      onComputerUseReady: async (readySession) => {
        expect(execCalls.some((cmd) => cmd.includes("opengeni-desktop-up"))).toBe(true);
        readySessions.push(readySession);
      },
    });
    const cap = caps.find(
      (candidate) => (candidate as { type?: string }).type === "computer-use",
    ) as unknown as ComputerUseCapability;
    cap.bind(session as never).bindModel("responses", structuredModel());

    const tools = cap.tools();
    expect(execCalls).toHaveLength(0);
    expect(readySessions).toHaveLength(0);

    const screenshot = toolsByName(tools).computer_screenshot;
    await invokeTool(screenshot, {});
    await invokeTool(screenshot, {});

    expect(execCalls.filter((cmd) => cmd.includes("opengeni-desktop-up"))).toHaveLength(1);
    expect(readySessions).toEqual([session]);
  });

  test("a failed preparation retries on the next action without re-running cleanup preparation", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { session, execCalls } = makeMockSession({ pngBytes: png });
    let attempts = 0;
    const computer = new SandboxComputer(session, {
      screenshotWarmupBudgetMs: 1,
      screenshotRetryDelayMs: 1,
      prepare: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("display startup failed");
      },
    });

    await expect(computer.screenshot()).rejects.toThrow("display startup failed");
    expect(attempts).toBe(1);
    expect(execCalls).toHaveLength(0);

    expect(await computer.screenshot()).not.toBe("");
    expect(attempts).toBe(2);
  });
});
