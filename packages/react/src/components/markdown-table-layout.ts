/**
 * Wide chat tables may extend past the prose column, but only to a readable
 * line length. Beyond it, cells wrap instead of forcing horizontal scrolling.
 */
export const MARKDOWN_TABLE_MAX_WIDTH_REM = 64;

export function markdownTableWidth({
  columnLeft,
  columnWidth,
  contentLeft,
  contentRight,
  maxWidth = Number.POSITIVE_INFINITY,
  preferredWidth,
}: {
  columnLeft: number;
  columnWidth: number;
  contentLeft: number;
  contentRight: number;
  maxWidth?: number;
  preferredWidth: number;
}): number {
  const center = columnLeft + columnWidth / 2;
  const available = 2 * Math.min(center - contentLeft, contentRight - center);
  return Math.max(columnWidth, Math.min(preferredWidth, available, maxWidth));
}

function measurementCopy(source: Node, document: Document): Node {
  if (source.nodeType === Node.ELEMENT_NODE) {
    const element = source as Element;
    // Inert prevents focus, not custom-element construction, media loading or
    // embedded browsing contexts. Do not clone those host-rendered surfaces.
    if (
      element.localName.includes("-") ||
      ["iframe", "object", "embed", "video", "audio", "canvas", "script"].includes(
        element.localName,
      )
    ) {
      const bounds = element.getBoundingClientRect();
      const placeholder = document.createElement("span");
      placeholder.style.display = "inline-block";
      placeholder.style.width = `${bounds.width}px`;
      placeholder.style.height = `${bounds.height}px`;
      return placeholder;
    }
  }
  const copy = document.importNode(source, false);
  if (copy.nodeType === Node.ELEMENT_NODE) {
    const element = copy as Element;
    element.removeAttribute("id");
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith("on")) element.removeAttribute(attribute.name);
    }
  }
  for (const child of source.childNodes) copy.appendChild(measurementCopy(child, document));
  return copy;
}

/** Loaded only for assistant tables. Keep prose and nested scroll owners intact. */
export function observeMarkdownTableLayout(wrapper: HTMLDivElement, table: HTMLTableElement) {
  const body = wrapper.parentElement;
  const scroller = body
    ?.closest("[data-og-wide-table-message]")
    ?.closest<HTMLElement>("[data-og-timeline-scroller]");
  if (!body?.classList.contains("og-markdown-body") || !scroller) return;

  // Build the static copy without a browsing context before inserting its probe.
  const measurementDocument = table.ownerDocument.implementation.createHTMLDocument("");
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

    // Even a temporary max-content width on the live table changes its height
    // during forced layout. Browser scroll anchoring can retain that displacement
    // after the width is restored. Measure a copy without touching live geometry.
    const probe = table.ownerDocument.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.inert = true;
    // A zero-sized, contained box cannot extend the scroller's overflow area,
    // including inside transformed ancestors. Keep the same inherited styling.
    probe.style.cssText =
      "position:absolute;width:0;height:0;overflow:hidden;contain:layout size paint;visibility:hidden;pointer-events:none";
    const copy = measurementCopy(table, measurementDocument) as HTMLTableElement;
    copy.style.width = "max-content";
    probe.append(copy);
    let preferred: number;
    try {
      table.parentElement!.append(probe);
      preferred = copy.getBoundingClientRect().width;
    } finally {
      probe.remove();
    }
    const rootFontSize =
      parseFloat(getComputedStyle(table.ownerDocument.documentElement).fontSize) || 16;
    const next = markdownTableWidth({
      columnLeft: column.left,
      columnWidth: column.width,
      contentLeft: left,
      contentRight: right,
      maxWidth: MARKDOWN_TABLE_MAX_WIDTH_REM * rootFontSize,
      preferredWidth: preferred,
    });
    if (width !== null && Math.abs(width - next) < 0.5) return;
    width = next;
    wrapper.style.width = `${width}px`;
    wrapper.style.maxWidth = "none";
    wrapper.style.marginInline = `calc((100% - ${width}px) / 2)`;
  };

  measure();
  // Measuring clones the table and forces layout, so it runs only when the
  // answer can change: the column or panel gets wider or narrower, the table's
  // own box changes size, or its cells change. Height changes elsewhere (the
  // composer growing, messages streaming in) and re-renders that leave the
  // table's DOM as it was do not measure again.
  const widths = new WeakMap<Element, number>();
  const resized =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver((entries) => {
          let changed = false;
          for (const entry of entries) {
            const size =
              entry.target === table
                ? entry.contentRect.width * 1e6 + entry.contentRect.height
                : entry.contentRect.width;
            if (widths.get(entry.target) !== size) changed = true;
            widths.set(entry.target, size);
          }
          if (changed) measure();
        });
  resized?.observe(scroller);
  resized?.observe(body);
  resized?.observe(table);
  const edited =
    typeof MutationObserver === "undefined" ? undefined : new MutationObserver(() => measure());
  edited?.observe(table, { childList: true, subtree: true, characterData: true });
  return {
    measure,
    disconnect: () => {
      resized?.disconnect();
      edited?.disconnect();
      reset();
    },
  };
}
