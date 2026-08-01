import {
  ArrowLeftIcon,
  Maximize2Icon,
  RefreshCwIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import DOMPurify from "dompurify";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const ARTIFACT_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "media-src 'none'",
  "font-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
].join("; ");
export const ARTIFACT_IFRAME_SANDBOX = "";

const ARTIFACT_HTML_TAGS = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "body",
  "br",
  "button",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "li",
  "main",
  "mark",
  "meter",
  "nav",
  "ol",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "source",
  "span",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "u",
  "ul",
  "var",
  "wbr",
]);

const ARTIFACT_SVG_TAGS = new Set([
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "g",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "svg",
  "text",
  "textpath",
  "tspan",
]);

const ARTIFACT_GLOBAL_ATTRIBUTES = new Set([
  "class",
  "dir",
  "hidden",
  "id",
  "lang",
  "role",
  "style",
  "tabindex",
  "title",
]);

const ARTIFACT_TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href"]),
  button: new Set(["disabled", "type"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  details: new Set(["open"]),
  img: new Set(["alt", "height", "loading", "src", "width"]),
  input: new Set(["checked", "disabled", "max", "min", "name", "step", "type", "value"]),
  label: new Set(["for"]),
  li: new Set(["value"]),
  meter: new Set(["high", "low", "max", "min", "optimum", "value"]),
  ol: new Set(["reversed", "start", "type"]),
  progress: new Set(["max", "value"]),
  source: new Set(["media", "src", "type"]),
  td: new Set(["colspan", "headers", "rowspan"]),
  th: new Set(["abbr", "colspan", "headers", "rowspan", "scope"]),
  time: new Set(["datetime"]),
};

const ARTIFACT_SVG_ATTRIBUTES = new Set([
  "cx",
  "cy",
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "font-family",
  "font-size",
  "font-weight",
  "fx",
  "fy",
  "gradienttransform",
  "gradientunits",
  "height",
  "marker-end",
  "marker-mid",
  "marker-start",
  "markerheight",
  "markerunits",
  "markerwidth",
  "mask",
  "offset",
  "opacity",
  "orient",
  "pathlength",
  "patterncontentunits",
  "patternunits",
  "points",
  "preserveaspectratio",
  "r",
  "refx",
  "refy",
  "rx",
  "ry",
  "spreadmethod",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "transform",
  "viewbox",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
]);

const ARTIFACT_INPUT_TYPES = new Set(["checkbox", "radio", "range"]);
const ARTIFACT_ALLOWED_ATTRIBUTES = new Set([
  ...ARTIFACT_GLOBAL_ATTRIBUTES,
  ...Object.values(ARTIFACT_TAG_ATTRIBUTES).flatMap((attributes) => [...attributes]),
  ...ARTIFACT_SVG_ATTRIBUTES,
]);
const ARTIFACT_SAFE_BLOCK_AT_RULES = new Set([
  "container",
  "keyframes",
  "layer",
  "media",
  "supports",
  "-webkit-keyframes",
]);
const ARTIFACT_UNSAFE_CSS_PROPERTIES = new Set(["-moz-binding", "behavior", "src"]);

function cssSecurityText(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6})(?:\s)?/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint === 0 || codePoint > 0x10ffff ? "\uFFFD" : String.fromCodePoint(codePoint);
    })
    .replace(/\\([^\r\n\f])/g, "$1")
    .replace(/[\u0000-\u0020\u007f]+/g, "")
    .toLowerCase();
}

function containsUrlBearingCss(value: string): boolean {
  const canonical = cssSecurityText(value);
  return (
    /(?:^|[^a-z0-9_-])(?:url|image-set|-webkit-image-set|cross-fade|element)\(/.test(canonical) ||
    /(?:https?|data|blob|javascript|file):/.test(canonical) ||
    canonical.includes("//") ||
    canonical.includes("expression(") ||
    canonical.includes("-moz-binding")
  );
}

function splitCssDeclarations(value: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote = "";
  let parentheses = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")" && parentheses > 0) parentheses -= 1;
    else if (character === ";" && parentheses === 0) {
      segments.push(value.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(value.slice(start));
  return segments;
}

function declarationColon(value: string): number {
  let quote = "";
  let parentheses = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")" && parentheses > 0) parentheses -= 1;
    else if (character === ":" && parentheses === 0) return index;
  }
  return -1;
}

export function sanitizeArtifactCssDeclarations(css: string): string {
  const declarations: string[] = [];
  for (const candidate of splitCssDeclarations(css.replace(/\/\*[\s\S]*?\*\//g, ""))) {
    const colon = declarationColon(candidate);
    if (colon < 1) continue;
    const property = candidate.slice(0, colon).trim();
    const value = candidate.slice(colon + 1).trim();
    const canonicalProperty = cssSecurityText(property);
    if (
      !value ||
      !/^(?:--)?[-a-z][a-z0-9_-]*$/.test(canonicalProperty) ||
      ARTIFACT_UNSAFE_CSS_PROPERTIES.has(canonicalProperty) ||
      containsUrlBearingCss(value)
    ) {
      continue;
    }
    declarations.push(`${property}: ${value}`);
  }
  return declarations.join("; ");
}

function matchingCssBrace(css: string, opening: number): number {
  let depth = 0;
  let quote = "";
  for (let index = opening; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

function cssAtRuleName(prelude: string): string | null {
  return cssSecurityText(prelude).match(/^@([-a-z0-9]+)/)?.[1] ?? null;
}

export function sanitizeArtifactCss(css: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
    if (cursor >= source.length) break;
    let delimiter = -1;
    let quote = "";
    let parentheses = 0;
    for (let index = cursor; index < source.length; index += 1) {
      const character = source[index]!;
      if (quote) {
        if (character === "\\") index += 1;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === "(") parentheses += 1;
      else if (character === ")" && parentheses > 0) parentheses -= 1;
      else if (parentheses === 0 && (character === "{" || character === ";")) {
        delimiter = index;
        break;
      }
    }
    if (delimiter < 0) break;
    const prelude = source.slice(cursor, delimiter).trim();
    if (source[delimiter] === ";") {
      cursor = delimiter + 1;
      continue;
    }
    const closing = matchingCssBrace(source, delimiter);
    if (closing < 0) break;
    const block = source.slice(delimiter + 1, closing);
    const atRule = cssAtRuleName(prelude);
    if (atRule) {
      if (ARTIFACT_SAFE_BLOCK_AT_RULES.has(atRule) && !containsUrlBearingCss(prelude)) {
        const nested = sanitizeArtifactCss(block);
        if (nested) rules.push(`${prelude} { ${nested} }`);
      }
    } else if (prelude && !containsUrlBearingCss(prelude)) {
      const declarations = sanitizeArtifactCssDeclarations(block);
      if (declarations) rules.push(`${prelude} { ${declarations} }`);
    }
    cursor = closing + 1;
  }
  return rules.join("\n");
}

function unwrapElement(element: Element): void {
  element.replaceWith(...Array.from(element.childNodes));
}

function sanitizeArtifactElement(element: Element): void {
  const tag = element.localName.toLowerCase();
  const isSvg = element.namespaceURI === "http://www.w3.org/2000/svg";
  const allowed = isSvg ? ARTIFACT_SVG_TAGS.has(tag) : ARTIFACT_HTML_TAGS.has(tag);
  if (!allowed) {
    if (["base", "embed", "iframe", "link", "meta", "object", "script"].includes(tag)) {
      element.remove();
    } else {
      unwrapElement(element);
    }
    return;
  }

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const tagAttributes = ARTIFACT_TAG_ATTRIBUTES[tag];
    const allowedAttribute =
      ARTIFACT_GLOBAL_ATTRIBUTES.has(name) ||
      name.startsWith("aria-") ||
      tagAttributes?.has(name) ||
      (isSvg && ARTIFACT_SVG_ATTRIBUTES.has(name));
    if (!allowedAttribute || name.startsWith("on")) element.removeAttribute(attribute.name);
  }

  const inlineStyle = element.getAttribute("style");
  if (inlineStyle !== null) {
    const sanitized = sanitizeArtifactCssDeclarations(inlineStyle);
    if (sanitized) element.setAttribute("style", sanitized);
    else element.removeAttribute("style");
  }
  if (tag === "style") {
    const sanitized = sanitizeArtifactCss(element.textContent ?? "");
    if (sanitized) element.textContent = sanitized;
    else element.remove();
    return;
  }
  if (tag === "a") {
    const href = element.getAttribute("href")?.trim();
    if (!href || !href.startsWith("#") || /[\u0000-\u0020\u007f]/.test(href)) {
      element.removeAttribute("href");
    }
  }
  if (["img", "source"].includes(tag)) element.removeAttribute("src");
  for (const name of ["srcset", "poster", "xlink:href"]) element.removeAttribute(name);
  if (isSvg) {
    for (const name of [
      "fill",
      "filter",
      "marker-end",
      "marker-mid",
      "marker-start",
      "mask",
      "stroke",
    ]) {
      const value = element.getAttribute(name);
      if (value && containsUrlBearingCss(value)) element.removeAttribute(name);
    }
  }
  if (tag === "input") {
    const type = element.getAttribute("type")?.toLowerCase() ?? "";
    if (!ARTIFACT_INPUT_TYPES.has(type)) element.remove();
  }
  if (tag === "button") element.setAttribute("type", "button");
}

export function sanitizeArtifactHtml(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const sourceDocument = new DOMParser().parseFromString(html, "text/html");
  const sanitizedCss = Array.from(sourceDocument.querySelectorAll("style"))
    .map((style) => sanitizeArtifactCss(style.textContent ?? ""))
    .filter(Boolean)
    .join("\n");
  for (const style of Array.from(sourceDocument.querySelectorAll("style"))) style.remove();
  const sanitizerRootId = "opengeni-artifact-sanitizer-root";
  const purified = DOMPurify.sanitize(
    `<div><div id="${sanitizerRootId}">${sourceDocument.head.innerHTML}${sourceDocument.body.innerHTML}</div></div>`,
    {
      ALLOWED_TAGS: [...ARTIFACT_HTML_TAGS, ...ARTIFACT_SVG_TAGS].filter((tag) => tag !== "style"),
      ALLOWED_ATTR: [...ARTIFACT_ALLOWED_ATTRIBUTES],
      ALLOW_ARIA_ATTR: true,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: true,
    },
  );
  const document = new DOMParser().parseFromString(String(purified), "text/html");
  const root = document.getElementById(sanitizerRootId);
  if (!root || root.localName !== "div") return "";
  for (const element of Array.from(root.querySelectorAll("*"))) {
    sanitizeArtifactElement(element);
  }
  let styleHtml = "";
  if (sanitizedCss) {
    const style = document.createElement("style");
    style.textContent = sanitizedCss;
    styleHtml = style.outerHTML;
  }
  return `${styleHtml}${root.innerHTML}`;
}

export function buildArtifactSrcDoc(html: string): string {
  // The platform-owned policy is parsed before any untrusted source. Multiple
  // CSP declarations only intersect, so artifact HTML cannot loosen it.
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_SANDBOX_CSP}">${sanitizeArtifactHtml(html)}`;
}

export function buildArtifactDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildArtifactSrcDoc(html))}`;
}

export function ArtifactSandbox(props: {
  html: string;
  title: string;
  versionLabel?: string;
  className?: string;
  editDisabled?: boolean;
  onEdit?: () => void;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [focused, setFocused] = useState(false);
  const [running, setRunning] = useState(true);
  const src = useMemo(() => buildArtifactDataUrl(props.html), [props.html]);
  const reload = () => {
    setRunning(true);
    setReloadKey((value) => value + 1);
  };
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-white",
        focused && "fixed inset-0 z-50 flex flex-col border-0 bg-surface",
        props.className,
      )}
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {focused ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2"
              onClick={() => setFocused(false)}
            >
              <ArrowLeftIcon className="mr-2 size-3.5" />
              Back
            </Button>
          ) : null}
          <span className="truncate text-xs font-medium text-fg">{props.title}</span>
          {props.versionLabel ? (
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-fg-subtle">
              {props.versionLabel}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {focused && props.onEdit ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              disabled={props.editDisabled}
              onClick={props.onEdit}
            >
              <SparklesIcon className="mr-2 size-3.5" />
              <span className="hidden sm:inline">Edit with Geni</span>
              <span className="sm:hidden">Edit</span>
            </Button>
          ) : null}
          {running ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Stop artifact"
              onClick={() => setRunning(false)}
            >
              <SquareIcon className="size-3" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Reload artifact"
            onClick={reload}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          {!focused ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Open focus mode"
              onClick={() => setFocused(true)}
            >
              <Maximize2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
      {running ? (
        <iframe
          key={reloadKey}
          title={props.title}
          sandbox={ARTIFACT_IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          src={src}
          className={cn("h-[62vh] w-full border-0 bg-white", focused && "min-h-0 flex-1")}
        />
      ) : (
        <div
          className={cn(
            "flex h-[62vh] w-full flex-col items-center justify-center gap-2 bg-surface-2/30 text-center",
            focused && "min-h-0 flex-1",
          )}
        >
          <p className="text-sm font-medium text-fg">Artifact stopped</p>
          <p className="text-xs text-fg-subtle">
            Reload it when you are ready to preview it again.
          </p>
        </div>
      )}
    </section>
  );
}
