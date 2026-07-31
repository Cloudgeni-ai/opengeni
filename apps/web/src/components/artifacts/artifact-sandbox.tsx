import {
  ArrowLeftIcon,
  Maximize2Icon,
  RefreshCwIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const ARTIFACT_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "media-src data:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
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
const ARTIFACT_DATA_URL = /^data:(?:image|audio|video|font)\//i;

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
    if (!allowedAttribute || name.startsWith("on")) {
      element.removeAttribute(attribute.name);
    }
  }

  if (tag === "a") {
    const href = element.getAttribute("href");
    if (href && !href.startsWith("#")) element.removeAttribute("href");
  }
  if (["img", "source"].includes(tag)) {
    const src = element.getAttribute("src");
    if (src && !ARTIFACT_DATA_URL.test(src)) element.removeAttribute("src");
  }
  if (tag === "input") {
    const type = element.getAttribute("type")?.toLowerCase() ?? "";
    if (!ARTIFACT_INPUT_TYPES.has(type)) element.remove();
  }
  if (tag === "button") element.setAttribute("type", "button");
}

export function sanitizeArtifactHtml(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const element of Array.from(document.querySelectorAll("*"))) {
    sanitizeArtifactElement(element);
  }
  return `${document.head.innerHTML}${document.body.innerHTML}`;
}

export function buildArtifactSrcDoc(html: string): string {
  // The platform-owned policy is parsed before any untrusted source. Multiple
  // CSP declarations only intersect, so artifact HTML cannot loosen it.
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_SANDBOX_CSP}">${sanitizeArtifactHtml(html)}`;
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
  const srcDoc = useMemo(() => buildArtifactSrcDoc(props.html), [props.html]);
  const reload = () => {
    setRunning(true);
    setReloadKey((value) => value + 1);
  };
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-white",
        focused && "fixed inset-0 z-50 flex flex-col rounded-none border-0 bg-surface",
        props.className,
      )}
    >
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-2 py-1.5 sm:px-3">
        <div className="flex min-w-0 items-center gap-2">
          {focused ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2"
              onClick={() => setFocused(false)}
            >
              <ArrowLeftIcon className="mr-1.5 size-3.5" />
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
              <SparklesIcon className="mr-1.5 size-3.5" />
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
          srcDoc={srcDoc}
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
