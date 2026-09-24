import React from "react";
import { C } from "../theme";
import { F } from "../fonts";
import { CLIENTS, Client, cardRect, slotRect } from "../data";
import { clamp01, cubic, ease, lerp, prog, springAt } from "../anim";
import { T, flightEnd, flightStart, sentAt } from "../timeline";
import { Check } from "./Icons";

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const ampm = (c: Client) => (["9:00", "10:00"].includes(c.time) ? "AM" : "PM");

const CardFace: React.FC<{ c: Client; chip: number; w: number }> = ({ c, chip, w }) => (
  <div style={{ position: "absolute", inset: 0 }}>
    <div style={{ position: "absolute", left: 22, top: 17, width: 70 }}>
      <div style={{ fontFamily: F.ui, fontSize: 22, fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" }}>
        {c.time}
      </div>
      <div style={{ fontFamily: F.ui, fontSize: 13, fontWeight: 600, color: C.text3, marginTop: 3, letterSpacing: "0.06em" }}>{ampm(c)}</div>
    </div>
    <div style={{ position: "absolute", left: 104, top: 16 }}>
      <div style={{ fontFamily: F.ui, fontSize: 21, fontWeight: 650, color: C.text, whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>{c.name}</div>
      <div style={{ fontFamily: F.ui, fontSize: 16, color: C.text2, marginTop: 5, whiteSpace: "nowrap" }}>
        {c.service} · {c.duration}
      </div>
    </div>
    {chip > 0.001 && (
      <div
        style={{
          position: "absolute",
          right: 74,
          top: 23,
          height: 38,
          padding: "0 14px",
          borderRadius: 19,
          background: C.accentDim,
          border: `1px solid rgba(134,214,176,0.3)`,
          display: "flex",
          alignItems: "center",
          fontFamily: F.ui,
          fontSize: 17.5,
          fontWeight: 600,
          color: C.accent,
          whiteSpace: "nowrap",
          opacity: clamp01(chip * 1.4),
          transform: `translateX(${(1 - chip) * 14}px) scale(${0.92 + 0.08 * chip})`,
          transformOrigin: "right center",
        }}
      >
        {c.usual}
      </div>
    )}
    <div
      style={{
        position: "absolute",
        left: w - 60,
        top: 22,
        width: 40,
        height: 40,
        borderRadius: "50%",
        background: hexA(c.color, 0.22),
        color: c.color,
        display: "grid",
        placeItems: "center",
        fontFamily: F.ui,
        fontSize: 15,
        fontWeight: 700,
      }}
    >
      {c.initials}
    </div>
  </div>
);

const BlockFace: React.FC<{ c: Client; h: number }> = ({ c, h }) => (
  <div style={{ position: "absolute", left: 13, top: h < 48 ? 9 : 9, right: 8 }}>
    <div style={{ fontFamily: F.ui, fontSize: 15, fontWeight: 650, color: C.text, whiteSpace: "nowrap", letterSpacing: "-0.005em" }}>
      {c.name}
      {h < 48 && <span style={{ color: C.text2, fontWeight: 500 }}> · {c.to.label.split(" ")[1]}</span>}
    </div>
    {h >= 48 && (
      <div style={{ fontFamily: F.ui, fontSize: 13, color: C.text2, marginTop: 3, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
        {c.to.label.split(" ")[1]} · {c.service}
      </div>
    )}
  </div>
);

export const Clients: React.FC<{ t: number }> = ({ t }) => {
  return (
    <>
      {CLIENTS.map((c, i) => {
        const a = cardRect(i);
        const b = slotRect(c.to.day, c.to.start, c.to.hours);
        const f0 = flightStart(i);
        const f1 = flightEnd(i);
        const raw = clamp01((t - f0) / (f1 - f0));
        const k = ease.inOut(raw);
        const flying = t >= f0 && t < f1;
        const landed = t >= f1;
        const chipAt = T.check + i * T.checkGap;
        const chip = t < chipAt ? 0 : springAt(t, chipAt, 190, 20);
        const chipOut = 1 - prog(t, f0 + 0.02, f0 + 0.2);
        const readPulse = t >= chipAt - 0.05 && t < chipAt + 0.6 ? Math.sin(Math.PI * clamp01((t - chipAt + 0.05) / 0.65)) : 0;

        // Slide out horizontally, travel an S-curve, slide into the slot
        // horizontally — the way a calendar moves an event, not a throw.
        const ax = a.x + a.w / 2;
        const ay = a.y + a.h / 2;
        const bx = b.x + b.w / 2;
        const by = b.y + b.h / 2;
        const dx = bx - ax;
        const px = cubic(ax, ax + dx * 0.46, bx - dx * 0.4, bx, k);
        const py = cubic(ay, ay, by, by, k);
        const sizeK = ease.inOut(clamp01((raw - 0.06) / 0.56));
        const w = lerp(a.w, b.w, sizeK);
        const h = lerp(a.h, b.h, sizeK);
        const lift = Math.sin(Math.PI * raw);
        const settle = landed ? springAt(t, f1, 340, 20) : 1;
        const landScale = landed ? 1 + (1 - settle) * 0.05 : 1 + lift * 0.035;
        const cardFace = 1 - prog(raw, 0.06, 0.3, (x) => x);
        const flightFace = prog(raw, 0.22, 0.36, (x) => x) * (1 - prog(raw, 0.76, 0.88, (x) => x));
        const blockFace = prog(raw, 0.84, 1.0, (x) => x);
        const tint = flying ? prog(raw, 0.05, 0.35) : landed ? 1 : 0;

        let x = a.x;
        let y = a.y;
        let bw = a.w;
        let bh = a.h;
        if (flying) {
          x = px - w / 2;
          y = py - h / 2;
          bw = w;
          bh = h;
        } else if (landed) {
          x = b.x;
          y = b.y;
          bw = b.w;
          bh = b.h;
        }
        const isCard = !landed && !flying;
        const sent = springAt(t, sentAt(i), 260, 15);
        const glow = landed ? Math.max(0, 1 - (t - f1) / 0.7) : 0;

        return (
          <div
            key={c.id}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: bw,
              height: bh,
              zIndex: flying ? 30 : 10,
              transform: `scale(${landScale})`,
              transformOrigin: "center",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: isCard ? 10 : lerp(10, 6, sizeK),
                background: isCard ? C.raised : `linear-gradient(0deg, ${hexA(c.color, 0.17 * tint)}, ${hexA(c.color, 0.17 * tint)}), ${C.raised}`,
                border: `1px solid ${isCard ? (readPulse > 0 ? hexA("#86d6b0", 0.25 + 0.5 * readPulse) : C.line2) : hexA(c.color, 0.34 * tint)}`,
                boxShadow: flying
                  ? `0 ${18 + lift * 18}px ${30 + lift * 30}px rgba(0,0,0,${0.35 + lift * 0.2})`
                  : glow > 0
                    ? `0 0 0 ${2 + glow * 4}px ${hexA(c.color, glow * 0.35)}`
                    : readPulse > 0
                      ? `0 0 0 ${3 * readPulse}px rgba(134,214,176,${0.12 * readPulse})`
                      : "none",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: isCard ? 4 : 3,
                  background: c.color,
                }}
              />
              {(isCard || cardFace > 0) && (
                <div style={{ position: "absolute", inset: 0, opacity: isCard ? 1 : cardFace }}>
                  <CardFace c={c} chip={chip * chipOut} w={a.w} />
                </div>
              )}
              {flying && flightFace > 0 && (
                <div
                  style={{
                    position: "absolute",
                    left: 14,
                    top: "50%",
                    transform: "translateY(-50%)",
                    opacity: flightFace,
                    fontFamily: F.ui,
                    fontSize: 16,
                    fontWeight: 650,
                    color: C.text,
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.name}
                </div>
              )}
              {(landed || blockFace > 0) && (
                <div style={{ position: "absolute", inset: 0, opacity: landed ? 1 : blockFace }}>
                  <BlockFace c={c} h={b.h} />
                </div>
              )}
            </div>
            {landed && t >= sentAt(i) && (
              <div
                style={{
                  position: "absolute",
                  right: -7,
                  top: -8,
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  background: C.accent,
                  color: "#08241a",
                  display: "grid",
                  placeItems: "center",
                  transform: `scale(${sent})`,
                  boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
                }}
              >
                <Check size={14} stroke={3} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
};
