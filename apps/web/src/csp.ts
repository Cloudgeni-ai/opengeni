import { createHash, randomBytes } from "node:crypto";

import {
  HTML_FRAME_HOST_DOCUMENT,
  OFFICE_FRAME_ANCESTOR_ORIGINS,
  htmlFrameHostContentSecurityPolicy,
} from "@opengeni/contracts/html-frame-host";

/**
 * The console's Content-Security-Policy.
 *
 * Every HTML page the web server sends carries an enforced policy built here:
 * a fixed base (`'self'` plus inline `data:`/`blob:` media), the SHA-256
 * hashes of the page's own inline scripts (computed from the exact bytes
 * served, so they cannot drift from the build), and the external origins the
 * API reports for this deployment (`GET /v1/config/content-security`: the
 * storage account, relay and sandbox tunnels, Turnstile, analytics, avatars,
 * catalog logos and the Sites frame host). There is no scheme-only source and
 * no `*`.
 *
 * Agent-authored HTML does not run under this policy: it renders in the HTML
 * frame host (`@opengeni/contracts/html-frame-host`), a separate document on
 * the Sites domain. Images from origins not listed here go through the API's
 * image proxy. The page learns both from a JSON block the server writes into
 * the HTML (`opengeni-content-hosting`), so the page and its policy always
 * agree.
 *
 * Style elements need the page's per-response nonce (`style-src-elem`): the
 * console's UI libraries create `<style>` elements with runtime-computed CSS
 * (toasts, Radix scroll locking, the xterm terminal, the diff viewer, find
 * highlights), so a small hashed bootstrap script (`STYLE_NONCE_BOOTSTRAP`)
 * stamps the nonce on every style element the page's own code creates. A
 * `<style>` that arrives as markup (injected HTML) gets no nonce and is
 * refused. Style attributes stay allowed (`style-src-attr 'unsafe-inline'`):
 * highlighted code and math are rendered as HTML with `style` attributes,
 * and no hash or nonce can allow an attribute. Browsers without the split
 * directives fall back to `style-src`, which carries the nonce.
 */

/** What the API reports for this deployment. */
export type ConsoleContentSecuritySources = {
  version: 1;
  directives: Partial<Record<ApiDirective, string[]>>;
  htmlFrameHost: string | null;
  imageProxyPath: string;
  /** Absolute proxy URL when the API is on another origin than the console. */
  imageProxyUrl?: string;
};

type ApiDirective =
  | "connect-src"
  | "img-src"
  | "media-src"
  | "script-src"
  | "frame-src"
  | "form-action";

export const CONTENT_SECURITY_PATH = "/v1/config/content-security";
export const DEFAULT_IMAGE_PROXY_PATH = "/v1/image-proxy";
export const CONTENT_HOSTING_ELEMENT_ID = "opengeni-content-hosting";
/** Same-origin HTML frame host, served only when there is no Sites frame host. */
export const SAME_ORIGIN_HTML_FRAME_HOST_PATH = "/_og/html-frame";

/** The Excel add-in's pages run in Office's frames and load office.js. */
export const OFFICE_FRAME_ANCESTORS = ["'self'", ...OFFICE_FRAME_ANCESTOR_ORIGINS] as const;
/**
 * office.js and what it loads itself: Office's host scripts from the same
 * CDN, Microsoft Ajax on older Office versions and the MSAL library for
 * single sign-on.
 */
export const OFFICE_SCRIPT_SOURCES = [
  "https://appsforoffice.microsoft.com",
  "https://ajax.aspnetcdn.com",
  "https://alcdn.msauth.net",
] as const;

const DIRECTIVE_ORDER = [
  "default-src",
  "script-src",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "media-src",
  "font-src",
  "connect-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
] as const;
type Directive = (typeof DIRECTIVE_ORDER)[number];
type Policy = Record<Directive, string[]>;

export type PageKind = "console" | "office";

export type ConsolePolicyInput = {
  kind: PageKind;
  /** The console's public origin, for its own WebSocket origin. */
  publicOrigin?: string | undefined;
  sources: ConsoleContentSecuritySources | null;
  /** `'sha256-…'` sources for the page's inline scripts. */
  scriptHashes: readonly string[];
  /** This response's nonce for style elements (see `STYLE_NONCE_BOOTSTRAP`). */
  styleNonce?: string;
  /** Whether this server serves the same-origin frame host (already 'self'). */
  sameOriginFrameHost?: boolean;
};

function basePolicy(): Policy {
  return {
    "default-src": ["'self'"],
    // WebAssembly (document and spreadsheet kernels, syntax highlighting)
    // compiles under 'wasm-unsafe-eval'; JavaScript eval stays blocked.
    "script-src": ["'self'", "'wasm-unsafe-eval'"],
    "style-src": ["'self'"],
    "style-src-elem": ["'self'"],
    "style-src-attr": ["'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "media-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    // pdf.js and other previews fetch the blob: URLs the console creates for
    // downloaded file bytes.
    "connect-src": ["'self'", "blob:"],
    "frame-src": ["'self'"],
    "child-src": ["'self'", "blob:"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'self'"],
  };
}

/** A source the policy may carry: never `*` or a bare scheme. */
export function isExactSource(source: string): boolean {
  if (source === "*" || /^[a-z][a-z0-9+.-]*:$/iu.test(source)) return false;
  if (/^'[^']+'$/u.test(source)) return true;
  return /^(?:https|wss|http|ws):\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/iu.test(source);
}

export function buildContentSecurityPolicy(input: ConsolePolicyInput): string {
  const policy = basePolicy();
  const add = (directive: Directive, values: readonly string[]) => {
    for (const value of values)
      if (isExactSource(value) && !policy[directive].includes(value)) policy[directive].push(value);
  };
  add("script-src", input.scriptHashes);
  if (input.styleNonce) {
    add("style-src", [`'nonce-${input.styleNonce}'`]);
    add("style-src-elem", [`'nonce-${input.styleNonce}'`]);
  }
  const self = input.publicOrigin ? safeOrigin(input.publicOrigin) : null;
  if (self) {
    // 'self' covers same-origin WebSockets in current browsers; the explicit
    // origin covers older ones.
    add("connect-src", [self.replace(/^http(s?):/u, "ws$1:")]);
  }
  for (const [directive, values] of Object.entries(input.sources?.directives ?? {})) {
    if (!values || !(DIRECTIVE_ORDER as readonly string[]).includes(directive)) continue;
    add(directive as Directive, values);
    // Frames also match child-src in browsers without frame-src.
    if (directive === "frame-src") add("child-src", values);
  }
  if (input.kind === "office") {
    policy["frame-ancestors"] = [...OFFICE_FRAME_ANCESTORS];
    add("script-src", OFFICE_SCRIPT_SOURCES);
  }
  return DIRECTIVE_ORDER.map((directive) => `${directive} ${policy[directive].join(" ")}`).join(
    "; ",
  );
}

/** The content hosting a page gets, matching its policy (see content-security-boot.ts). */
export function contentHostingFor(
  sources: ConsoleContentSecuritySources | null,
  publicOrigin: string | undefined,
): { htmlFrameHost: string; imageProxy: { url: string; directOrigins: string[] } } {
  const htmlFrameHost = sources?.htmlFrameHost ?? "self";
  const directOrigins = (sources?.directives["img-src"] ?? []).filter(
    (source) => isExactSource(source) && !source.startsWith("'") && !source.includes("*"),
  );
  const self = publicOrigin ? safeOrigin(publicOrigin) : null;
  if (self) directOrigins.push(self);
  return {
    htmlFrameHost,
    imageProxy: {
      url: sources?.imageProxyUrl ?? sources?.imageProxyPath ?? DEFAULT_IMAGE_PROXY_PATH,
      directOrigins,
    },
  };
}

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
const NON_JAVASCRIPT_TYPE =
  /\btype\s*=\s*["']?(?!module\b|text\/javascript\b|application\/javascript\b)[^"'\s>]+/iu;

/** `'sha256-…'` sources for every inline JavaScript block in `html`. */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const attributes = match[1] ?? "";
    if (/\bsrc\s*=/iu.test(attributes) || NON_JAVASCRIPT_TYPE.test(attributes)) continue;
    const digest = createHash("sha256")
      .update(match[2] ?? "", "utf8")
      .digest("base64");
    hashes.add(`'sha256-${digest}'`);
  }
  return [...hashes].sort();
}

/**
 * Stands in for the per-response style nonce in a rendered page and its
 * policy; `withStyleNonce` swaps in a fresh value for every response.
 */
export const STYLE_NONCE_PLACEHOLDER = "__OPENGENI_STYLE_NONCE__";
const STYLE_NONCE_META_PROPERTY = "csp-nonce";

/**
 * Runs before any other script: reads the response's style nonce from the
 * `csp-nonce` meta element (the browser hides the attribute but keeps the
 * `nonce` property) and stamps it on every `<style>` element the page's code
 * creates, whichever library creates it. Static, so its hash is stable.
 */
export const STYLE_NONCE_BOOTSTRAP =
  `(()=>{const m=document.querySelector('meta[property="${STYLE_NONCE_META_PROPERTY}"]');` +
  `const n=m&&m.nonce;if(!n)return;const p=Document.prototype,c=p.createElement,s=p.createElementNS;` +
  `const t=(e)=>{if(e instanceof Element&&e.localName==="style")e.setAttribute("nonce",n);return e};` +
  `p.createElement=function(){return t(c.apply(this,arguments))};` +
  `p.createElementNS=function(){return t(s.apply(this,arguments))};})();`;

/**
 * Put the style-nonce meta element and its bootstrap first in `<head>` (with
 * the placeholder nonce), and give the page's own `<style>` blocks the nonce.
 */
export function withStyleNonceBootstrap(html: string): string {
  const block =
    `<meta property="${STYLE_NONCE_META_PROPERTY}" nonce="${STYLE_NONCE_PLACEHOLDER}">` +
    `<script id="opengeni-style-nonce">${STYLE_NONCE_BOOTSTRAP}</script>`;
  // Stamp `<style>` tags outside script bodies only, so a script's text (and
  // so its hash) never contains the per-response nonce.
  const stamped = html
    .split(/(<script\b[\s\S]*?<\/script>)/iu)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(/<style\b(?![^>]*\bnonce=)/giu, `<style nonce="${STYLE_NONCE_PLACEHOLDER}"`),
    )
    .join("");
  const head = /<head\b[^>]*>/iu.exec(stamped);
  if (!head) return `${block}${stamped}`;
  const at = head.index + head[0].length;
  return `${stamped.slice(0, at)}${block}${stamped.slice(at)}`;
}

/** A fresh style nonce for one response (base64, 128 bits). */
export function createStyleNonce(): string {
  return randomBytes(16).toString("base64");
}

/** Write the page's content hosting into its `<head>` as inert JSON. */
export function withContentHosting(html: string, hosting: unknown): string {
  const json = JSON.stringify(hosting)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026");
  const block = `<script type="application/json" id="${CONTENT_HOSTING_ELEMENT_ID}">${json}</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${block}</head>`) : `${block}${html}`;
}

/** The same-origin HTML frame host page and its policy. */
export function sameOriginHtmlFrameHostResponse(method: string): Response {
  return new Response(method === "HEAD" ? null : HTML_FRAME_HOST_DOCUMENT, {
    headers: {
      "content-type": "text/html;charset=utf-8",
      "cache-control": "public, max-age=3600",
      // The console frames it, including inside Office (the Excel add-in);
      // X-Frame-Options cannot name Office's hosts, so it is not sent.
      "content-security-policy": htmlFrameHostContentSecurityPolicy(OFFICE_FRAME_ANCESTORS),
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    },
  });
}

function absoluteProxyUrl(value: string): boolean {
  const origin = safeOrigin(value);
  return origin !== null && /^\/[A-Za-z0-9/_-]+$/u.test(value.slice(origin.length));
}

function safeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Parse and check the API's answer; anything malformed counts as unavailable. */
export function parseContentSecuritySources(value: unknown): ConsoleContentSecuritySources | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !record.directives || typeof record.directives !== "object")
    return null;
  const directives: Partial<Record<ApiDirective, string[]>> = {};
  for (const directive of [
    "connect-src",
    "img-src",
    "media-src",
    "script-src",
    "frame-src",
    "form-action",
  ] as const) {
    const values = (record.directives as Record<string, unknown>)[directive];
    if (values === undefined) continue;
    if (!Array.isArray(values)) return null;
    directives[directive] = values.filter(
      (entry): entry is string => typeof entry === "string" && isExactSource(entry),
    );
  }
  const htmlFrameHost =
    typeof record.htmlFrameHost === "string" &&
    safeOrigin(record.htmlFrameHost) === record.htmlFrameHost
      ? record.htmlFrameHost
      : null;
  const imageProxyPath =
    typeof record.imageProxyPath === "string" && /^\/[A-Za-z0-9/_-]+$/u.test(record.imageProxyPath)
      ? record.imageProxyPath
      : DEFAULT_IMAGE_PROXY_PATH;
  const imageProxyUrl =
    typeof record.imageProxyUrl === "string" && absoluteProxyUrl(record.imageProxyUrl)
      ? record.imageProxyUrl
      : undefined;
  return {
    version: 1,
    directives,
    htmlFrameHost,
    imageProxyPath,
    ...(imageProxyUrl ? { imageProxyUrl } : {}),
  };
}

export type ContentSecuritySourceLoader = {
  /** The latest sources, or null before the first answer / without an API. */
  current(): ConsoleContentSecuritySources | null;
  /** Resolves after the first attempt (success or not). */
  ready: Promise<void>;
  /** Increments whenever the sources change. */
  generation(): number;
  stop(): void;
};

/**
 * Read the sources from the API at startup, then refresh them, so a
 * configuration change reaches the policy without a web restart. Until the
 * first answer (or without an API) pages get the base policy.
 */
export function loadContentSecuritySources(options: {
  apiBaseUrl: string | undefined;
  fetch?: typeof fetch;
  refreshMs?: number;
  /** Longest wait between retries after a failure; retries start at 1 second. */
  retryMs?: number;
  timeoutMs?: number;
  /** Where failures are reported (once per run of failures). */
  warn?: (message: string) => void;
}): ContentSecuritySourceLoader {
  let sources: ConsoleContentSecuritySources | null = null;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const doFetch = options.fetch ?? fetch;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let failures = 0;
  const failed = (reason: string): false => {
    failures += 1;
    if (failures === 1) {
      warn(
        `Opengeni web: could not read the content-security sources from the API (${reason}); ` +
          (sources
            ? "pages keep the last policy until it answers."
            : "pages get the base policy until it answers."),
      );
    }
    return false;
  };
  const load = async (): Promise<boolean> => {
    if (!options.apiBaseUrl) return false;
    try {
      const url = new URL(CONTENT_SECURITY_PATH.slice(1), withSlash(options.apiBaseUrl));
      const response = await doFetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (!response.ok) return failed(`HTTP ${response.status}`);
      const next = parseContentSecuritySources(await response.json());
      if (!next) return failed("malformed answer");
      if (JSON.stringify(next) !== JSON.stringify(sources)) {
        sources = next;
        generation += 1;
      }
      if (failures > 0) console.info("Opengeni web: content-security sources loaded.");
      failures = 0;
      return true;
    } catch (error) {
      return failed(error instanceof Error ? error.name : "request failed");
    }
  };
  const schedule = (ok: boolean) => {
    if (stopped || !options.apiBaseUrl) return;
    // After a failure, retry quickly at first (1, 2, 4, 8 seconds...).
    const retry = Math.min(options.retryMs ?? 10_000, 1_000 * 2 ** Math.max(0, failures - 1));
    timer = setTimeout(
      () => void load().then(schedule),
      ok ? (options.refreshMs ?? 5 * 60_000) : retry,
    );
    (timer as { unref?: () => void }).unref?.();
  };
  const ready = load().then((ok) => schedule(ok));
  return {
    current: () => sources,
    ready,
    generation: () => generation,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function withSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
