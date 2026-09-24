import React from "react";
import { clamp01, ease, lerp, prog } from "../anim";
import { CLICKS, T } from "../timeline";
import { cardRect, G } from "../data";
import { CANCEL_BTN, DATE_FIELD, TIME_FIELD } from "./EditDialog";
import { APPROVE_BTN } from "./AgentPanel";

type P = { t: number; x: number; y: number; e?: (x: number) => number };

const ben = cardRect(0);
const cx = (r: { x: number; w: number }) => r.x + r.w / 2;
const cy = (r: { y: number; h: number }) => r.y + r.h / 2;
/** Where the pointer lies down: on the calendar just right of the Tomorrow
 * list — inside the list shot while it flops, and inside the approval
 * close-up when it wakes. */
const REST = { x: 700, y: 640 };
const REST2 = { x: 690, y: 770 };
const TUCK = { x: G.askX + G.askW + 22, y: G.askY + 50 };

/** Pointer path in app pixels. Segments decelerate like a hand on a trackpad. */
const PATH: P[] = [
  { t: 0, x: 520, y: 430 },
  { t: T.benClick - 0.06, x: ben.x + 300, y: cy(ben) + 2 },
  { t: T.benClick + 0.08, x: ben.x + 300, y: cy(ben) + 2 },
  { t: T.dialogOpen + 0.42, x: cx(DATE_FIELD) + 18, y: cy(DATE_FIELD) + 8 },
  { t: T.dialogOpen + 0.62, x: cx(DATE_FIELD) + 26, y: cy(DATE_FIELD) + 12 },
  { t: T.dialogOpen + 0.82, x: cx(TIME_FIELD) - 30, y: cy(TIME_FIELD) + 6 },
  { t: T.dialogOpen + 0.96, x: cx(TIME_FIELD) - 40, y: cy(TIME_FIELD) + 14 },
  { t: T.cancelClick - 0.07, x: cx(CANCEL_BTN) + 6, y: cy(CANCEL_BTN) + 4 },
  { t: T.cancelClick + 0.1, x: cx(CANCEL_BTN) + 6, y: cy(CANCEL_BTN) + 4 },
  { t: T.askClick - 0.06, x: G.askX + 360, y: G.askY + 36 },
  { t: T.askClick + 0.12, x: G.askX + 360, y: G.askY + 36 },
  { t: T.askClick + 0.5, x: TUCK.x, y: TUCK.y },
  { t: T.lieStart - 0.05, x: TUCK.x, y: TUCK.y },
  { t: T.lieEnd - 0.15, x: REST.x, y: REST.y },
  { t: T.sitUp + 0.05, x: REST.x, y: REST.y },
  { t: T.approve - 0.08, x: cx(APPROVE_BTN) + 8, y: cy(APPROVE_BTN) + 4 },
  { t: T.approve + 0.2, x: cx(APPROVE_BTN) + 8, y: cy(APPROVE_BTN) + 4 },
  { t: T.lieAgain - 0.1, x: REST2.x - 6, y: REST2.y - 6 },
  { t: T.lieAgain + 0.5, x: REST2.x, y: REST2.y },
];

function pointerAt(t: number) {
  if (t <= PATH[0].t) return PATH[0];
  for (let i = 0; i < PATH.length - 1; i++) {
    const a = PATH[i];
    const b = PATH[i + 1];
    if (t <= b.t) {
      const x = (b.e ?? ease.pointer)(clamp01((t - a.t) / (b.t - a.t)));
      return { x: lerp(a.x, b.x, x), y: lerp(a.y, b.y, x) };
    }
  }
  return PATH[PATH.length - 1];
}

type Pose = { rot: number; dy: number; sx: number; sy: number };
const UPRIGHT: Pose = { rot: 0, dy: 0, sx: 1, sy: 1 };

/** Flop onto its side: anticipation lift, accelerating fall, squash on
 * impact, settle, then slow breathing while it rests. */
function flop(t: number, at: number): Pose {
  const d = t - at;
  if (d < -0.16) return UPRIGHT;
  if (d < 0) {
    const k = ease.out((d + 0.16) / 0.16);
    return { rot: 10 * k, dy: -6 * k, sx: 1, sy: 1 };
  }
  if (d < 0.22) {
    const k = ease.in(d / 0.22);
    return { rot: lerp(10, -96, k), dy: lerp(-6, 7, k), sx: 1, sy: 1 };
  }
  if (d < 0.32) {
    const k = Math.sin(((d - 0.22) / 0.1) * Math.PI);
    return { rot: lerp(-96, -89, (d - 0.22) / 0.1), dy: 7, sx: 1 + 0.07 * k, sy: 1 - 0.1 * k };
  }
  const k = ease.out(clamp01((d - 0.32) / 0.3));
  const breath = d > 0.7 ? 0.022 * Math.sin(((d - 0.7) / 1.6) * Math.PI * 2) : 0;
  return { rot: lerp(-89, -92, k), dy: 7, sx: 1 + breath, sy: 1 + breath };
}

/** Wake: a twitch, then snap upright with a small hop and overshoot. */
function wake(t: number, at: number, from: Pose): Pose {
  const d = t - at;
  if (d < 0) return from;
  if (d < 0.08) return { ...from, rot: from.rot - 5 * Math.sin((d / 0.08) * Math.PI) };
  if (d < 0.26) {
    const k = ease.out((d - 0.08) / 0.18);
    return { rot: lerp(from.rot, 9, k), dy: lerp(from.dy, -9, k), sx: 1, sy: 1 };
  }
  const k = ease.inOut(clamp01((d - 0.26) / 0.16));
  return { rot: lerp(9, 0, k), dy: lerp(-9, 0, k), sx: 1, sy: 1 };
}

const FLOP1 = T.lieStart + 0.55;
const FLOP2 = T.lieAgain + 0.25;

function pose(t: number): Pose {
  if (t < T.sitUp) return flop(t, FLOP1);
  if (t < FLOP2 - 0.2) return wake(t, T.sitUp, flop(T.sitUp, FLOP1));
  return flop(t, FLOP2);
}

/** macOS hides the pointer while you type; it reappears when you move it. */
function visibility(t: number) {
  if (t < T.typeStart) return 1;
  if (t < T.lieStart - 0.12) return 1 - prog(t, T.typeStart, T.typeStart + 0.12);
  return prog(t, T.lieStart - 0.12, T.lieStart);
}

export const Cursor: React.FC<{ t: number }> = ({ t }) => {
  const p = pointerAt(t);
  let press = 0;
  let ring = 0;
  let ringAge = 99;
  for (const c of CLICKS) {
    const d = t - c;
    if (d >= -0.04 && d < 0.16) press = Math.max(press, Math.sin(clamp01((d + 0.04) / 0.2) * Math.PI));
    if (d >= 0 && d < ringAge) ringAge = d;
  }
  if (ringAge < 0.55) ring = ringAge / 0.55;
  const ps = pose(t);
  const scale = 1 - press * 0.14;
  const approveGlow = t > T.approve - 0.02 && t < T.approve + 0.6;
  const vis = visibility(t);
  if (vis <= 0.001) return null;

  return (
    <div style={{ position: "absolute", left: p.x, top: p.y, width: 0, height: 0, zIndex: 50, opacity: vis }}>
      {ringAge < 0.55 && (
        <div
          style={{
            position: "absolute",
            left: -34 * (0.35 + ring),
            top: -34 * (0.35 + ring),
            width: 68 * (0.35 + ring),
            height: 68 * (0.35 + ring),
            borderRadius: "50%",
            border: `2px solid rgba(255,255,255,${0.55 * (1 - ring)})`,
            boxShadow: approveGlow ? `0 0 24px rgba(143,227,187,${0.5 * (1 - ring)})` : undefined,
          }}
        />
      )}
      <svg
        width={34}
        height={48}
        viewBox="0 0 20 28"
        style={{
          position: "absolute",
          left: -2,
          top: -2 + ps.dy,
          transform: `rotate(${ps.rot}deg) scale(${scale * ps.sx}, ${scale * ps.sy})`,
          transformOrigin: "10px 15px",
          filter: "drop-shadow(0 3px 5px rgba(0,0,0,0.45))",
          overflow: "visible",
        }}
      >
        <path
          d="M1.2 1.2 L1.2 21.6 L6.1 17.1 L9.3 24.9 L12.6 23.5 L9.5 15.9 L16.1 15.9 Z"
          fill="#ffffff"
          stroke="#0a0a0a"
          strokeWidth={1.3}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};
