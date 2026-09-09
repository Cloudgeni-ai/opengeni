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

/** Loaded only for assistant tables. Keep prose and nested scroll owners intact. */
export function observeMarkdownTableLayout(wrapper: HTMLDivElement, table: HTMLTableElement) {
  const body = wrapper.parentElement;
  const scroller = body
    ?.closest("[data-og-wide-table-message]")
    ?.closest<HTMLElement>("[data-og-timeline-scroller]");
  if (!body?.classList.contains("og-markdown-body") || !scroller) return;

  let width: number | null = null;
  const reset = () => {
    width = null;
    wrapper.style.width = "";
    wrapper.style.maxWidth = "";
    wrapper.style.marginInline = "";
  };
  const measure = () => {
    // Intermediate clipped/scrollable surfaces own their own content bounds.
    for (
      let ancestor: HTMLElement | null = body;
      ancestor && ancestor !== scroller;
      ancestor = ancestor.parentElement
    ) {
      if (getComputedStyle(ancestor).overflowX !== "visible") {
        reset();
        return;
      }
    }
    const column = body.getBoundingClientRect();
    const panel = scroller.getBoundingClientRect();
    const panelStyle = getComputedStyle(scroller);
    const left = panel.left + scroller.clientLeft + parseFloat(panelStyle.paddingLeft);
    const right =
      panel.left + scroller.clientLeft + scroller.clientWidth - parseFloat(panelStyle.paddingRight);

    // Measure the original table, preserving its wrapping and TSV copy DOM.
    const previousWidth = table.style.width;
    let preferred: number;
    try {
      table.style.width = "max-content";
      preferred = table.getBoundingClientRect().width;
    } finally {
      table.style.width = previousWidth;
    }
    const next = markdownTableWidth({
      columnLeft: column.left,
      columnWidth: column.width,
      contentLeft: left,
      contentRight: right,
      preferredWidth: preferred,
    });
    if (width !== null && Math.abs(width - next) < 0.5) return;
    width = next;
    wrapper.style.width = `${width}px`;
    wrapper.style.maxWidth = "none";
    wrapper.style.marginInline = `calc((100% - ${width}px) / 2)`;
  };

  measure();
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
  observer?.observe(scroller);
  observer?.observe(body);
  observer?.observe(table);
  return () => {
    observer?.disconnect();
    reset();
  };
}
