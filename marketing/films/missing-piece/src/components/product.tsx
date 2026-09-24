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
  const k = out * (1 - back);
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

const SLOT = { x: 1026, y: 102, w: 668, h: 812 } as const;

/** The empty space in the product where the agent belongs. */
function Slot({ t }: { t: number }) {
  if (t < T.slotDraw[0] || t > T.dock + 0.3) return null;
  const draw = ease.inOutCubic(progress(t, T.slotDraw[0], T.slotDraw[1]));
  const perimeter = 2 * (SLOT.w + SLOT.h);
  const fill = ease.outCubic(progress(t, T.slotDraw[0] + 0.3, T.slotDraw[1] + 0.2));
  const gone = ease.outCubic(progress(t, T.dock - 0.1, T.dock + 0.05));
  const path = `M ${SLOT.x} ${SLOT.y} H ${SLOT.x + SLOT.w} V ${SLOT.y + SLOT.h} H ${SLOT.x} Z`;
  const cx = SLOT.x + SLOT.w / 2;
  return (
    <>
      <Abs x={SLOT.x} y={SLOT.y} w={SLOT.w} h={SLOT.h} style={{ background: C.orangeWash, opacity: fill * 0.38 * (1 - gone) }} />
      <svg width={1720} height={940} style={{ position: "absolute", left: 0, top: 0, opacity: 1 - gone, overflow: "visible" }}>
        <defs>
          <mask id="slot-draw">
            <path d={path} fill="none" stroke="#fff" strokeWidth={10} strokeDasharray={`${perimeter * draw} ${perimeter}`} />
          </mask>
        </defs>
        <path d={path} fill="none" stroke={C.orange} strokeWidth={3} strokeDasharray="16 11" mask="url(#slot-draw)" />
      </svg>
      <div style={{ position: "absolute", left: cx, top: 370, transform: "translateX(-50%)", opacity: 1 - gone }}>
        <Rise t={t} at={T.slotText - 0.15} dur={0.5}>
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
const WAIT = { x: 1182, y: 712, w: 356, h: 86 } as const;

/** The customer's request, left behind when the widget pops, then carried into the panel. */
function Orphan({ t }: { t: number }) {
  if (t < T.pop + 0.08 || t >= T.messageLand) return null;
  const born = ease.emphasized(progress(t, T.pop + 0.08, T.pop + 0.55));
  const flyStart = T.dock - 0.06;
  const fly = ease.inOutCubic(progress(t, flyStart, T.messageLand));
  const bob = Math.sin((t - T.pop) * 3.4) * 4 * (1 - fly);

  const startX = 1310;
  const startY = 610;
  const wx = lerp(startX, WAIT.x, born);
  const wy = lerp(startY, WAIT.y, born) + bob;
  const x = lerp(wx, PANEL_MESSAGE.x, fly);
  const y = lerp(wy, PANEL_MESSAGE.y, fly);
  const w = lerp(WAIT.w, PANEL_MESSAGE.w, fly);
  const h = lerp(WAIT.h, PANEL_MESSAGE.h, fly);
  const radius = lerp(22, 0, ease.outCubic(progress(t, flyStart + 0.1, T.messageLand)));
  const blend = ease.inOutCubic(progress(t, flyStart + 0.12, T.messageLand - 0.08));
  const scale = lerp(0.82, 1, born);
  const shadow = 1 - fly;

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: radius,
        borderBottomRightRadius: radius * (1 - blend) * 0.27 + radius * blend,
        overflow: "hidden",
        transform: `scale(${scale})`,
        transformOrigin: "50% 50%",
        boxShadow: `0 ${18 * shadow}px ${44 * shadow}px rgba(58, 28, 108, ${0.26 * shadow})`,
        opacity: clamp(born * 2),
        zIndex: 5,
      }}
    >
      <div style={{ position: "absolute", inset: 0, background: widgetGradient, opacity: 1 - blend }} />
      <div style={{ position: "absolute", inset: 0, background: C.ink, opacity: blend }} />
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
          opacity: 1 - clamp(blend * 1.6),
        }}
      >
        {MESSAGE}
      </div>
      <div style={{ position: "absolute", left: 0, top: 0, width: PANEL_MESSAGE.w, opacity: clamp(blend * 1.6 - 0.6) }}>
        <MessageBlock style={{ background: "transparent" }} />
      </div>
    </div>
  );
}
