import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import type { UseSandboxTerminalResult } from "../hooks/use-sandbox-terminal";

/** A subset of xterm.js's ITheme — the tokens worth themeing from a host app. */
export type XtermTheme = {
  background?: string;
  foreground?: string;
  cursor?: string;
  selectionBackground?: string;
};

export type SandboxTerminalProps = {
  /** From `useSandboxTerminal(...)`. */
  result: UseSandboxTerminalResult;
  theme?: XtermTheme | undefined;
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
  /** Read-only by default; interactive only when `result.write !== null`. */
  readOnly?: boolean | undefined;
  /** Shown on the server / before xterm hydrates (SSR-safe placeholder). */
  placeholder?: ReactNode | undefined;
  className?: string | undefined;
};

// The xterm.js handle the effect owns. `any`-free structural shape so we can
// drive it without a hard type dep on the lazily-imported lib.
type XtermLike = {
  open: (el: HTMLElement) => void;
  write: (data: string) => void;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  loadAddon: (addon: unknown) => void;
  dispose: () => void;
};
type FitAddonLike = { fit: () => void };

/**
 * An xterm.js terminal fed by the Channel-A event projection
 * (`useSandboxTerminal`). xterm + the fit addon are lazy-imported inside an
 * effect, so SSR renders the placeholder and the terminal mounts on hydration.
 * Output chunks are written incrementally (tracking a written-cursor by chunk id
 * so a re-render never re-writes). When `result.write` is non-null and not
 * read-only, keystrokes pipe back through the PTY.
 */
export function SandboxTerminal({
  result,
  theme,
  fontFamily,
  fontSize,
  readOnly,
  placeholder,
  className,
}: SandboxTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XtermLike | null>(null);
  const fitRef = useRef<FitAddonLike | null>(null);
  const writtenRef = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  // Mount xterm once (client-only).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;
      const term = new Terminal({
        convertEol: true,
        disableStdin: readOnly ?? result.write === null,
        fontFamily: fontFamily ?? "var(--font-mono, monospace)",
        fontSize: fontSize ?? 13,
        ...(theme ? { theme } : {}),
      }) as unknown as XtermLike;
      const fit = new FitAddon() as unknown as FitAddonLike;
      term.loadAddon(fit);
      term.open(el);
      try {
        fit.fit();
      } catch {
        // ignore early fit before layout
      }
      termRef.current = term;
      fitRef.current = fit;
      setReady(true);
    })();

    return () => {
      disposed = true;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = new Set();
      setReady(false);
    };
    // Re-mount only on read-only flip (the static construction params).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

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
    if (!ready || !term || !write || readOnly) return;
    const sub = term.onData((data) => write(data));
    return () => sub.dispose();
  }, [ready, result.write, readOnly]);

  // Refit on resize.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      try {
        fitRef.current?.fit();
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div className={cn("relative h-full w-full overflow-hidden", className)}>
      {!ready && (placeholder ?? <TerminalPlaceholder />)}
      <div ref={containerRef} className="h-full w-full" data-opengeni-terminal />
    </div>
  );
}

function TerminalPlaceholder() {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-xs text-[color:var(--color-fg-subtle,#888)]">
      Loading terminal…
    </div>
  );
}
