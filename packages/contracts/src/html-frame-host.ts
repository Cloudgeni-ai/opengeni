/**
 * The HTML frame host: a tiny page that renders agent-authored HTML (chat
 * visualizations, HTML artifacts, published Sites in the console) inside an
 * opaque-origin sandboxed iframe, outside the console's own document.
 *
 * A `srcdoc` frame inherits the Content-Security-Policy of the page that
 * embeds it, so a strict console policy would also apply to (and break)
 * every agent-authored page. The frame host is a separate document with its
 * own response policy: it is served on the Sites domain
 * (`https://og.<sites domain>/_og/html-frame`, by the Sites gateway) or, on a
 * deployment without a Sites domain, on the console's own origin. Either way
 * the frame keeps the same sandbox flags as before and never gets
 * `allow-same-origin`, so the HTML still runs in an opaque origin.
 *
 * Protocol (all messages carry `version: 1`):
 * 1. The embedder loads `<frame host URL>?parent=<embedder origin>`.
 * 2. The loader posts `ready` to that parent origin.
 * 3. The embedder checks the message came from its own frame's window, then
 *    posts `render` with the HTML (to `*`: an opaque origin cannot be named).
 * 4. The loader accepts `render` only from `window.parent` with the exact
 *    `parent` origin, writes the HTML as its document, and posts `loaded`
 *    once that document has loaded.
 *
 * Keep this module dependency-free: the Sites gateway Worker, the web server
 * and the React components share it.
 */

/** Path of the frame host page, on the Sites frame host or the console origin. */
export const HTML_FRAME_HOST_PATH = "/_og/html-frame";
/**
 * The reserved Sites hostname label that serves the frame host
 * (`og.<sites domain>`). No Site can take it (see
 * `SITE_RESERVED_HOSTNAME_LABELS`).
 */
export const HTML_FRAME_HOST_LABEL = "og";
/** Query parameter naming the embedding page's origin. */
export const HTML_FRAME_HOST_PARENT_PARAM = "parent";

export const HTML_FRAME_HOST_MESSAGE = {
  ready: "opengeni.html-frame.ready",
  render: "opengeni.html-frame.render",
  loaded: "opengeni.html-frame.loaded",
} as const;
export const HTML_FRAME_HOST_VERSION = 1;

/**
 * `interactive` runs the HTML as is. `still` renders a picture of it: the
 * written document starts with a policy that blocks every script and network
 * request (the gallery card of a Site).
 */
export type HtmlFrameRenderMode = "interactive" | "still";

/** The policy a `still` render writes first into its document. */
export const HTML_FRAME_STILL_POLICY =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'";

/**
 * Sandbox flags for the frame host. Never `allow-same-origin`: the HTML runs
 * in an opaque origin, exactly as it did in a `srcdoc` frame.
 */
export const HTML_FRAME_HOST_SANDBOX = [
  "allow-downloads",
  "allow-forms",
  "allow-modals",
  "allow-orientation-lock",
  "allow-pointer-lock",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-presentation",
  "allow-scripts",
].join(" ");

/**
 * Response Content-Security-Policy of the frame host page. The page must run
 * whatever the agent-authored HTML needs (inline scripts, CDN libraries,
 * images from anywhere), so it sets no fetch directives; it is isolated
 * instead: `sandbox` repeats the frame's sandbox so a direct visit is just as
 * isolated, and only the named console origin(s) may frame it.
 */
export function htmlFrameHostContentSecurityPolicy(frameAncestors: readonly string[]): string {
  const ancestors = frameAncestors.length > 0 ? frameAncestors.join(" ") : "'none'";
  return `sandbox ${HTML_FRAME_HOST_SANDBOX}; frame-ancestors ${ancestors}`;
}

/** The frame host URL an embedder at `parentOrigin` loads. */
export function htmlFrameHostUrl(frameHostBase: string, parentOrigin: string): string {
  const url = new URL(HTML_FRAME_HOST_PATH, frameHostBase);
  url.searchParams.set(HTML_FRAME_HOST_PARENT_PARAM, parentOrigin);
  return url.toString();
}

/** The frame host base (`https://og.<domain>`) for a Sites domain. */
export function sitesHtmlFrameHostOrigin(sitesDomain: string): string {
  return `https://${HTML_FRAME_HOST_LABEL}.${sitesDomain.trim().toLowerCase().replace(/\.$/u, "")}`;
}

// The loader. It runs once, before any agent-authored HTML: it learns the
// embedder's origin from its own URL, announces itself, accepts exactly one
// render from that origin, and replaces its document with the HTML.
const LOADER_SCRIPT = [
  `(()=>{"use strict";`,
  `const M=${JSON.stringify(HTML_FRAME_HOST_MESSAGE)},V=${HTML_FRAME_HOST_VERSION};`,
  `const S=${JSON.stringify(HTML_FRAME_STILL_POLICY)};`,
  `let parentOrigin=null;`,
  `try{const value=new URL(location.href).searchParams.get(${JSON.stringify(HTML_FRAME_HOST_PARENT_PARAM)});`,
  `const url=value&&new URL(value);`,
  `if(url&&(url.protocol==="https:"||url.protocol==="http:")&&url.origin===value)parentOrigin=url.origin;}catch{}`,
  `if(!parentOrigin||window.parent===window)return;`,
  `let done=false;`,
  `const receive=(event)=>{`,
  `if(done||event.source!==window.parent||event.origin!==parentOrigin)return;`,
  `const data=event.data;`,
  `if(!data||data.type!==M.render||data.version!==V||typeof data.html!=="string")return;`,
  `done=true;`,
  `removeEventListener("message",receive);`,
  `const html=data.mode==="still"?'<!doctype html><meta http-equiv="Content-Security-Policy" content="'+S+'"><meta name="color-scheme" content="light">'+data.html:data.html;`,
  `const target=window.parent,origin=parentOrigin;`,
  `document.open();`,
  `addEventListener("load",()=>target.postMessage({type:M.loaded,version:V},origin),{once:true});`,
  `document.write(html);`,
  `document.close();`,
  `};`,
  `addEventListener("message",receive);`,
  `window.parent.postMessage({type:M.ready,version:V},parentOrigin);`,
  `})();`,
].join("\n");

/** The frame host page: an empty document whose only script is the loader. */
export const HTML_FRAME_HOST_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"></head><body><script>${LOADER_SCRIPT}</script></body></html>`;
