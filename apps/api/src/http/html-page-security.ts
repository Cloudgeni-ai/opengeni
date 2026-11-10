import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Content-Security-Policy for the small HTML pages the API renders itself
 * (GitHub connection pages, MCP OAuth consent, admin-consent and "you can
 * close this window" pages). Every inline `<script>` and `<style>` block is
 * allowed by its exact sha256 hash, so neither needs `'unsafe-inline'`, and
 * nothing else loads: no remote scripts, styles, frames or connections.
 * Inline event-handler and `style` attributes are not allowed; the pages use
 * neither.
 */
export type HtmlPageSecurityOptions = {
  /** Where the page's forms may submit: `'none'` (default) or this origin. */
  formAction?: "'none'" | "'self'";
};

const INLINE_BLOCK = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/giu;

function hashSource(content: string): string {
  return `'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`;
}

/** True when an inline `<script>` tag holds JavaScript (not a JSON data block). */
function isExecutableScript(attributes: string): boolean {
  if (/\bsrc\s*=/iu.test(attributes)) return false;
  const type = /\btype\s*=\s*["']?([^"'\s>]+)/iu.exec(attributes)?.[1]?.toLowerCase();
  return !type || type === "module" || type === "text/javascript" || type === "application/javascript";
}

/** The policy for one rendered page, hashing its inline blocks. */
export function htmlPageContentSecurityPolicy(
  html: string,
  options: HtmlPageSecurityOptions = {},
): string {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  for (const match of html.matchAll(INLINE_BLOCK)) {
    const [, tag, attributes = "", content = ""] = match;
    if (tag!.toLowerCase() === "style") styles.add(hashSource(content));
    else if (isExecutableScript(attributes)) scripts.add(hashSource(content));
  }
  const directives = ["default-src 'none'"];
  if (scripts.size > 0) directives.push(`script-src ${[...scripts].join(" ")}`);
  if (styles.size > 0) directives.push(`style-src ${[...styles].join(" ")}`);
  directives.push(
    "img-src 'self' data:",
    "font-src data:",
    `form-action ${options.formAction ?? "'none'"}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  );
  return directives.join("; ");
}

/** An HTML page response with its policy and the headers every API page carries. */
export function htmlPageResponse(
  html: string,
  init: { status?: number; headers?: HeadersInit } & HtmlPageSecurityOptions = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("content-security-policy", htmlPageContentSecurityPolicy(html, init));
  headers.set("x-content-type-options", "nosniff");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(html, { status: init.status ?? 200, headers });
}

/**
 * Gives an already-built first-party HTML page response its policy, unless it
 * has one. Reads the body, so use it only on routes whose HTML the API
 * rendered itself (never on proxied or stored content).
 */
export async function withHtmlPageSecurity(
  response: Response,
  options: HtmlPageSecurityOptions = {},
): Promise<Response> {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.startsWith("text/html") || response.headers.has("content-security-policy")) {
    return response;
  }
  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", htmlPageContentSecurityPolicy(html, options));
  headers.delete("content-length");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

/** Answers a Hono request with a first-party HTML page and its policy. */
export function htmlPage(
  c: Context,
  html: string,
  options: { status?: ContentfulStatusCode } & HtmlPageSecurityOptions = {},
): Response {
  c.header("content-security-policy", htmlPageContentSecurityPolicy(html, options));
  if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  return c.html(html, options.status ?? 200);
}
