import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function markdownTableWidth({
  columnLeft,
  columnWidth,
  contentLeft,
  contentRight,
  preferredWidth,
}: {
  columnLeft: number;
  columnWidth: number;
  contentLeft: number;
  contentRight: number;
  preferredWidth: number;
}): number {
  const center = columnLeft + columnWidth / 2;
  const available = 2 * Math.min(center - contentLeft, contentRight - center);
  return Math.max(columnWidth, Math.min(preferredWidth, available));
}

/** Top-level assistant tables may borrow the timeline's unused side gutters.
 * Keep the prose column (and scroll owner) intact; never escape a bubble, quote,
 * nested list, or clipped disclosure. Standalone Markdown retains its layout.
 */
export function useMarkdownTableLayout(children: ReactNode) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const table = tableRef.current;
    const body = wrapper?.parentElement;
    const message = body?.closest("[data-og-wide-table-message]");
    const scroller = message?.closest<HTMLElement>("[data-og-timeline-scroller]");
    if (!wrapper || table === null || !body?.classList.contains("og-markdown-body") || !scroller) {
      setWidth(null);
      return;
    }

    const measure = () => {
      // Intermediate clipped/scrollable surfaces own their own content bounds.
      for (
        let ancestor: HTMLElement | null = body;
        ancestor && ancestor !== scroller;
        ancestor = ancestor.parentElement
      ) {
        if (getComputedStyle(ancestor).overflowX !== "visible") {
          setWidth(null);
          return;
        }
      }
      const column = body.getBoundingClientRect();
      const panel = scroller.getBoundingClientRect();
      const panelStyle = getComputedStyle(scroller);
      const left = panel.left + scroller.clientLeft + parseFloat(panelStyle.paddingLeft);
      const right =
        panel.left +
        scroller.clientLeft +
        scroller.clientWidth -
        parseFloat(panelStyle.paddingRight);

      // Measure the same table's preferred width, then restore its normal fluid
      // layout. This preserves wrapping and TSV copy without a duplicate DOM.
      const previousWidth = table.style.width;
      table.style.width = "max-content";
      const preferred = table.getBoundingClientRect().width;
      table.style.width = previousWidth;
      const next = markdownTableWidth({
        columnLeft: column.left,
        columnWidth: column.width,
        contentLeft: left,
        contentRight: right,
        preferredWidth: preferred,
      });
      setWidth((current) => (current !== null && Math.abs(current - next) < 0.5 ? current : next));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(body);
    observer.observe(table);
    return () => observer.disconnect();
  }, [children]);

  return {
    wrapperRef,
    tableRef,
    style:
      width === null
        ? undefined
        : {
            width,
            maxWidth: "none",
            marginInline: `calc((100% - ${width}px) / 2)`,
          },
  };
}
