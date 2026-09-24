import { PANEL } from "./components/agent-panel";
import { CodeScene } from "./components/code";
import { EndTagline } from "./components/end-card";
import { ProductWindow, WINDOW } from "./components/product";
import { Supers } from "./components/supers";
import { LiveDot } from "./components/primitives";
import { ease, keys, lerp, progress } from "./lib/anim";
import { C, F, H, W } from "./theme";
import { FPS, T } from "./timeline";

type Shot = { t: number; x: number; y: number; s: number; e?: (p: number) => number };

const PROOF = { x: 960, y: 540, s: 1.08 };

/** One continuous take. Each entry is a held framing; moves ease between them. */
const SHOTS: Shot[] = [
  { t: 0, x: 1532, y: 900, s: 2.2 }, // macro: the request being typed
  { t: 1.32, x: 1532, y: 900, s: 2.2 },
  { t: 2.25, x: 1540, y: 640, s: 1.45 }, // the assistant's reply
  { t: 3.72, x: 1540, y: 636, s: 1.48, e: ease.inOutSine },
  { t: 4.45, x: 1262, y: 596, s: 1.12 }, // …and the links it names, right there
  { t: 4.72, x: 1262, y: 596, s: 1.12 },
  { t: 5.55, x: 960, y: 540, s: 1.0 }, // the truth, then the missing piece
  { t: 10.95, x: 960, y: 540, s: 1.0 },
  { t: 11.7, ...PROOF }, // inside the product: one steady framing
  { t: T.endShrink[0], ...PROOF },
  { t: T.endShrink[1], x: 960, y: 540, s: 1.0 }, // the bookend
];

function camera(t: number) {
  const channel = (value: (shot: Shot) => number) =>
    keys(t, SHOTS.map((shot) => ({ t: shot.t, v: value(shot), e: shot.e ?? ease.camera })));
  // Zoom is interpolated in log space so push-ins feel constant-rate.
  return { x: channel((s) => s.x), y: channel((s) => s.y), s: Math.exp(channel((s) => Math.log(s.s))) };
}

/** The agent panel's rectangle on screen while the camera holds the proof framing. */
const PANEL_ON_SCREEN = (() => {
  const toX = (x: number) => W / 2 + (x - PROOF.x) * PROOF.s;
  const toY = (y: number) => H / 2 + (y - PROOF.y) * PROOF.s;
  const left = WINDOW.x + 2 + PANEL.x;
  const top = WINDOW.y + 2 + PANEL.y;
  return { x: toX(left), y: toY(top), w: PANEL.w * PROOF.s, h: PANEL.h * PROOF.s };
})();

/** Height of the panel header on screen; it stays pinned while the panel is open. */
export const OPEN_HEADER = 80 * PROOF.s;

/**
 * Container transform: the agent panel opens to fill the frame (keeping its header, so we
 * are visibly still inside it) and its surface becomes the page that shows its source.
 */
function PanelOpen({ t }: { t: number }) {
  if (t < T.zoomIn[0] || t > T.zoomOut[1] + 0.16) return null;
  const open = ease.inOutQuint(progress(t, T.zoomIn[0], T.zoomIn[1]));
  const close = ease.inOutQuint(progress(t, T.zoomOut[0], T.zoomOut[1]));
  const p = open * (1 - close);
  const vanish = ease.outCubic(progress(t, T.zoomOut[1] - 0.02, T.zoomOut[1] + 0.16));
  const composer = 1 - Math.min(1, p * 4);
  const r = PANEL_ON_SCREEN;
  const k = PROOF.s;
  return (
    <div
      style={{
        position: "absolute",
        left: lerp(r.x, 0, p),
        top: lerp(r.y, 0, p),
        width: lerp(r.w, W, p),
        height: lerp(r.h, H, p),
        background: C.surface,
        opacity: 1 - vanish,
        boxShadow: `inset ${2 * k}px 0 0 rgba(36,36,35,${1 - p})`,
      }}
    >
      <div
        style={{
          height: OPEN_HEADER,
          borderBottom: `${1.5 * k}px solid ${C.line}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `0 ${lerp(48 * k, 172, p)}px`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 * k }}>
          <LiveDot size={12 * k} />
          <span style={{ fontFamily: F.body, fontSize: 27 * k, fontWeight: 650, color: C.ink, letterSpacing: "-0.01em" }}>Agent</span>
        </div>
        <span style={{ fontFamily: F.mono, fontSize: 18 * k, letterSpacing: "0.12em", color: C.muted }}>OPENGENI</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 48 * k,
          right: 48 * k,
          bottom: 26 * k,
          height: 64 * k,
          border: `${1.5 * k}px solid ${C.line}`,
          opacity: composer,
          display: "flex",
          alignItems: "center",
          padding: `0 ${22 * k}px`,
          fontFamily: F.body,
          fontSize: 23 * k,
          color: C.faint,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        Ask about your trip…
      </div>
    </div>
  );
}

export function Film({ frame }: { frame: number }) {
  const t = frame / FPS;
  const cam = camera(t);
  return (
    <div style={{ position: "relative", width: W, height: H, overflow: "hidden", background: C.paper }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: W,
          height: H,
          transform: `translate(${W / 2 - cam.x * cam.s}px, ${H / 2 - cam.y * cam.s}px) scale(${cam.s})`,
          transformOrigin: "0 0",
        }}
      >
        <ProductWindow t={t} />
        <Supers t={t} />
        <EndTagline t={t} />
      </div>
      <PanelOpen t={t} />
      <CodeScene t={t} />
    </div>
  );
}
