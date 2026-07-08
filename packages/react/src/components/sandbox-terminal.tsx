import type { TerminalCapability } from "@opengeni/sdk";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useTerminalStream } from "../hooks/use-terminal-stream";
import type { UseSandboxTerminalResult } from "../hooks/use-sandbox-terminal";
import { resolveTerminalFont, xtermThemeFromTokens } from "../lib/xterm-theme";
import { attachRenderer, type RendererLoaders, type RendererTier } from "../lib/xterm-renderer";

/**
 * A COMPLETE xterm `ITheme` (subset by intent, but every field xterm colors a
 * cell with is present so it never falls back to its stock VGA palette). Built
 * from the og tokens via `xtermThemeFromTokens`.
 */
export type XtermTheme = {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
};

export type SandboxTerminalProps = {
  /** From `useSandboxTerminal(...)`. */
  result: UseSandboxTerminalResult;
  /**
   * The negotiated Terminal capability cell. When it advertises `transport:
   * "pty-ws"` + a live `url` (a warm box with a viewer attached), the terminal is
   * driven by a REAL bidirectional PTY over the Modal tunnel (ttyd-over-websocket)
   * INSTEAD of the broken ptyWrite-over-HTTP path: xterm input → the socket, the
   * socket's output → xterm, xterm resize → the socket. On a cold box / no url
   * (`transport: "sse-events"`) it stays on the read-only Channel-A firehose
   * (`result.chunks`). Omit to force the legacy firehose-only behavior.
   */
  terminalCapability?: TerminalCapability | null | undefined;
  /**
   * Full xterm theme. When omitted the terminal self-derives it from the `--og-*`
   * tokens of its own container (correct even inside a nested `data-og-theme`
   * subtree). Passing it lets the host drive re-theme on a theme flip.
   */
  theme?: XtermTheme | undefined;
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
  /**
   * Lease liveness (`cold` | `warming` | `warm` | `draining`). Drives the
   * boot-in-terminal status lines: once the user has focused the terminal and
   * the box is not yet warm, a styled "● waking machine — Ns…" line is rendered
   * INSIDE xterm (no overlay/spinner) until the live PTY connects.
   */
  liveness?: string | undefined;
  /**
   * Force read-only even when the PTY accepts stdin. Default: interactive
   * whenever a live pty-ws stream is connected OR `result.write !== null` (the box
   * advertises an interactive PTY); otherwise the read-only agent firehose.
   */
  readOnly?: boolean | undefined;
  /** Shown on the server / before xterm hydrates (SSR-safe placeholder). */
  placeholder?: ReactNode | undefined;
  /** Render the small status header (pty/shell + running dot + read-only pill). */
  showHeader?: boolean | undefined;
  /** Shell label for the header (e.g. `/bin/bash`). */
  shell?: string | undefined;
  /**
   * Fired the first time the user engages the terminal surface (focus or click).
   * The host wires this to warm the box for the REAL pty-ws terminal (the viewer
   * attach), so a cold box upgrades from the read-only firehose to a live PTY ON
   * INTERACT — never on mere mount (which would force a box spin-up and regress
   * the firehose-only default).
   */
  onActivate?: (() => void) | undefined;
  className?: string | undefined;
};

// The xterm.js handle the effect owns. `any`-free structural shape so we can
// drive it without a hard type dep on the lazily-imported lib.
type XtermLike = {
  open: (el: HTMLElement) => void;
  write: (data: string) => void;
  clear: () => void;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  onResize: (cb: (size: { cols: number; rows: number }) => void) => { dispose: () => void };
  loadAddon: (addon: unknown) => void;
  dispose: () => void;
  cols: number;
  rows: number;
  options: {
    theme?: XtermTheme;
    disableStdin?: boolean;
    cursorBlink?: boolean;
    fontFamily?: string;
    fontSize?: number;
  };
};
type FitAddonLike = { fit: () => void };

/** Debug seam (dev/evidence only, never a typed public API): a global hook the
 *  screenshot harness reads to probe the settled renderer tier + resolved font
 *  without mounting a real WebGL context in unit tests. */
type TerminalDebugInfo = {
  renderer: RendererTier | null;
  fontFamily: string | undefined;
  fontSize: number | undefined;
  hasVarInFont: boolean;
  theme: XtermTheme | undefined;
};
declare global {
  // eslint-disable-next-line no-var
  var __OG_TERMINAL_DEBUG__: ((info: TerminalDebugInfo) => void) | undefined;
  // A space/comma list of renderer tiers to force-fail, so the demo can prove the
  // WebGL→canvas→DOM fallback ladder without a real GPU context loss.
  // eslint-disable-next-line no-var
  var __OG_FORCE_RENDERER_FAIL__: string | undefined;
}

/** Which renderer tiers are force-failed (demo/evidence only). */
function forcedRendererFailures(): Set<RendererTier> {
  const raw = typeof globalThis !== "undefined" ? globalThis.__OG_FORCE_RENDERER_FAIL__ : undefined;
  const set = new Set<RendererTier>();
  if (typeof raw === "string") {
    for (const tier of raw.split(/[\s,]+/)) {
      if (tier === "webgl" || tier === "canvas") set.add(tier);
    }
  }
  return set;
}

/**
 * An xterm.js terminal fed by the Channel-A event projection
 * (`useSandboxTerminal`) or a live ttyd PTY. xterm + its addons are lazy-imported
 * inside an effect, so SSR renders the placeholder and the terminal mounts on
 * hydration.
 *
 * Renderer: WebGL (GPU-composited cells) with a canvas → DOM fallback ladder
 * (`attachRenderer`), so bursty output stays smooth but a lost/blocklisted
 * context degrades gracefully. Font + theme are resolved to CONCRETE values
 * from the og tokens BEFORE construction (xterm measures glyphs in a canvas
 * where `var()` never resolves, and colors every cell from a full ANSI palette).
 *
 * The terminal is mounted ONCE and its data source is swapped in place: the
 * read-only firehose (`result.chunks`) → the live PTY. Stdin is toggled via
 * `term.options.disableStdin` at runtime (not a remount), so scrollback and the
 * visible screen survive the projection→PTY handoff.
 *
 * Resizes are tracked with a `ResizeObserver` on the container (not just
 * `window.resize`) so dragging the dock handle refits the grid.
 */
export function SandboxTerminal({
  result,
  terminalCapability,
  theme,
  fontFamily,
  fontSize,
  liveness,
  readOnly,
  placeholder,
  showHeader,
  shell,
  onActivate,
  className,
}: SandboxTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XtermLike | null>(null);
  const fitRef = useRef<FitAddonLike | null>(null);
  const rendererRef = useRef<RendererTier | null>(null);
  const writtenRef = useRef<Set<string>>(new Set());
  const wroteFirehoseRef = useRef(false);
  const bootActiveRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [activated, setActivated] = useState(false);

  // ── Interactive transport switch ─────────────────────────────────────────────
  const ptyWs = terminalCapability?.transport === "pty-ws" && Boolean(terminalCapability?.url);
  // Output frames buffer here until xterm has mounted; the write effect drains it.
  const ptyOutputQueueRef = useRef<string[]>([]);
  const ptyStream = useTerminalStream({
    capability: ptyWs
      ? {
          transport: terminalCapability!.transport,
          url: terminalCapability!.url,
          token: terminalCapability!.token,
        }
      : null,
    onOutput: (data) => {
      const term = termRef.current;
      if (term) term.write(data);
      else ptyOutputQueueRef.current.push(data);
    },
  });

  // PTY mode = a live ttyd socket drives the screen. Firehose mode = the
  // read-only projection (or the legacy HTTP-write fallback).
  const ptyMode = ptyWs && ptyStream.status !== "closed";
  const interactive = !readOnly && (ptyMode || result.write !== null);

  // Boot-in-terminal: after the user focuses a not-yet-warm box, show styled
  // status lines INSIDE xterm instead of an overlay — but only when there is no
  // firehose transcript to show yet (otherwise the projected output is shown).
  const warm = liveness === "warm" || liveness === "draining";
  const booting = activated && !ptyMode && !warm && liveness != null && result.chunks.length === 0;

  function handleActivate() {
    if (!activated) setActivated(true);
    onActivate?.();
  }

  // Mount xterm once (client-only). Never re-mounts on interactive/theme flips —
  // stdin + theme are runtime options synced by the effects below, so the visible
  // screen survives the projection→PTY handoff (E5).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    // Wait for a real measured size before opening xterm so the first fit is at
    // the true width (belt-and-braces with the visibility gate below).
    const waitForSize = (node: HTMLElement) =>
      new Promise<void>((resolve) => {
        if (node.clientWidth > 0 && node.clientHeight > 0) return resolve();
        const ro = new ResizeObserver(() => {
          if (node.clientWidth > 0 && node.clientHeight > 0) {
            ro.disconnect();
            resolve();
          }
        });
        ro.observe(node);
        setTimeout(() => {
          ro.disconnect();
          resolve();
        }, 1000);
      });

    ensureXtermBaseCss();

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (disposed) return;
      await waitForSize(el);
      if (disposed) return;

      // Resolve font + theme to CONCRETE values BEFORE construction. `var()` in a
      // font family never resolves in xterm's canvas measurement, so we read the
      // computed `--og-font-mono` here; the theme is a full ANSI palette.
      const font = resolveTerminalFont(el, { fontFamily, fontSize });
      const initialTheme = theme ?? xtermThemeFromTokens(el);

      const term = new Terminal({
        convertEol: true,
        disableStdin: !interactive,
        cursorBlink: interactive,
        fontFamily: font.fontFamily,
        fontSize: font.fontSize,
        lineHeight: font.lineHeight,
        ...(initialTheme ? { theme: initialTheme } : {}),
      }) as unknown as XtermLike;
      const fit = new FitAddon() as unknown as FitAddonLike;
      term.loadAddon(fit);
      term.loadAddon(
        new WebLinksAddon((_e: MouseEvent, uri: string) =>
          window.open(uri, "_blank", "noopener,noreferrer"),
        ) as unknown,
      );
      term.open(el);
      termRef.current = term;
      fitRef.current = fit;

      // Attach the fastest available renderer. For xterm-6 the supported ladder
      // is WebGL → DOM (the standalone 2D-canvas addon targets xterm-5 internals,
      // so it is intentionally NOT in the shipped path). Init failure / context
      // loss steps down to xterm's built-in DOM renderer; the settled tier is
      // exposed for evidence.
      const failSet = forcedRendererFailures();
      const loaders: RendererLoaders = {
        webgl: async (onLoss) => {
          if (failSet.has("webgl")) throw new Error("forced webgl failure");
          const { WebglAddon } = await import("@xterm/addon-webgl");
          const addon = new WebglAddon() as unknown as {
            dispose: () => void;
            onContextLoss?: (cb: () => void) => void;
          };
          addon.onContextLoss?.(() => {
            try {
              addon.dispose();
            } catch {
              // already disposed
            }
            onLoss();
          });
          term.loadAddon(addon);
          return addon;
        },
      };
      await attachRenderer("webgl", loaders, (tier) => {
        rendererRef.current = tier;
        el.setAttribute("data-og-term-renderer", tier);
      });
      if (disposed) return;

      // Fit BEFORE reveal so the first visible frame is already correctly sized
      // (no 80×24 rasterize-then-reflow flash — the container stays hidden until
      // now via the `ready` visibility gate).
      const settle = () => {
        try {
          fit.fit();
        } catch {
          // ignore fit before layout
        }
      };
      settle();
      requestAnimationFrame(() => {
        if (disposed) return;
        settle();
        if (ptyOutputQueueRef.current.length > 0) {
          for (const data of ptyOutputQueueRef.current) term.write(data);
          ptyOutputQueueRef.current = [];
        }
        el.setAttribute("data-og-term-ready", "true");
        if (typeof globalThis.__OG_TERMINAL_DEBUG__ === "function") {
          globalThis.__OG_TERMINAL_DEBUG__({
            renderer: rendererRef.current,
            fontFamily: term.options.fontFamily,
            fontSize: term.options.fontSize,
            hasVarInFont: String(term.options.fontFamily ?? "").includes("var("),
            theme: term.options.theme,
          });
        }
        setReady(true);
      });
    })();

    return () => {
      disposed = true;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      rendererRef.current = null;
      writtenRef.current = new Set();
      wroteFirehoseRef.current = false;
      bootActiveRef.current = false;
      setReady(false);
    };
    // Mount ONCE — see the effects below for the runtime option syncs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync stdin/cursor at runtime (NOT a remount) when interactivity flips, so the
  // projection→PTY handoff keeps the single Terminal instance + its scrollback.
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term) return;
    term.options.disableStdin = !interactive;
    term.options.cursorBlink = interactive;
  }, [ready, interactive]);

  // Re-theme live (dark↔light flip) without re-mounting / losing scrollback. Uses
  // the passed theme, or self-derives from the container's tokens.
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term) return;
    const next = theme ?? xtermThemeFromTokens(containerRef.current);
    if (next) term.options.theme = next;
  }, [ready, theme]);

  // Boot-in-terminal status lines. While `booting`, paint a styled "● waking
  // machine — Ns…" line and tick it. On exit, if those lines were the ONLY
  // content (no firehose transcript), clear them for the incoming live screen —
  // never clear a real transcript (E5 preservation).
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term) return;
    if (!booting) {
      if (bootActiveRef.current) {
        bootActiveRef.current = false;
        if (!wroteFirehoseRef.current) term.clear();
      }
      return;
    }
    bootActiveRef.current = true;
    const start = Date.now();
    const paint = () => {
      const s = Math.max(0, Math.round((Date.now() - start) / 1000));
      // Bright-blue dot (accent) + dim label; `\r` + clear-line keeps it on one
      // line so the counter updates in place.
      term.write(`\r\x1b[2K\x1b[94m●\x1b[0m \x1b[2mwaking machine — ${s}s…\x1b[0m`);
    };
    term.write("\r\n");
    paint();
    const id = setInterval(paint, 1000);
    return () => clearInterval(id);
  }, [ready, booting]);

  // Write new firehose chunks incrementally — ONLY in firehose mode. In PTY mode
  // the ttyd socket owns the screen. Records that a real transcript exists so the
  // boot cleanup never wipes it.
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term || ptyMode) return;
    for (const chunk of result.chunks) {
      if (writtenRef.current.has(chunk.id)) continue;
      writtenRef.current.add(chunk.id);
      wroteFirehoseRef.current = true;
      term.write(chunk.text);
    }
  }, [ready, result.chunks, ptyMode]);

  // Wire interactive input when allowed. PTY mode pipes keystrokes to the ttyd
  // socket; firehose mode uses the legacy ptyWrite-over-HTTP fn.
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term || !interactive) return;
    const sink = ptyMode ? ptyStream.write : result.write;
    if (!sink) return;
    const sub = term.onData((data) => sink(data));
    return () => sub.dispose();
  }, [ready, interactive, ptyMode, ptyStream.write, result.write]);

  // In PTY mode, tell ttyd the window size on the xterm resize event.
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term || !ptyMode) return;
    ptyStream.resize(term.cols, term.rows);
    const sub = term.onResize(({ cols, rows }) => ptyStream.resize(cols, rows));
    return () => sub.dispose();
  }, [ready, ptyMode, ptyStream.connected, ptyStream.resize]);

  // Refit on container resize (dock drag) AND window resize.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const refit = () => {
      try {
        fitRef.current?.fit();
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", refit);
    let observer: ResizeObserver | null = null;
    const el = containerRef.current;
    if (el && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => refit());
      observer.observe(el);
    }
    return () => {
      window.removeEventListener("resize", refit);
      observer?.disconnect();
    };
  }, [ready]);

  return (
    <div className={cn("relative flex h-full w-full flex-col overflow-hidden", className)}>
      {showHeader && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-og-border px-2 py-1 text-og-xs text-og-fg-subtle">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                result.running ? "bg-og-status-running" : "bg-og-fg-subtle",
              )}
            />
            <span className="truncate font-og-mono">pty: {shell ?? "shell"}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {!interactive && (
              <span className="rounded-og-sm bg-og-surface-2 px-1.5 py-0.5 text-og-xs uppercase tracking-wide">
                read-only
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                termRef.current?.clear();
                writtenRef.current = new Set();
                wroteFirehoseRef.current = false;
              }}
              className="rounded-og-sm px-1.5 py-0.5 text-og-xs hover:text-og-fg pointer-coarse:min-h-10"
            >
              Clear
            </button>
          </span>
        </div>
      )}
      {/* `onPointerDownCapture`/`onFocusCapture` fire on the FIRST user engagement
          with the terminal surface (capture so they win even though xterm's own
          listeners stop propagation). The host warms the box for pty-ws here. The
          12px inset + `--og-color-bg` ground match the dock surface. */}
      <div
        className="relative min-h-0 flex-1 bg-og-bg p-3"
        onPointerDownCapture={handleActivate}
        onFocusCapture={handleActivate}
      >
        {!ready && (placeholder ?? <TerminalPlaceholder />)}
        {/* Kept `visibility:hidden` until the first successful fit so the first
            VISIBLE frame is already correctly sized (no 80×24 flash — E4). */}
        <div
          ref={containerRef}
          className="h-full w-full"
          style={{ visibility: ready ? "visible" : "hidden" }}
          data-opengeni-terminal
        />
      </div>
    </div>
  );
}

// xterm.js ships a stylesheet (`@xterm/xterm/css/xterm.css`) that is REQUIRED for
// correct layout — without it the `.xterm-helper-textarea` (an off-screen input
// xterm uses for IME/keystrokes) is NOT clipped and renders as a visible 1-line
// box in the top-left (the "weird input box" bug), and the viewport/screen aren't
// positioned. The host app never imports that CSS (no global stylesheet here), so
// we inject the structural rules once, idempotently (keyed by id), the first time
// any terminal mounts. Scoped under `.xterm` so it can't leak into host styles.
const XTERM_STYLE_ID = "opengeni-xterm-base-css";
const XTERM_BASE_CSS = `
.xterm{cursor:text;position:relative;user-select:none;-ms-user-select:none;-webkit-user-select:none}
.xterm.focus,.xterm:focus{outline:none}
.xterm .xterm-helpers{position:absolute;top:0;z-index:5}
.xterm .xterm-helper-textarea{padding:0;border:0;margin:0;position:absolute;opacity:0;left:-9999em;top:0;width:0;height:0;z-index:-5;white-space:nowrap;overflow:hidden;resize:none}
.xterm .composition-view{background:var(--og-color-bg);color:var(--og-color-fg);display:none;position:absolute;white-space:nowrap;z-index:1}
.xterm .composition-view.active{display:block}
.xterm .xterm-viewport{background-color:transparent;overflow-y:scroll;cursor:default;position:absolute;right:0;left:0;top:0;bottom:0}
.xterm .xterm-screen{position:relative}
.xterm .xterm-screen canvas{position:absolute;left:0;top:0}
.xterm .xterm-scroll-area{visibility:hidden}
.xterm-char-measure-element{display:inline-block;visibility:hidden;position:absolute;top:0;left:-9999em;line-height:normal}
.xterm.enable-mouse-events{cursor:default}
.xterm.xterm-cursor-pointer,.xterm .xterm-cursor-pointer{cursor:pointer}
.xterm.column-select.focus{cursor:crosshair}
.xterm .xterm-accessibility:not(.debug),.xterm .xterm-message{position:absolute;left:0;top:0;bottom:0;right:0;z-index:10;color:transparent;pointer-events:none}
.xterm .xterm-accessibility-tree:not(.debug) *::selection{color:transparent}
.xterm .xterm-accessibility-tree{user-select:text;white-space:pre}
.xterm .live-region{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.xterm-dim{opacity:1!important}
.xterm-underline-1{text-decoration:underline}
.xterm-underline-2{text-decoration:double underline}
.xterm-underline-3{text-decoration:wavy underline}
.xterm-underline-4{text-decoration:dotted underline}
.xterm-underline-5{text-decoration:dashed underline}
.xterm-overline{text-decoration:overline}
.xterm-strikethrough{text-decoration:line-through}
.xterm-screen .xterm-decoration-container .xterm-decoration{z-index:6;position:absolute}
.xterm-screen .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer{z-index:7}
.xterm-decoration-overview-ruler{z-index:8;position:absolute;top:0;right:0;pointer-events:none}
.xterm-decoration-top{z-index:2;position:relative}
`;

function ensureXtermBaseCss(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(XTERM_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = XTERM_STYLE_ID;
  style.textContent = XTERM_BASE_CSS;
  document.head.appendChild(style);
}

function TerminalPlaceholder() {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-og-sm text-og-fg-subtle">
      Loading terminal…
    </div>
  );
}
