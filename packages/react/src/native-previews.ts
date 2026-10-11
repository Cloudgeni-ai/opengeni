/**
 * DOM-free building blocks for showing agent previews outside a browser page
 * (React Native web views): the same documents and loading surface the web
 * chat uses, as strings and pure functions.
 */
import { PREVIEW_LOADING_COLORS } from "./preview-loading-paint";

export { inlineHtmlDocument } from "./components/artifacts/inline-html-document";
export {
  loadSiteSnapshot,
  type SiteDisplayContent,
  type SiteSnapshotReadClient,
} from "./site-snapshot";
export { paintPreviewLoading, PREVIEW_LOADING_COLORS } from "./preview-loading-paint";

/** Fence languages the assistant uses for interactive previews. */
export type InteractivePreviewKind = "html" | "site";

export function interactivePreviewKind(language: string): InteractivePreviewKind | null {
  return language === "opengeni-html" ? "html" : language === "opengeni-site" ? "site" : null;
}

/** A Site fence body: `{"siteId": "…", "versionId"?: "…"}`; null when malformed. */
export function parseSiteFence(content: string): { siteId: string; versionId?: string } | null {
  try {
    const value = JSON.parse(content) as { siteId?: unknown; versionId?: unknown };
    const uuid = /^[0-9a-f-]{36}$/i;
    if (!value || typeof value.siteId !== "string" || !uuid.test(value.siteId)) return null;
    if (value.versionId === undefined) return { siteId: value.siteId };
    return typeof value.versionId === "string" && uuid.test(value.versionId)
      ? { siteId: value.siteId, versionId: value.versionId }
      : null;
  } catch {
    return null;
  }
}

/**
 * Script source of `paintPreviewLoading` (kept in lockstep by a test), for
 * documents that run outside this bundle. Release React Native builds compile
 * functions to bytecode, so `Function.prototype.toString` cannot be used.
 */
export const PREVIEW_LOADING_PAINT_SCRIPT = `function paintPreviewLoading(context,width,height,time,ink,glowColor){
context.clearRect(0,0,width,height);
const cx=width*(0.5+0.13*Math.sin(time*0.21));
const cy=height*(0.5+0.12*Math.cos(time*0.27));
const glow=context.createRadialGradient(cx,cy,0,cx,cy,Math.max(width,height)*0.65);
glow.addColorStop(0,glowColor);glow.addColorStop(1,"transparent");
context.globalAlpha=0.09;context.fillStyle=glow;context.fillRect(0,0,width,height);
const rows=Math.ceil(height/18)+7;const cols=Math.ceil(width/18)+7;
const points=Array.from({length:rows},(_row,r)=>Array.from({length:cols},(_col,c)=>{
const x=(c-3)*18;const y=(r-3)*18;const dist=Math.hypot((x-cx)*0.8,y-cy);
const wave=Math.sin(dist*0.032-time*0.95);
return {x:x+((x-cx)/Math.max(dist,1))*wave*4,y:y+((y-cy)/Math.max(dist,1))*wave*4,l:Math.pow((wave+1)/2,5)};}));
context.strokeStyle=ink;context.fillStyle=ink;context.lineWidth=0.65;
points.forEach((row,r)=>row.forEach((p,c)=>{
context.globalAlpha=0.035+p.l*0.055;context.beginPath();
if(c+1<cols){context.moveTo(p.x,p.y);context.lineTo(row[c+1].x,row[c+1].y);}
if(r+1<rows){context.moveTo(p.x,p.y);context.lineTo(points[r+1][c].x,points[r+1][c].y);}
context.stroke();
context.globalAlpha=0.15+p.l*0.55;context.beginPath();
context.arc(p.x,p.y,0.85+p.l*0.65,0,Math.PI*2);context.fill();}));
context.globalAlpha=1;}`;

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

/**
 * A standalone page for the web's "Preparing preview…" surface: the animated
 * ripple filling the page with a steady label, for a web view while the
 * assistant is still writing the preview. Never contains the unfinished fence.
 */
export function previewLoadingDocument(options: {
  scheme: "light" | "dark";
  label?: string;
  labelColor?: string;
  reducedMotion?: boolean;
}): string {
  const colors = PREVIEW_LOADING_COLORS[options.scheme];
  const label = escapeHtml(options.label ?? "Preparing preview…");
  const labelColor = options.labelColor ?? (options.scheme === "dark" ? "#a1a1a1" : "#6b6b6b");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>
html,body{margin:0;height:100%;overflow:hidden;background:${colors.background};-webkit-user-select:none;user-select:none}
canvas{position:fixed;inset:0;width:100%;height:100%;display:block}
span{position:fixed;left:16px;bottom:14px;color:${labelColor};font:400 12px/16px -apple-system,system-ui,sans-serif}
</style></head><body><canvas aria-hidden="true"></canvas><span role="status">${label}</span><script>
${PREVIEW_LOADING_PAINT_SCRIPT}
(()=>{const canvas=document.querySelector("canvas");const context=canvas.getContext("2d");if(!context)return;
const still=${options.reducedMotion === true};let time=2;let last;
const draw=()=>{const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;const d=Math.min(window.devicePixelRatio||1,2);
if(canvas.width!==Math.round(w*d)||canvas.height!==Math.round(h*d)){canvas.width=Math.round(w*d);canvas.height=Math.round(h*d);}
context.setTransform(d,0,0,d,0,0);paintPreviewLoading(context,w,h,time,${JSON.stringify(colors.ink)},${JSON.stringify(colors.glow)});};
const tick=(stamp)=>{if(!document.hidden){if(last!==undefined)time+=Math.min((stamp-last)/1000,0.05);last=stamp;draw();}else last=undefined;requestAnimationFrame(tick);};
window.addEventListener("resize",draw);draw();if(!still)requestAnimationFrame(tick);})();
</script></body></html>`;
}
