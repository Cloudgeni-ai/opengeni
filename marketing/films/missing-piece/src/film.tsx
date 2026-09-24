import { CodeScene } from "./components/code";
import { EndCard } from "./components/end-card";
import { ProductWindow } from "./components/product";
import { Supers } from "./components/supers";
import { ease, keys, progress } from "./lib/anim";
import { C, H, W } from "./theme";
import { FPS, T } from "./timeline";

/** Camera over the product world: centre (x, y) and zoom s. */
type Shot = { t: number; x: number; y: number; s: number; e?: (p: number) => number };

/** One continuous take. Each entry is a held framing; moves ease between them. */
const SHOTS: Shot[] = [
  { t: 0, x: 1532, y: 900, s: 2.2 }, // macro: the request being typed
  { t: 1.72, x: 1532, y: 900, s: 2.2 },
  { t: 2.75, x: 1540, y: 640, s: 1.45 }, // the assistant's reply
  { t: 5.0, x: 1540, y: 636, s: 1.49, e: ease.inOutSine },
  { t: 5.75, x: 1262, y: 596, s: 1.12 }, // …and the buttons it names, right there
  { t: 6.1, x: 1262, y: 596, s: 1.12 },
  { t: 6.95, x: 960, y: 540, s: 1.0 }, // truth
  { t: 12.55, x: 960, y: 540, s: 1.0 },
  { t: 13.3, x: 986, y: 556, s: 1.14 }, // inside the product
  { t: 13.72, x: 986, y: 556, s: 1.14 },
  { t: 14.35, x: 1420, y: 552, s: 1.3 }, // the question
  { t: 15.25, x: 1420, y: 552, s: 1.3 },
  { t: 15.95, x: 986, y: 556, s: 1.14 },
  { t: 19.0, x: 986, y: 556, s: 1.14 },
  { t: 19.85, x: 960, y: 540, s: 1.0 },
];

function camera(t: number) {
  const channel = (value: (shot: Shot) => number) =>
    keys(t, SHOTS.map((shot) => ({ t: shot.t, v: value(shot), e: shot.e ?? ease.camera })));
  // Zoom is interpolated in log space so push-ins feel constant-rate.
  return { x: channel((s) => s.x), y: channel((s) => s.y), s: Math.exp(channel((s) => Math.log(s.s))) };
}

export function Film({ frame }: { frame: number }) {
  const t = frame / FPS;
  const cam = camera(t);
  const scan = ease.inOutCubic(progress(t, T.scan[0], T.scan[1]));
  const scanY = scan * H;
  const pageShift = ease.inOutQuint(progress(t, T.pageScroll[0], T.pageScroll[1])) * H;
  const productVisible = t < T.scan[1];
  const pageVisible = t >= T.scan[0];

  return (
    <div
      style={{
        position: "relative",
        width: W,
        height: H,
        overflow: "hidden",
        background: C.paper,
      }}
    >
      {productVisible ? (
        <div style={{ position: "absolute", inset: 0, clipPath: `inset(${scanY}px 0 0 0)` }}>
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
          </div>
        </div>
      ) : null}

      {pageVisible ? (
        <div style={{ position: "absolute", inset: 0, clipPath: t < T.scan[1] ? `inset(0 0 ${H - scanY}px 0)` : undefined }}>
          <div style={{ position: "absolute", left: 0, top: -pageShift, width: W, height: H * 2 }}>
            <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H }}>
              <CodeScene t={t} />
            </div>
            <div style={{ position: "absolute", left: 0, top: H, width: W, height: H }}>
              <EndCard t={t} />
            </div>
          </div>
        </div>
      ) : null}

      {scan > 0 && scan < 1 ? (
        <div style={{ position: "absolute", left: 0, top: scanY - 2, width: W, height: 4, background: C.orange }} />
      ) : null}
    </div>
  );
}
