import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ----------------------------------------------------------------------------
   Windowed sections — variable-height file-section virtualization.

   The Changes tab stacks N file diffs in one scroll pane. Mounting N Shiki
   highlighters (Pierre's `PatchDiff`) at once is the exact wart this replaces,
   so we mount only the sections inside the visible window ± overscan and reserve
   the rest as empty space (dossier §10.7, D2).

   Why NOT `virtua` here (unlike the file tree/rail): Pierre renders each diff in
   a shadow DOM with its own internal overflow/virtualization, so an outer
   measuring virtualizer can read a collapsed or fixed height and lay sections
   out wrong (dossier risk #6). This hook windows by mounting/unmounting whole
   file sections off a scroll offset and a per-section height ESTIMATE (refined
   by measurement when a real browser provides it), which never depends on
   Pierre reporting its own height — and the math is pure + deterministic, so
   D2 is provable in both happy-dom (drive scrollTop/clientHeight) and a real
   browser (Playwright, the verification-matrix path).
   -------------------------------------------------------------------------- */

export type WindowRange = {
  /** First mounted index (inclusive). */
  start: number;
  /** One past the last mounted index (exclusive). */
  end: number;
};

/**
 * Pure windowing math: given each section's height (px), the scroll offset, the
 * viewport height, and an overscan count, return the `[start, end)` index window
 * to mount. Robust to a zero viewport (a headless/pre-layout pass) — it then
 * mounts a small overscan window anchored at the item under `scrollTop` rather
 * than the whole list.
 */
export function computeWindowRange(
  heights: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
): WindowRange {
  const n = heights.length;
  if (n === 0) return { start: 0, end: 0 };
  const top = Math.max(scrollTop, 0);
  const bottom = top + Math.max(viewport, 0);

  let firstVisible = -1;
  let lastVisible = -1;
  let acc = 0;
  let anchor = 0; // the item containing `scrollTop` — the zero-viewport fallback
  for (let i = 0; i < n; i++) {
    const secTop = acc;
    const secBottom = secTop + Math.max(heights[i] ?? 0, 0);
    if (secTop <= top) anchor = i;
    // A section is visible when it overlaps [top, bottom); with viewport 0 the
    // half-open interval is empty, so nothing matches and we fall back to anchor.
    if (secBottom > top && secTop < bottom) {
      if (firstVisible === -1) firstVisible = i;
      lastVisible = i;
    }
    acc = secBottom;
  }

  if (firstVisible === -1) {
    firstVisible = anchor;
    lastVisible = anchor;
  }

  return {
    start: Math.max(0, firstVisible - overscan),
    end: Math.min(n, lastVisible + 1 + overscan),
  };
}

export type WindowedSections = {
  /** Attach to the scroll container. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The mounted window `[start, end)`. */
  range: WindowRange;
  /** Prefix offsets: `offsets[i]` is the top px of section `i`; `offsets[count]`
   *  is the total content height. */
  offsets: number[];
  /** Total content height (px) — set on the spacer so scroll length is stable. */
  totalHeight: number;
  /** Callback ref for a MOUNTED section: measures its real height and refines the
   *  layout. Never call for an unmounted section (its node has no diff body). */
  measure: (index: number, node: HTMLElement | null) => void;
  /** Scroll section `index` to the top of the pane (the rail-jump). */
  scrollToIndex: (index: number) => void;
};

/**
 * Variable-height section windowing over a scroll container. Seeds every section
 * to `estimateHeight(i)`, mounts only `range`, and refines heights from real
 * measurements (a no-op in a zero-layout headless pass, which keeps the estimate
 * — deterministic for tests). Pass a STABLE `estimateHeight` (wrap in useCallback).
 */
export function useWindowedSections(opts: {
  count: number;
  estimateHeight: (index: number) => number;
  overscan?: number | undefined;
}): WindowedSections {
  const { count, estimateHeight, overscan = 3 } = opts;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [heights, setHeights] = useState<number[]>(() =>
    Array.from({ length: count }, (_, i) => estimateHeight(i)),
  );

  // Re-seed heights when the section count changes (a new diff arrives), keeping
  // any already-measured heights for surviving indices.
  useEffect(() => {
    setHeights((prev) => {
      if (prev.length === count) return prev;
      return Array.from({ length: count }, (_, i) => prev[i] ?? estimateHeight(i));
    });
    // estimateHeight is expected stable; count is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  const heightsRef = useRef(heights);
  heightsRef.current = heights;

  const [range, setRange] = useState<WindowRange>(() => ({
    start: 0,
    end: Math.min(count, overscan + 1),
  }));

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = computeWindowRange(heightsRef.current, el.scrollTop, el.clientHeight, overscan);
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [overscan]);

  // Recompute on scroll (rAF-coalesced) and on container resize.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(() => {
              raf = 0;
              recompute();
            })
          : (recompute(), 0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => recompute()) : null;
    ro?.observe(el);
    recompute();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    };
  }, [recompute, count]);

  const measure = useCallback((index: number, node: HTMLElement | null) => {
    if (!node) return;
    const h = node.offsetHeight;
    if (h <= 0) return; // zero-layout pass — keep the estimate
    setHeights((prev) => {
      if (Math.abs((prev[index] ?? 0) - h) < 1) return prev;
      const next = prev.slice();
      next[index] = h;
      return next;
    });
  }, []);

  const offsets = useMemo(() => {
    const out = new Array<number>(count + 1);
    out[0] = 0;
    for (let i = 0; i < count; i++) out[i + 1] = (out[i] ?? 0) + Math.max(heights[i] ?? 0, 0);
    return out;
  }, [heights, count]);

  // A measured height can shift the window (e.g. estimates were short) — keep the
  // mounted set in sync without waiting for the next scroll.
  useEffect(() => {
    recompute();
  }, [offsets, recompute]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const clamped = Math.max(0, Math.min(count - 1, index));
      el.scrollTop = offsets[clamped] ?? 0;
    },
    [offsets, count],
  );

  return {
    scrollRef,
    range,
    offsets,
    totalHeight: offsets[count] ?? 0,
    measure,
    scrollToIndex,
  };
}
