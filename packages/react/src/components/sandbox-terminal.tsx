import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import type { UseSandboxTerminalResult } from "../hooks/use-sandbox-terminal";

/** A subset of xterm.js's ITheme — the tokens worth themeing from a host app. */
export type XtermTheme = {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
};

export type SandboxTerminalProps = {
  /** From `useSandboxTerminal(...)`. */
  result: UseSandboxTerminalResult;
  theme?: XtermTheme | undefined;
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
  /**
   * Force read-only even when the PTY accepts stdin. Default: interactive
   * whenever `result.write !== null` (the box advertises an interactive PTY);
   * otherwise the read-only agent firehose.
   */
  readOnly?: boolean | undefined;
  /** Shown on the server / before xterm hydrates (SSR-safe placeholder). */
  placeholder?: ReactNode | undefined;
  /** Render the small status header (pty/shell + running dot + read-only pill). */
  showHeader?: boolean | undefined;
  /** Shell label for the header (e.g. `/bin/bash`). */
  shell?: string | undefined;
  className?: string | undefined;
};

// The xterm.js handle the effect owns. `any`-free structural shape so we can
// drive it without a hard type dep on the lazily-imported lib.
type XtermLike = {
  open: (el: HTMLElement) => void;
  write: (data: string) => void;
  clear: () => void;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  loadAddon: (addon: unknown) => void;
  dispose: () => void;
  options: { theme?: XtermTheme; disableStdin?: boolean };
};
type FitAddonLike = { fit: () => void };

/**
 * An xterm.js terminal fed by the Channel-A event projection
 * (`useSandboxTerminal`). xterm + the fit + web-links addons are lazy-imported
 * inside an effect, so SSR renders the placeholder and the terminal mounts on
 * hydration. Output chunks are written incrementally (tracking a written-cursor
 * by chunk id so a re-render never re-writes). When `result.write` is non-null
 * and not forced read-only, keystrokes pipe back through the PTY.
 *
 * Resizes are tracked with a `ResizeObserver` on the container (not just
 * `window.resize`) so dragging the dock handle refits the grid instead of
 * leaving the terminal mis-sized.
 */
export function SandboxTerminal({
  result,
  theme,
  fontFamily,
  fontSize,
  readOnly,
  placeholder,
  showHeader,
  shell,
  className,
}: SandboxTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XtermLike | null>(null);
  const fitRef = useRef<FitAddonLike | null>(null);
  const writtenRef = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  const interactive = !readOnly && result.write !== null;

  // Mount xterm once (client-only). Re-mounts only when the interactive flag
  // flips (stdin enable/disable is a construction param on xterm).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    // Wait for the container to have a real measured size before opening xterm.
    // If `term.open()` runs while the panel is 0-wide (tab still mounting, dock
    // mid-resize), xterm renders at its 80×24 fallback and the first frame's
    // grid is rasterized into the canvas; a later fit reflows the text but the
    // stale first paint lingers as a `]]]bbb` smear on the top row. Gating the
    // open on a non-zero size removes that first wrong-width render entirely.
    const waitForSize = (el: HTMLElement) =>
      new Promise<void>((resolve) => {
        if (el.clientWidth > 0 && el.clientHeight > 0) return resolve();
        const ro = new ResizeObserver(() => {
          if (el.clientWidth > 0 && el.clientHeight > 0) {
            ro.disconnect();
            resolve();
          }
        });
        ro.observe(el);
        // Safety: never hang if the observer somehow never fires.
        setTimeout(() => {
          ro.disconnect();
          resolve();
        }, 1000);
      });

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (disposed) return;
      await waitForSize(el);
      if (disposed) return;
      const term = new Terminal({
        convertEol: true,
        disableStdin: !interactive,
        cursorBlink: interactive,
        fontFamily: fontFamily ?? "var(--og-font-mono, var(--font-mono, monospace))",
        fontSize: fontSize ?? 13,
        lineHeight: 1.25,
        // A little breathing room from the panel edge so output isn't flush to
        // the border (matches a real terminal app's inner gutter).
        ...({ padding: 8 } as Record<string, unknown>),
        ...(theme ? { theme } : {}),
      }) as unknown as XtermLike;
      const fit = new FitAddon() as unknown as FitAddonLike;
      term.loadAddon(fit);
      // Clickable URLs in agent output (open in a new tab).
      term.loadAddon(
        new WebLinksAddon((_e: MouseEvent, uri: string) => window.open(uri, "_blank", "noopener,noreferrer")) as unknown,
      );
      term.open(el);
      termRef.current = term;
      fitRef.current = fit;
      // Critical: the column count must be settled BEFORE any output is written,
      // or seeded transcript lines reflow/garble against the default 80×24 grid
      // (the trailing prompt's escape codes smear into `]]]bbb` artifacts). Fit
      // once now, then again on the next frame after layout has measured the
      // real container width, and only then unblock the write effect.
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
        setReady(true);
      });
    })();

    return () => {
      disposed = true;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = new Set();
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  // Re-theme live (e.g. dark↔light flip) without re-mounting / losing scrollback.
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term || !theme) return;
    term.options.theme = theme;
  }, [ready, theme]);

  // Write new chunks incrementally.
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term) return;
    for (const chunk of result.chunks) {
      if (writtenRef.current.has(chunk.id)) continue;
      writtenRef.current.add(chunk.id);
      term.write(chunk.text);
    }
  }, [ready, result.chunks]);

  // Wire interactive input when allowed.
  useEffect(() => {
    const term = termRef.current;
    const write = result.write;
    if (!ready || !term || !write || !interactive) return;
    const sub = term.onData((data) => write(data));
    return () => sub.dispose();
  }, [ready, result.write, interactive]);

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
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] px-2 py-1 text-[11px] text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                result.running
                  ? "bg-[color:var(--og-color-status-running,var(--color-status-running,#d29922))]"
                  : "bg-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]",
              )}
            />
            <span className="truncate font-[family-name:var(--og-font-mono,var(--font-mono,monospace))]">
              pty: {shell ?? "shell"}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {!interactive && (
              <span className="rounded-[var(--og-radius-sm,4px)] bg-[color:var(--og-color-surface-2,var(--color-surface-2,#161616))] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                read-only
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                termRef.current?.clear();
                writtenRef.current = new Set();
              }}
              className="rounded-[var(--og-radius-sm,4px)] px-1.5 py-0.5 text-[10px] hover:text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]"
            >
              Clear
            </button>
          </span>
        </div>
      )}
      <div className="relative min-h-0 flex-1 bg-[color:var(--og-color-bg,var(--color-bg,#0d0d0d))] px-2 py-1.5">
        {!ready && (placeholder ?? <TerminalPlaceholder />)}
        <div ref={containerRef} className="h-full w-full" data-opengeni-terminal />
      </div>
    </div>
  );
}

function TerminalPlaceholder() {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-xs text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
      Loading terminal…
    </div>
  );
}
