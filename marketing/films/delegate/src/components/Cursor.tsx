import React from "react";
import { clamp01, ease, lerp, springAt } from "../anim";
import { CLICKS, T } from "../timeline";
import { cardRect, G } from "../data";
import { CANCEL_BTN, DATE_FIELD, TIME_FIELD } from "./EditDialog";
import { APPROVE_BTN } from "./AgentPanel";

type P = { t: number; x: number; y: number; e?: (x: number) => number };

const ben = cardRect(0);
const cx = (r: { x: number; w: number }) => r.x + r.w / 2;
const cy = (r: { y: number; h: number }) => r.y + r.h / 2;
/** Where the pointer lies down: just right of the Tomorrow column, on screen
 * in both the wide shots and the approval close-up. */
const REST = { x: 716, y: 1058 };

/** Pointer path in app pixels. Segments decelerate like a hand on a trackpad. */
const PATH: P[] = [
  { t: 0, x: 520, y: 430 },
  { t: T.benClick - 0.06, x: ben.x + 300, y: cy(ben) + 2 },
  { t: T.benClick + 0.08, x: ben.x + 300, y: cy(ben) + 2 },
  { t: 1.28, x: cx(DATE_FIELD) + 18, y: cy(DATE_FIELD) + 8 },
  { t: 1.55, x: cx(DATE_FIELD) + 26, y: cy(DATE_FIELD) + 12 },
  { t: 1.8, x: cx(TIME_FIELD) - 30, y: cy(TIME_FIELD) + 6 },
  { t: 2.02, x: cx(TIME_FIELD) - 40, y: cy(TIME_FIELD) + 14 },
  { t: T.cancelClick - 0.07, x: cx(CANCEL_BTN) + 6, y: cy(CANCEL_BTN) + 4 },
  { t: T.cancelClick + 0.1, x: cx(CANCEL_BTN) + 6, y: cy(CANCEL_BTN) + 4 },
  { t: T.askClick - 0.06, x: G.askX + 360, y: G.askY + 36 },
  { t: T.askClick + 0.12, x: G.askX + 360, y: G.askY + 36 },
  { t: 3.95, x: G.askX + G.askW + 22, y: G.askY + 50 },
  { t: T.enter + 0.1, x: G.askX + G.askW + 26, y: G.askY + 52 },
  { t: T.lieEnd - 0.1, x: REST.x, y: REST.y },
  { t: T.sitUp + 0.05, x: REST.x, y: REST.y },
  { t: T.approve - 0.08, x: cx(APPROVE_BTN) + 8, y: cy(APPROVE_BTN) + 4 },
  { t: T.approve + 0.2, x: cx(APPROVE_BTN) + 8, y: cy(APPROVE_BTN) + 4 },
  { t: T.lieAgain - 0.1, x: REST.x - 20, y: REST.y - 4 },
  { t: T.lieAgain + 0.5, x: REST.x - 16, y: REST.y },
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

/** 0 = upright, 1 = lying on its side. */
function lying(t: number) {
  const down1 = springAt(t, T.lieStart + 0.55, 120, 14);
  const up = springAt(t, T.sitUp, 220, 17);
  const down2 = springAt(t, T.lieAgain + 0.25, 120, 14);
  if (t < T.sitUp) return down1;
  if (t < T.lieAgain + 0.25) return down1 * (1 - up);
  return down2;
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
  const lie = lying(t);
  const rot = -92 * lie;
  const drop = 7 * lie;
  const scale = 1 - press * 0.14;
  const approveGlow = t > T.approve - 0.02 && t < T.approve + 0.6;

  return (
    <div style={{ position: "absolute", left: p.x, top: p.y, width: 0, height: 0, zIndex: 50 }}>
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
        width={30}
        height={42}
        viewBox="0 0 20 28"
        style={{
          position: "absolute",
          left: -2,
          top: -2 + drop,
          transform: `rotate(${rot}deg) scale(${scale})`,
          transformOrigin: "9px 13px",
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
