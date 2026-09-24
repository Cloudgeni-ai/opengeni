import { clamp, ease, lerp, progress } from "../lib/anim";
import { C, F } from "../theme";
import { MESSAGE, T } from "../timeline";
import { AgentPanel, MessageBlock, PANEL_MESSAGE } from "./agent-panel";
import { Itinerary } from "./itinerary";
import { Abs, Eyebrow, Rise } from "./primitives";
import { Widget, widgetGradient } from "./widget";

/** The product window in world coordinates. */
export const WINDOW = { x: 100, y: 70, w: 1720, h: 940 } as const;

/** Scale factor of the product during the "truth" supers, and back. */
export function productGroupTransform(t: number) {
  const out = ease.inOutQuint(progress(t, T.shrink[0], T.shrink[1]));
  const back = ease.inOutQuint(progress(t, T.unshrink[0], T.unshrink[1]));
  const final = ease.inOutQuint(progress(t, T.endShrink[0], T.endShrink[1]));
  const k = Math.max(out * (1 - back), final);
  const s = lerp(1, 0.575, k);
  // Anchor: window's right edge at x=1846, vertical centre at y=548.
  const rightEdge = WINDOW.x + WINDOW.w;
  const centreY = WINDOW.y + WINDOW.h / 2;
  const tx = lerp(0, 1846 - s * rightEdge, k);
  const ty = lerp(0, 548 - s * centreY, k);
  return { s, tx, ty, k };
}

export function ProductWindow({ t }: { t: number }) {
  const g = productGroupTransform(t);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
        transform: `translate(${g.tx}px, ${g.ty}px) scale(${g.s})`,
        transformOrigin: "0 0",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: WINDOW.x + 18,
          top: WINDOW.y + 18,
          width: WINDOW.w,
          height: WINDOW.h,
          background: C.paperShadow,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: WINDOW.x,
          top: WINDOW.y,
          width: WINDOW.w,
          height: WINDOW.h,
          background: C.surface,
          border: `2px solid ${C.ink}`,
        }}
      >
        <TitleBar />
        <Itinerary t={t} />
        <Slot t={t} />
        <AgentPanel t={t} />
        <Widget t={t} />
        <Orphan t={t} />
      </div>
    </div>
  );
}

function TitleBar() {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        right: 0,
        height: 76,
        borderBottom: `1.5px solid ${C.line}`,
        display: "flex",
        alignItems: "center",
        padding: "0 28px",
        gap: 11,
      }}
    >
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 14, height: 14, borderRadius: "50%", background: C.line }} />
      ))}
      <span style={{ marginLeft: 22, fontFamily: F.mono, fontSize: 23, color: C.muted2, letterSpacing: "0.01em" }}>
        app.acme.com/trips/lisbon
      </span>
      <span style={{ flex: 1 }} />
      <span
        style={{
          fontFamily: F.mono,
          fontSize: 21,
          color: C.ink,
          border: `1.5px solid ${C.ink}`,
          padding: "6px 14px",
          letterSpacing: "0.01em",
        }}
      >
        Your product
      </span>
    </div>
  );
}

/** The panel's footprint: the hole in the product where the agent belongs. */
const SOCKET = { x: 1000, y: 76, w: 720, h: 864 } as const;

/** The missing piece: a hole cut through the product, showing the paper behind it. */
function Slot({ t }: { t: number }) {
  if (t < T.slotDraw[0] || t > T.dock + 0.05) return null;
  const sink = ease.emphasized(progress(t, T.slotDraw[0], T.slotDraw[1]));
  const cx = SOCKET.x + SOCKET.w / 2;
  const depth = 14 * sink;
  return (
    <>
      <Abs
        x={SOCKET.x}
        y={SOCKET.y}
        w={SOCKET.w}
        h={SOCKET.h}
        style={{
          background: `color-mix(in srgb, ${C.paper} ${sink * 100}%, ${C.surface})`,
          boxShadow: `inset ${depth}px ${depth}px 0 ${C.paperShadow}, inset 2px 0 0 ${C.ink}`,
        }}
      />
      <div style={{ position: "absolute", left: cx + depth / 2, top: 330, transform: "translateX(-50%)" }}>
        <Rise t={t} at={T.slotText - 0.12} dur={0.5}>
          <Eyebrow size={23} style={{ justifyContent: "center" }}>
            The missing piece
          </Eyebrow>
        </Rise>
        <div style={{ height: 22 }} />
        <Rise t={t} at={T.slotText} dur={0.62}>
          <SlotLine>An agent inside</SlotLine>
        </Rise>
        <Rise t={t} at={T.slotText + 0.12} dur={0.62}>
          <SlotLine>your product.</SlotLine>
        </Rise>
      </div>
    </>
  );
}

function SlotLine({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: F.display,
        fontSize: 60,
        fontWeight: 550,
        letterSpacing: "-0.03em",
        lineHeight: "66px",
        color: C.ink,
        textAlign: "center",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}

/** Widget-styled bubble geometry while it waits, in window-local coordinates. */
const WAIT = { x: 1190, y: 640, w: 356, h: 86 } as const;

/** The customer's request, left behind when the widget pops, then carried into the panel. */
function Orphan({ t }: { t: number }) {
  if (t < T.pop + 0.06 || t >= T.messageLand) return null;
  const born = ease.emphasized(progress(t, T.pop + 0.06, T.pop + 0.7));
  const flyStart = T.dock - 0.08;
  const fly = ease.inOutCubic(progress(t, flyStart, T.messageLand));
  const bob = Math.sin((t - T.pop) * 3.1) * 5 * (1 - fly) * born;

  const wx = lerp(1300, WAIT.x, born);
  const wy = lerp(560, WAIT.y, born) + bob;
  const arc = -70 * Math.sin(Math.PI * fly);
  const x = lerp(wx, PANEL_MESSAGE.x, fly);
  const y = lerp(wy, PANEL_MESSAGE.y, fly) + arc;
  const w = lerp(WAIT.w, PANEL_MESSAGE.w, ease.inOutCubic(progress(fly, 0.15, 0.85)));
  const h = lerp(WAIT.h, PANEL_MESSAGE.h, ease.inOutCubic(progress(fly, 0.15, 0.85)));
  const shape = ease.inOutCubic(progress(fly, 0.25, 0.9));
  const radius = lerp(22, 0, shape);
  const colour = ease.inOutCubic(progress(fly, 0.15, 0.75));
  const textSwap = ease.inOutCubic(progress(fly, 0.38, 0.62));
  const lift = 1 - shape;

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: radius,
        borderBottomRightRadius: lerp(6, 0, shape),
        overflow: "hidden",
        transform: `scale(${lerp(0.86, 1, born)})`,
        transformOrigin: "50% 50%",
        boxShadow: `0 ${16 * lift}px ${40 * lift}px rgba(58, 28, 108, ${0.22 * lift})`,
        opacity: clamp(born * 2.2),
        zIndex: 5,
      }}
    >
      <div style={{ position: "absolute", inset: 0, background: widgetGradient, opacity: 1 - colour }} />
      <div style={{ position: "absolute", inset: 0, background: C.ink, opacity: colour }} />
      <div
        style={{
          position: "absolute",
          left: 18,
          top: 14,
          width: WAIT.w - 36,
          fontFamily: F.widget,
          fontSize: 20,
          lineHeight: 1.4,
          color: C.white,
          opacity: 1 - textSwap,
        }}
      >
        {MESSAGE}
      </div>
      <div style={{ position: "absolute", left: 0, top: 0, width: PANEL_MESSAGE.w, opacity: textSwap }}>
        <MessageBlock style={{ background: "transparent" }} />
      </div>
    </div>
  );
}
