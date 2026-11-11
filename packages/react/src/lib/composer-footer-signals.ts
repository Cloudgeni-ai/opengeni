import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";

/**
 * States of controls inside the composer footer that change how the rest of
 * the footer lays out (voice capture, a saved recording or voice error, a
 * failed live-voice start).
 *
 * The footer element carries each active state as a `data-footer-*` attribute, so the
 * stylesheet can react with plain attribute selectors. Using
 * `.og-composer-footer:has(...)` instead made the browser restyle the whole
 * page on every DOM change, including each keystroke in the composer.
 */
export type ComposerFooterSignal =
  | "transcription-capturing"
  | "transcription-attention"
  | "realtime-attention";

type Report = (signal: ComposerFooterSignal, active: boolean) => void;

const ComposerFooterSignalContext = createContext<Report | null>(null);

export const ComposerFooterSignalProvider = ComposerFooterSignalContext.Provider;

/** Footer side: collects the signals reported by its controls. */
export function useComposerFooterSignalState(): {
  report: Report;
  attributes: Partial<Record<`data-footer-${ComposerFooterSignal}`, "">>;
} {
  const [counts, setCounts] = useState<Partial<Record<ComposerFooterSignal, number>>>({});
  const report = useCallback<Report>((signal, active) => {
    setCounts((current) => {
      const next = Math.max(0, (current[signal] ?? 0) + (active ? 1 : -1));
      return { ...current, [signal]: next };
    });
  }, []);
  const attributes = useMemo(() => {
    const result: Partial<Record<`data-footer-${ComposerFooterSignal}`, "">> = {};
    for (const [signal, count] of Object.entries(counts)) {
      if (count) result[`data-footer-${signal as ComposerFooterSignal}`] = "";
    }
    return result;
  }, [counts]);
  return { report, attributes };
}

/** Control side: marks the enclosing composer footer while `active`. */
export function useComposerFooterSignal(signal: ComposerFooterSignal, active: boolean): void {
  const report = useContext(ComposerFooterSignalContext);
  useLayoutEffect(() => {
    if (!report || !active) return;
    report(signal, true);
    return () => report(signal, false);
  }, [report, signal, active]);
}
