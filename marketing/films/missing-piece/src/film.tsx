import { PANEL } from "./components/agent-panel";
import { CodeScene } from "./components/code";
import { EndTagline } from "./components/end-card";
import { ProductWindow, WINDOW } from "./components/product";
import { Supers } from "./components/supers";
import { ease, keys, lerp, progress } from "./lib/anim";
import { C, H, W } from "./theme";
import { FPS, T } from "./timeline";

type Shot = { t: number; x: number; y: number; s: number; e?: (p: number) => number };

const PROOF = { x: 990, y: 556, s: 1.14 };

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

/** The agent panel's conversation area on screen while the camera holds the proof framing. */
const PANEL_ON_SCREEN = (() => {
  const toX = (x: number) => W / 2 + (x - PROOF.x) * PROOF.s;
  const toY = (y: number) => H / 2 + (y - PROOF.y) * PROOF.s;
  const left = WINDOW.x + 2 + PANEL.x + 2;
  const top = WINDOW.y + 2 + PANEL.y + 81;
  const bottom = WINDOW.y + 2 + PANEL.y + PANEL.h - 108;
  return { x: toX(left), y: toY(top), w: (PANEL.w - 2) * PROOF.s, h: (bottom - top) * PROOF.s };
})();

/**
 * Container transform: the agent panel's conversation area opens to fill the frame and its
 * surface becomes the page that shows the code behind it; afterwards it folds back.
 */
function PanelOpen({ t }: { t: number }) {
  if (t < T.zoomIn[0] || t > T.zoomOut[1] + 0.16) return null;
  const open = ease.inOutQuint(progress(t, T.zoomIn[0], T.zoomIn[1]));
  const close = ease.inOutQuint(progress(t, T.zoomOut[0], T.zoomOut[1]));
  const p = open * (1 - close);
  const vanish = ease.outCubic(progress(t, T.zoomOut[1] - 0.04, T.zoomOut[1] + 0.16));
  const edge = Math.min(1, p * 6) * (1 - p);
  const r = PANEL_ON_SCREEN;
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
        boxShadow: `inset ${2.3 * edge}px 0 0 ${C.ink}, inset 0 ${1.7 * edge}px 0 ${C.line}, inset 0 -${1.7 * edge}px 0 ${C.line}`,
      }}
    />
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
