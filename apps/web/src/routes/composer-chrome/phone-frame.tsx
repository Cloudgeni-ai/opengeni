import type { ReactNode } from "react";

/** CSS logical size for iPhone 12/13/14 Pro (used across e2e as 390×844). */
export const IPHONE_12_PRO = { width: 390, height: 844 } as const;

/**
 * Device chrome for the SessionChrome mobile harness. The inner stage is a
 * fixed 390×844 viewport so chrome + composer density matches a real phone.
 */
export function PhoneFrame({
  children,
  label = "iPhone 12 Pro · 390×844",
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[26rem] flex-col items-center gap-3">
      <p className="text-2xs font-medium uppercase tracking-[0.14em] text-fg-subtle">{label}</p>
      <div
        className="relative shrink-0 overflow-hidden rounded-[2.4rem] border-[3px] border-fg/20 bg-fg/90 p-[10px] shadow-[0_24px_80px_-32px_rgba(0,0,0,0.65)]"
        style={{ width: IPHONE_12_PRO.width + 26, height: IPHONE_12_PRO.height + 26 }}
      >
        <div
          className="relative flex h-full w-full flex-col overflow-hidden rounded-[2rem] bg-bg text-fg"
          style={{ width: IPHONE_12_PRO.width, height: IPHONE_12_PRO.height }}
          data-og-phone-stage=""
        >
          {/* Status bar */}
          <div className="flex h-11 shrink-0 items-end justify-between px-6 pb-1.5 text-[12px] font-semibold tabular-nums text-fg">
            <span>9:41</span>
            <span
              aria-hidden
              className="absolute left-1/2 top-2 h-[28px] w-[110px] -translate-x-1/2 rounded-full bg-fg/90"
            />
            <span className="flex items-center gap-1.5 text-[11px] font-medium">
              <span aria-hidden>●●●</span>
              <span aria-hidden>▮</span>
            </span>
          </div>

          {/* App chrome stub — matches session header density without routing */}
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3">
            <span className="inline-flex size-8 items-center justify-center rounded-md text-fg-muted">
              ☰
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">MCP O…</span>
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-2xs text-fg-muted">
              on jorgebot
            </span>
          </div>

          {/* Scrollable faux timeline so chrome sits above a real composer dock */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
            <div className="space-y-3 opacity-55">
              <p className="text-2xs font-medium uppercase tracking-[0.12em] text-fg-subtle">
                waiting on you · 7h
              </p>
              <div className="rounded-xl border border-border bg-surface/60 p-3">
                <p className="text-sm font-medium text-fg">X XMCP credential readiness</p>
                <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                  Faux timeline card — not interactive. Focus the chrome + composer below.
                </p>
              </div>
              <div className="h-24 rounded-xl border border-dashed border-border/80 bg-surface-2/30" />
              <div className="h-16 rounded-xl border border-dashed border-border/80 bg-surface-2/30" />
            </div>
          </div>

          {children}

          {/* Home indicator */}
          <div className="flex h-5 shrink-0 items-start justify-center pt-1">
            <span className="h-1 w-28 rounded-full bg-fg/35" />
          </div>
        </div>
      </div>
    </div>
  );
}
