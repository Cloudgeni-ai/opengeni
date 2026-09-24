import { Check } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { bezier, clamp, ease, progress } from "../lib/anim";
import { C, F } from "../theme";
import { MESSAGE, T } from "../timeline";
import { Abs, LiveDot } from "./primitives";

export const PANEL = { x: 1000, y: 76, w: 720, h: 864 } as const;
/** Where the customer's message lands inside the panel (window-local). */
export const PANEL_MESSAGE = { x: 1152, y: 180, w: 520, h: 106 } as const;

export function MessageBlock({ style }: { style?: CSSProperties }) {
  return (
    <div
      style={{
        background: C.ink,
        color: C.white,
        fontFamily: F.body,
        fontSize: 26,
        lineHeight: "35px",
        padding: "18px 24px",
        letterSpacing: "-0.005em",
        ...style,
      }}
    >
      {MESSAGE}
    </div>
  );
}

export function AgentPanel({ t }: { t: number }) {
  // The piece appears lifted above its socket, then presses home exactly on the dock beat.
  if (t < T.dock - 0.62) return null;
  const appear = ease.inOutCubic(progress(t, T.dock - 0.64, T.dock - 0.34));
  const press = ease.inCubic(progress(t, T.dock - 0.22, T.dock));
  const hover = Math.sin((t - (T.dock - 0.62)) * 7) * 2 * (1 - press);
  const raise = (18 + hover) * (1 - press);
  const settle = t > T.dock ? Math.sin((t - T.dock) * 42) * Math.exp(-(t - T.dock) * 18) * 2 : 0;
  // The camera goes inside the panel to show its source; the conversation steps aside.
  const cleared = ease.inOutCubic(progress(t, T.clearPanel[0], T.clearPanel[1]));
  const restored = ease.inOutCubic(progress(t, T.zoomOut[1] - 0.12, T.zoomOut[1] + 0.16));
  const content = 1 - cleared + restored;
  const drift = (cleared - restored) * -14;

  return (
    <div
      style={{
        position: "absolute",
        left: PANEL.x,
        top: PANEL.y,
        width: PANEL.w,
        height: PANEL.h,
        transform: `translate(${-raise * 0.55}px, ${-raise * 0.55 + settle}px) scale(${1 + 0.012 * (1 - press)})`,
        transformOrigin: "50% 50%",
        clipPath: `inset(0 -40px calc(${(1 - appear) * 100}% - ${40 * appear}px) -40px)`,
        background: C.surface,
        borderLeft: `2px solid ${C.ink}`,
        boxShadow: `${raise}px ${raise}px 0 ${C.paperShadow}`,
      }}
    >
      <div
        style={{
          height: 80,
          borderBottom: `1.5px solid ${C.line}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 48px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <LiveDot size={12} />
          <span style={{ fontFamily: F.body, fontSize: 27, fontWeight: 650, color: C.ink, letterSpacing: "-0.01em" }}>Agent</span>
        </div>
        <span style={{ fontFamily: F.mono, fontSize: 18, letterSpacing: "0.12em", color: C.muted }}>OPENGENI</span>
      </div>

      <Abs
        x={PANEL_MESSAGE.x - PANEL.x}
        y={PANEL_MESSAGE.y - PANEL.y}
        w={PANEL_MESSAGE.w}
        h={PANEL_MESSAGE.h}
        style={{ visibility: t >= T.messageLand ? "visible" : "hidden", opacity: content }}
      >
        <MessageBlock style={{ height: PANEL_MESSAGE.h }} />
      </Abs>

      <div
        style={{
          position: "absolute",
          left: 48,
          right: 48,
          top: PANEL_MESSAGE.y - PANEL.y + PANEL_MESSAGE.h + 26,
          display: "flex",
          flexDirection: "column",
          opacity: content,
          transform: `translateY(${drift}px)`,
        }}
      >
        <Step t={t} at={T.step1} tool="get_flight">
          Checked TP 1353 · lands 17:10
        </Step>
        <Question t={t} />
        <Step t={t} at={T.step2} tool="move_car_pickup">
          Moved car pickup · 17:40
        </Step>
        <Step t={t} at={T.step3} tool="message_hotel">
          Told Casa Alfama · arriving 18:30
        </Step>
        <Step t={t} at={T.step4} tool="move_dinner">
          Moved dinner · 21:30
        </Step>
        <Appear t={t} at={T.allSet} style={{ marginTop: 26 }}>
          <div style={{ fontFamily: F.body, fontSize: 28, fontWeight: 550, color: C.ink, letterSpacing: "-0.012em", lineHeight: "38px" }}>
            All set. Your evening still works.
          </div>
        </Appear>
        <Appear t={t} at={T.pray} style={{ marginTop: 18, alignSelf: "flex-end" }} lift={14}>
          <div style={{ background: C.ink, padding: "10px 18px 8px" }}>
            <img src="assets/emoji/pray.png" alt="" style={{ width: 38, height: 36, display: "block" }} />
          </div>
        </Appear>
      </div>

      <div
        style={{
          position: "absolute",
          left: 48,
          right: 48,
          bottom: 26,
          height: 64,
          border: `1.5px solid ${C.line}`,
          display: "flex",
          alignItems: "center",
          padding: "0 22px",
          fontFamily: F.body,
          fontSize: 23,
          color: C.faint,
        }}
      >
        Ask about your trip…
      </div>
    </div>
  );
}

function Appear({
  t,
  at,
  children,
  style,
  lift = 18,
}: {
  t: number;
  at: number;
  children: ReactNode;
  style?: CSSProperties;
  lift?: number;
}) {
  if (t < at) return null;
  const p = ease.emphasized(progress(t, at, at + 0.42));
  return (
    <div style={{ opacity: clamp(p * 1.8), transform: `translateY(${(1 - p) * lift}px)`, ...style }}>{children}</div>
  );
}

function Step({ t, at, tool, children }: { t: number; at: number; tool: string; children: ReactNode }) {
  if (t < at) return null;
  const done = t >= at + 0.5;
  const p = ease.emphasized(progress(t, at, at + 0.36));
  return (
    <div
      style={{
        height: 44,
        display: "flex",
        alignItems: "center",
        gap: 16,
        opacity: clamp(p * 1.8),
        transform: `translateX(${(1 - p) * 12}px)`,
        fontFamily: F.mono,
        fontVariantLigatures: "none",
        fontSize: 23,
        color: done ? C.ink2 : C.ink,
        fontWeight: done ? 400 : 500,
        whiteSpace: "nowrap",
      }}
    >
      <LiveDot size={11} color={done ? C.ink : C.orange} />
      <span style={{ flex: 1 }}>{children}</span>
      <span style={{ fontSize: 18, color: C.muted2, letterSpacing: "0.01em" }}>{tool}</span>
    </div>
  );
}

function Question({ t }: { t: number }) {
  if (t < T.question) return null;
  const p = ease.outCubic(progress(t, T.question, T.question + 0.5));
  const fade = ease.inOutSine(progress(t, T.question, T.question + 0.3));
  const tapped = t >= T.tap;
  const press = t >= T.tap - 0.02 && t < T.tap + 0.12 ? 0.96 : 1;
  const answered = ease.outCubic(progress(t, T.tap + 0.05, T.tap + 0.35));
  return (
    <div
      style={{
        margin: "14px 0 14px",
        background: C.ink,
        padding: "22px 24px 24px",
        opacity: fade,
        transform: `translateY(${(1 - p) * 22}px)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: F.mono, fontSize: 16, letterSpacing: "0.1em", color: "rgba(255,255,255,0.62)" }}>
        <LiveDot size={8} />
        NEEDS YOUR OK
      </div>
      <div style={{ marginTop: 12, fontFamily: F.body, fontSize: 27, fontWeight: 550, color: C.white, lineHeight: "36px", letterSpacing: "-0.01em" }}>
        The car change costs €12. Go ahead?
      </div>
      <div style={{ marginTop: 18, display: "flex", gap: 12 }}>
        <div
          style={{
            position: "relative",
            background: tapped ? C.orangeDeep : t >= T.tap - 0.2 ? "#ff6a40" : C.orange,
            color: C.white,
            fontFamily: F.body,
            fontSize: 22,
            fontWeight: 650,
            padding: "12px 22px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            transform: `scale(${press})`,
          }}
        >
          {answered > 0 ? (
            <span style={{ display: "inline-flex", width: 22 * answered, overflow: "hidden" }}>
              <Check size={22} strokeWidth={2.8} />
            </span>
          ) : null}
          Yes, change it
          <Cursor t={t} />
        </div>
        <div
          style={{
            border: "1.5px solid rgba(255,255,255,0.38)",
            color: "rgba(255,255,255,0.86)",
            fontFamily: F.body,
            fontSize: 22,
            fontWeight: 550,
            padding: "11px 20px",
            opacity: 1 - answered * 0.7,
          }}
        >
          Keep 14:40
        </div>
      </div>
    </div>
  );
}

const cursorPath = bezier(0.22, 0.75, 0.28, 1);

/** The customer's pointer, on a curved, decelerating path. Positioned relative to its button. */
function Cursor({ t }: { t: number }) {
  if (t < T.cursorIn || t > T.tap + 0.9) return null;
  const u = cursorPath(progress(t, T.cursorIn, T.tap - 0.14));
  const leave = ease.inOutCubic(progress(t, T.tap + 0.25, T.tap + 0.85));
  // quadratic Bézier from lower right, bowing below the card, into the button's centre
  const p0 = { x: 470, y: 330 };
  const p1 = { x: 150, y: 250 };
  const p2 = { x: 118, y: 24 };
  const bx = (1 - u) * (1 - u) * p0.x + 2 * (1 - u) * u * p1.x + u * u * p2.x;
  const by = (1 - u) * (1 - u) * p0.y + 2 * (1 - u) * u * p1.y + u * u * p2.y;
  const x = bx + leave * 36;
  const y = by + leave * 54;
  const click = t >= T.tap - 0.04 && t < T.tap + 0.08 ? 0.84 : 1;
  const opacity = clamp(progress(t, T.cursorIn, T.cursorIn + 0.15)) * (1 - leave);
  return (
    <svg
      width={34}
      height={46}
      viewBox="0 0 34 46"
      style={{ position: "absolute", left: x, top: y, opacity, transform: `scale(${click})`, transformOrigin: "4px 4px", pointerEvents: "none" }}
    >
      <path d="M4 3 L4 36 L12.5 28.5 L18.5 42 L24 39.5 L18 26.5 L29.5 26.5 Z" fill={C.ink} stroke={C.white} strokeWidth={2.4} strokeLinejoin="round" />
    </svg>
  );
}
