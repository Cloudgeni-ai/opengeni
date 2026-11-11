/**
 * Copy a page selection as clean rich text.
 *
 * Browsers serialize a copied selection with the page's computed styles inlined
 * (text colour, font, and the background of the surrounding message), so a
 * selection pasted into a document or chat keeps the app's dark or tinted
 * backgrounds. This rebuilds the selected content as semantic HTML only:
 * structure and formatting (paragraphs, lists, emphasis, code, links, tables)
 * survive, page styling does not. The plain-text flavour is the browser's own.
 */

/** Elements copied as themselves. Everything else is unwrapped or becomes a block. */
const KEPT_TAGS = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DD",
  "DEL",
  "DL",
  "DT",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "I",
  "IMG",
  "INS",
  "KBD",
  "LI",
  "OL",
  "P",
  "PRE",
  "S",
  "STRONG",
  "SUB",
  "SUP",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "U",
  "UL",
]);

/** Never copied: no readable text, or not content. */
const DROPPED_TAGS = new Set([
  "AUDIO",
  "CANVAS",
  "IFRAME",
  "INPUT",
  "NOSCRIPT",
  "OBJECT",
  "SCRIPT",
  "SELECT",
  "STYLE",
  "SVG",
  "TEMPLATE",
  "TEXTAREA",
  "VIDEO",
]);

/**
 * Formatting a selection inherits from where it sits. A selection inside one
 * code block or heading starts below that element, so wrap it back in.
 */
const CONTEXT_TAGS = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "CODE",
  "DEL",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "I",
  "PRE",
  "S",
  "STRONG",
  "U",
]);

/** Containers that only make sense with their parent table. */
const TABLE_PARTS = new Set(["THEAD", "TBODY", "TFOOT", "TR"]);

const INLINE_DISPLAYS = new Set([
  "inline",
  "inline-block",
  "inline-flex",
  "inline-grid",
  "contents",
]);

function computedStyle(element: Element): CSSStyleDeclaration | null {
  const view = element.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return null;
  try {
    return view.getComputedStyle(element);
  } catch {
    return null;
  }
}

/** Mirrors what the browser's own selection text leaves out. */
function excluded(element: Element): boolean {
  if (DROPPED_TAGS.has(element.tagName.toUpperCase())) return true;
  if (element.hasAttribute("hidden")) return true;
  const style = computedStyle(element);
  if (!style) return false;
  if (style.display === "none") return true;
  if (style.visibility === "hidden" || style.visibility === "collapse") return true;
  const userSelect =
    style.userSelect ||
    style.getPropertyValue("user-select") ||
    style.getPropertyValue("-webkit-user-select");
  return userSelect === "none";
}

function isBlock(element: Element): boolean {
  const display = computedStyle(element)?.display;
  return !!display && !INLINE_DISPLAYS.has(display);
}

function safeUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function shallowCopy(source: Element, target: Document): Element {
  const tag = source.tagName.toLowerCase();
  const copy = target.createElement(tag);
  const base = source.ownerDocument.baseURI;
  if (tag === "a") {
    const href = safeUrl(source.getAttribute("href"), base);
    if (href) copy.setAttribute("href", href);
  } else if (tag === "img") {
    const src = safeUrl(source.getAttribute("src"), base);
    if (src) copy.setAttribute("src", src);
    const alt = source.getAttribute("alt");
    if (alt) copy.setAttribute("alt", alt);
  } else if (tag === "ol") {
    const start = source.getAttribute("start");
    if (start && /^-?\d+$/.test(start)) copy.setAttribute("start", start);
  } else if (tag === "td" || tag === "th") {
    for (const name of ["colspan", "rowspan"]) {
      const value = source.getAttribute(name);
      if (value && /^\d+$/.test(value)) copy.setAttribute(name, value);
    }
  }
  return copy;
}

function appendSelected(node: Node, range: Range, parent: Node, target: Document): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;
    if (end > start) parent.appendChild(target.createTextNode(text.slice(start, end)));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  if (excluded(element)) return;
  const tag = element.tagName.toUpperCase();
  let into: Node = parent;
  if (KEPT_TAGS.has(tag)) {
    into = parent.appendChild(shallowCopy(element, target));
  } else if (isBlock(element)) {
    into = parent.appendChild(target.createElement("div"));
  }
  appendChildrenInRange(element, range, into, target);
}

function appendChildrenInRange(node: Node, range: Range, parent: Node, target: Document): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (range.intersectsNode(child)) appendSelected(child, range, parent, target);
  }
}

/** The selected content of one range, wrapped in the formatting it sits inside. */
function serializeRange(range: Range, root: Element, target: Document): Node {
  const fragment = target.createDocumentFragment();
  const common = range.commonAncestorContainer;
  if (common.nodeType === Node.TEXT_NODE) {
    appendSelected(common, range, fragment, target);
  } else {
    appendChildrenInRange(common, range, fragment, target);
  }
  let content: Node = fragment;
  let ancestor: Element | null =
    common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
  // A selection across several items or rows keeps its list or table.
  if (ancestor && ancestor !== root) {
    const tag = ancestor.tagName.toUpperCase();
    if (tag === "UL" || tag === "OL" || tag === "TABLE" || TABLE_PARTS.has(tag)) {
      const wrapper = shallowCopy(ancestor, target);
      wrapper.appendChild(content);
      content = wrapper;
      if (TABLE_PARTS.has(tag)) {
        const table = target.createElement("table");
        if (tag === "TR") {
          const body = target.createElement("tbody");
          body.appendChild(content);
          table.appendChild(body);
        } else {
          table.appendChild(content);
        }
        content = table;
      }
    }
  }
  for (
    ;
    ancestor && ancestor !== root && root.contains(ancestor);
    ancestor = ancestor.parentElement
  ) {
    if (excluded(ancestor)) continue;
    if (!CONTEXT_TAGS.has(ancestor.tagName.toUpperCase())) continue;
    const wrapper = shallowCopy(ancestor, target);
    wrapper.appendChild(content);
    content = wrapper;
  }
  return content;
}

function editable(node: Node | null): boolean {
  const element = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
  if (!element) return false;
  return !!element.closest(
    "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
  );
}

/**
 * Clean clipboard flavours for the current selection inside `root`, or null
 * when the browser's default copy should run (no selection, a selection that
 * leaves `root`, or one inside an editable field).
 */
export function selectionClipboardContent(root: Element): { html: string; text: string } | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const ranges: Range[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (!root.contains(range.commonAncestorContainer)) return null;
    if (editable(range.startContainer) || editable(range.endContainer)) return null;
    ranges.push(range);
  }
  const text = selection.toString();
  if (!text) return null;
  // An inert document: nothing created here loads images or runs anything.
  const target = root.ownerDocument.implementation.createHTMLDocument("");
  const container = target.createElement("div");
  for (const range of ranges) container.appendChild(serializeRange(range, root, target));
  return { html: container.innerHTML, text };
}

/**
 * `copy` handler: replace the browser's styled copy of a selection inside
 * `root` with clean HTML plus the browser's own plain text. Leaves every other
 * copy (editable fields, selections outside `root`) untouched.
 */
export function copySelectionWithoutPageStyles(
  event: Pick<ClipboardEvent, "clipboardData" | "preventDefault">,
  root: Element | null,
): boolean {
  if (!root || !event.clipboardData) return false;
  const content = selectionClipboardContent(root);
  if (!content) return false;
  event.clipboardData.setData("text/plain", content.text);
  event.clipboardData.setData("text/html", content.html);
  event.preventDefault();
  return true;
}
