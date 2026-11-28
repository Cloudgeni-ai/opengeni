/**
 * The live preview of a Site on an artifact card: the page as it looks when
 * opened, drawn at a desktop width and scaled into the card like a screenshot.
 *
 * The page's own scripts run, so apps drawn by script and styled from a CDN
 * show up, but nothing else does:
 *
 * - The document starts with `HTML_FRAME_PREVIEW_POLICY`, which blocks every
 *   call the page could make (fetch, XHR, WebSocket, beacons), frames and
 *   form submissions.
 * - There is no Site bridge. The Opengeni client (`createOpenGeniSiteClient`)
 *   is a stand-in whose calls never settle, so an app shows its loading state
 *   instead of an error, and reaches no workspace data, tools or AI.
 * - The host renders it in an opaque-origin frame (the HTML frame host with
 *   `allow-scripts` only) or an isolated mobile web view, never with the
 *   viewer's credentials.
 *
 * The Opengeni look (`/__opengeni/ui.css`) and charts are inlined. Once the
 * page has loaded and settled, it reports whether it painted anything
 * (`opengeni.site-preview.painted`), so the card can keep its type glyph
 * instead of showing a blank page.
 */
import { HTML_FRAME_PREVIEW_POLICY } from "@opengeni/contracts/html-frame-host";
import { resolveSiteUiStylesheet } from "./site-ui";

export { HTML_FRAME_PREVIEW_POLICY };

/** The width, in CSS pixels, a Site preview is laid out at before it is scaled down. */
export const SITE_PREVIEW_WIDTH = 1024;
/** The message a preview posts once it has settled: `{ type, painted }`. */
export const SITE_PREVIEW_PAINTED_MESSAGE = "opengeni.site-preview.painted";
/** How long after its load a preview waits before reporting (fonts, first render). */
export const SITE_PREVIEW_SETTLE_MS = 700;
/** A preview reports by this time even if its page never finishes loading. */
export const SITE_PREVIEW_REPORT_DEADLINE_MS = 8_000;
/** A host gives up on a preview that has not reported by this time. */
export const SITE_PREVIEW_TIMEOUT_MS = 10_000;

/*
 * Runs before the page. A stand-in Opengeni client (every call returns a
 * value whose `then` never settles), the theme for the Opengeni look, and the
 * report: after load, fonts and a short settle, does the body show any text,
 * media or a background of its own?
 */
function previewScript(theme: "light" | "dark" | undefined): string {
  return [
    `(()=>{"use strict";`,
    theme ? `document.documentElement.setAttribute("data-og-theme",${JSON.stringify(theme)});` : "",
    `const h={get:(t,k)=>k==="then"?()=>{}:k===Symbol.toPrimitive?()=>"":k===Symbol.iterator?function*(){}:p,apply:()=>p,construct:()=>p};`,
    `const p=new Proxy(function(){},h);`,
    `Object.defineProperty(globalThis,"createOpenGeniSiteClient",{configurable:true,writable:true,value:()=>p});`,
    `let done=false;`,
    `const blank=/^(transparent|rgba\\(0, 0, 0, 0\\)|rgb\\(255, 255, 255\\))$/;`,
    `const painted=()=>{try{const b=document.body;if(!b)return false;`,
    `if((b.innerText||"").trim())return true;`,
    `if(document.querySelector("img,svg,canvas,video,picture,object,embed"))return true;`,
    `return [document.documentElement,b].some((e)=>!blank.test(getComputedStyle(e).backgroundColor));}catch{return false;}};`,
    // A page with no background of its own gets its canvas color (white, or
    // dark for a page that follows a dark theme), so its text never lands on
    // the card's backdrop. Set only now: a background on <html> would stop the
    // body's from filling the page.
    `const clear=/^(transparent|rgba\\(0, 0, 0, 0\\))$/;`,
    `const canvas=()=>{try{const r=document.documentElement;if([r,document.body].every((e)=>e&&clear.test(getComputedStyle(e).backgroundColor)))r.style.backgroundColor="Canvas";}catch{}};`,
    `const report=()=>{if(done)return;done=true;const m={type:${JSON.stringify(SITE_PREVIEW_PAINTED_MESSAGE)},painted:painted()};if(m.painted)canvas();`,
    `try{const n=window.ReactNativeWebView;if(n)n.postMessage(JSON.stringify(m));else parent.postMessage(m,"*");}catch{}};`,
    `const settle=()=>{const f=document.fonts&&document.fonts.ready;`,
    `Promise.race([f||Promise.resolve(),new Promise((r)=>setTimeout(r,1500))]).then(()=>setTimeout(report,${SITE_PREVIEW_SETTLE_MS}),()=>setTimeout(report,${SITE_PREVIEW_SETTLE_MS}));};`,
    `if(document.readyState==="complete")settle();else addEventListener("load",settle,{once:true});`,
    `setTimeout(report,${SITE_PREVIEW_REPORT_DEADLINE_MS});`,
    `})();`,
  ].join("");
}

/** The optional `<script src="/__opengeni/site-tools/client.js"></script>` tag. */
const SITE_CLIENT_SCRIPT_TAG =
  /^<script\s+src\s*=\s*(["'])\/__opengeni\/site-tools\/client\.js\1\s*>\s*<\/script\s*>$/i;

/**
 * The document an artifact card renders for a Site's published HTML. The
 * policy is its first element, so it always lands in `<head>` ahead of
 * anything the page declares.
 */
export function sitePreviewDocument(
  html: string,
  options: { theme?: "light" | "dark" | undefined } = {},
): string {
  // The real client would wait for a bridge that never comes; the stand-in
  // defined ahead of the page takes its place. Comments and scripts are
  // consumed whole, so examples inside them stay literal.
  const page = resolveSiteUiStylesheet(html).replace(
    /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
    (tag) => (SITE_CLIENT_SCRIPT_TAG.test(tag) ? "" : tag),
  );
  return (
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_FRAME_PREVIEW_POLICY}">` +
    `<script>${previewScript(options.theme)}</script>` +
    `<style>html,body{overflow:hidden!important;scrollbar-width:none}::-webkit-scrollbar{display:none}</style>` +
    page
  );
}

/**
 * Whether a message is a preview's report, and what it says: `true` it
 * painted, `false` it stayed blank, `null` not a report. Accepts the object a
 * frame posts and the JSON string a mobile web view delivers.
 */
export function sitePreviewPainted(data: unknown): boolean | null {
  let value = data;
  if (typeof value === "string") {
    if (!value.includes(SITE_PREVIEW_PAINTED_MESSAGE)) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as { type?: unknown; painted?: unknown };
  if (message.type !== SITE_PREVIEW_PAINTED_MESSAGE || typeof message.painted !== "boolean")
    return null;
  return message.painted;
}
