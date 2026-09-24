import React from "react";
import { C } from "../theme";
import { F } from "../fonts";
import { clamp01, prog, springAt } from "../anim";
import { T } from "../timeline";
import { Chevron, Close } from "./Icons";

export const DIALOG = { x: 632, y: 192, w: 656, h: 708 };
const PAD = 30;
const COL = (DIALOG.w - PAD * 2 - 18) / 2;
export const FIELD_Y = DIALOG.y + 168;
export const DATE_FIELD = { x: DIALOG.x + PAD, y: FIELD_Y, w: COL, h: 52 };
export const TIME_FIELD = { x: DIALOG.x + PAD + COL + 18, y: FIELD_Y, w: COL, h: 52 };
export const CANCEL_BTN = { x: DIALOG.x + DIALOG.w - PAD - 184 - 12 - 116, y: DIALOG.y + DIALOG.h - PAD - 52, w: 116, h: 52 };

const Field: React.FC<{ label: string; value: string; x: number; y: number; w: number; hot?: number }> = ({ label, value, x, y, w, hot = 0 }) => (
  <>
    <div style={{ position: "absolute", left: x, top: y - 28, fontFamily: F.ui, fontSize: 15, fontWeight: 600, color: C.text2 }}>{label}</div>
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: 52,
        borderRadius: 11,
        border: `1px solid ${hot > 0 ? `rgba(255,255,255,${0.14 + hot * 0.2})` : C.line2}`,
        background: `rgba(255,255,255,${0.03 + hot * 0.03})`,
        boxSizing: "border-box",
        padding: "0 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontFamily: F.ui,
        fontSize: 18,
        color: C.text,
      }}
    >
      {value}
      <Chevron dir="down" size={16} color={C.text3} />
    </div>
  </>
);

export const EditDialog: React.FC<{ t: number }> = ({ t }) => {
  if (t < T.dialogOpen - 0.01 || t > T.cancelClick + 0.3) return null;
  const open = springAt(t, T.dialogOpen, 260, 21);
  const close = prog(t, T.cancelClick + 0.05, T.cancelClick + 0.22);
  const vis = clamp01(open * 1.6) * (1 - close);
  const scale = (0.94 + 0.06 * open) * (1 - 0.03 * close);
  const hotDate = prog(t, 1.2, 1.35) - prog(t, 1.6, 1.75);
  const hotTime = prog(t, 1.7, 1.85) - prog(t, 2.05, 2.2);
  const hotCancel = prog(t, 2.2, 2.3);
  const r1 = FIELD_Y + 96;
  const r2 = r1 + 96;
  return (
    <>
      <div style={{ position: "absolute", left: -600, top: -600, width: 3120, height: 2280, background: `rgba(4,5,7,${0.55 * vis})`, zIndex: 60 }} />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1920,
          height: 1080,
          zIndex: 61,
          opacity: vis,
          transform: `scale(${scale})`,
          transformOrigin: `${DIALOG.x + DIALOG.w / 2}px ${DIALOG.y + 120}px`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: DIALOG.x,
            top: DIALOG.y,
            width: DIALOG.w,
            height: DIALOG.h,
            borderRadius: 20,
            background: C.raised,
            border: `1px solid ${C.line2}`,
            boxShadow: "0 40px 100px rgba(0,0,0,0.6)",
          }}
        />
        <div style={{ position: "absolute", left: DIALOG.x + PAD, top: DIALOG.y + 28, fontFamily: F.ui, fontSize: 25, fontWeight: 700, color: C.text, letterSpacing: "-0.015em" }}>
          Edit booking
        </div>
        <div style={{ position: "absolute", left: DIALOG.x + DIALOG.w - PAD - 22, top: DIALOG.y + 32, color: C.text3 }}>
          <Close size={22} />
        </div>
        <div style={{ position: "absolute", left: DIALOG.x + PAD, top: DIALOG.y + 76, display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              background: "rgba(126,168,255,0.22)",
              color: "#7ea8ff",
              display: "grid",
              placeItems: "center",
              fontFamily: F.ui,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            BC
          </div>
          <div style={{ fontFamily: F.ui, fontSize: 18, fontWeight: 600, color: C.text }}>Ben Carter</div>
          <div style={{ fontFamily: F.ui, fontSize: 17, color: C.text2 }}>Cut · 45 min</div>
        </div>
        <Field label="Date" value="Tue, Oct 14" {...DATE_FIELD} hot={hotDate} />
        <Field label="Time" value="9:00 AM" {...TIME_FIELD} hot={hotTime} />
        <Field label="Stylist" value="Ines" x={DATE_FIELD.x} y={r1} w={COL} />
        <Field label="Duration" value="45 min" x={TIME_FIELD.x} y={r1} w={COL} />
        <Field label="Repeat" value="Does not repeat" x={DATE_FIELD.x} y={r2} w={DIALOG.w - PAD * 2} />
        <div
          style={{
            position: "absolute",
            left: DIALOG.x + PAD,
            top: r2 + 76,
            width: DIALOG.w - PAD * 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontFamily: F.ui, fontSize: 17, color: C.text }}>Notify client by text</div>
          <div style={{ width: 46, height: 26, borderRadius: 13, background: "#2c3038", position: "relative" }}>
            <div style={{ position: "absolute", left: 3, top: 3, width: 20, height: 20, borderRadius: "50%", background: "#8d8f93" }} />
          </div>
        </div>
        <div style={{ position: "absolute", left: DIALOG.x + PAD, top: r2 + 124, fontFamily: F.ui, fontSize: 15, fontWeight: 600, color: C.text2 }}>
          Message to Ben
        </div>
        <div
          style={{
            position: "absolute",
            left: DIALOG.x + PAD,
            top: r2 + 152,
            width: DIALOG.w - PAD * 2,
            height: 80,
            borderRadius: 11,
            border: `1px solid ${C.line2}`,
            background: "rgba(255,255,255,0.03)",
            boxSizing: "border-box",
            padding: "14px 16px",
            fontFamily: F.ui,
            fontSize: 17,
            color: C.text3,
          }}
        >
          Write a message…
        </div>
        <div style={{ position: "absolute", left: DIALOG.x + PAD, top: CANCEL_BTN.y + 14, fontFamily: F.ui, fontSize: 17, fontWeight: 600, color: "#e0877d" }}>
          Delete
        </div>
        <div
          style={{
            position: "absolute",
            left: CANCEL_BTN.x,
            top: CANCEL_BTN.y,
            width: CANCEL_BTN.w,
            height: CANCEL_BTN.h,
            borderRadius: 12,
            border: `1px solid ${hotCancel > 0 ? "rgba(255,255,255,0.3)" : C.line2}`,
            background: `rgba(255,255,255,${0.02 + 0.06 * hotCancel})`,
            display: "grid",
            placeItems: "center",
            fontFamily: F.ui,
            fontSize: 18,
            fontWeight: 600,
            color: C.text,
          }}
        >
          Cancel
        </div>
        <div
          style={{
            position: "absolute",
            left: CANCEL_BTN.x + CANCEL_BTN.w + 12,
            top: CANCEL_BTN.y,
            width: 184,
            height: CANCEL_BTN.h,
            borderRadius: 12,
            background: C.accent,
            display: "grid",
            placeItems: "center",
            fontFamily: F.ui,
            fontSize: 18,
            fontWeight: 700,
            color: "#08241a",
          }}
        >
          Save changes
        </div>
      </div>
    </>
  );
};
