import React from "react";
import { C } from "../theme";
import { F } from "../fonts";
import { DAYS, EXISTING, G, slotRect } from "../data";
import { prog, springAt } from "../anim";
import { T, flightStart } from "../timeline";
import { Bell, Chevron, Moon, Search } from "./Icons";
import { HourGlyph, Wordmark } from "./HourMark";

const BLEED = 600;

export const TopBar: React.FC<{ hideWordmark?: boolean; detailsOpacity?: number }> = ({ hideWordmark, detailsOpacity = 1 }) => (
  <>
    <div
      style={{
        position: "absolute",
        left: -BLEED,
        top: -BLEED,
        width: 1920 + BLEED * 2,
        height: G.top + BLEED,
        background: C.panel,
      }}
    />
    <div style={{ position: "absolute", left: -BLEED, top: G.top - 1, width: 1920 + BLEED * 2, height: 1, background: C.line, opacity: detailsOpacity }} />
    <div style={{ position: "absolute", left: 32, top: 25, opacity: detailsOpacity }}>
      <HourGlyph size={26} />
    </div>
    <div style={{ position: "absolute", left: 68, top: 22, opacity: hideWordmark ? 0 : 1 }}>
      <Wordmark />
    </div>
    <div style={{ position: "absolute", left: 176, top: 26, width: 1, height: 24, background: C.line2, opacity: detailsOpacity }} />
    <div style={{ position: "absolute", left: 196, top: 27, fontFamily: F.ui, fontSize: 16, color: C.text2, fontWeight: 500, opacity: detailsOpacity }}>
      Ines Moreau · Hair
    </div>

    <div style={{ position: "absolute", left: G.gridX + 28, top: 20, display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ display: "flex", gap: 6 }}>
        {(["left", "right"] as const).map((d) => (
          <div
            key={d}
            style={{
              width: 34,
              height: 34,
              borderRadius: 7,
              border: `1px solid ${C.line2}`,
              display: "grid",
              placeItems: "center",
              color: C.text2,
            }}
          >
            <Chevron dir={d} size={16} />
          </div>
        ))}
      </div>
      <div style={{ fontFamily: F.ui, fontSize: 22, fontWeight: 650, color: C.text, letterSpacing: "-0.01em" }}>Next week</div>
      <div style={{ fontFamily: F.ui, fontSize: 18, color: C.text2 }}>Oct 20 – 25</div>
    </div>

    <div style={{ position: "absolute", right: 28, top: 20, display: "flex", alignItems: "center", gap: 22, color: C.text2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: F.ui, fontSize: 16, fontVariantNumeric: "tabular-nums" }}>
        <Moon size={16} />
        11:48 PM
      </div>
      <Search size={19} />
      <Bell size={19} />
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "#2a2f37",
          display: "grid",
          placeItems: "center",
          fontFamily: F.ui,
          fontSize: 14,
          fontWeight: 650,
          color: C.text,
        }}
      >
        IM
      </div>
    </div>
  </>
);

export const LeftColumn: React.FC<{ t: number }> = ({ t }) => {
  let remaining = 7;
  for (let i = 0; i < 7; i++) if (t >= flightStart(i) + 0.12) remaining--;
  const emptyAt = flightStart(6) + 0.45;
  // Hidden while the approval sheet is up; returns once the sheet has rolled away.
  const empty =
    springAt(t, emptyAt, 150, 18) * (1 - prog(t, T.approvalIn, T.approvalIn + 0.2)) +
    prog(t, T.approve + 0.38, T.approve + 0.72);
  const rest = springAt(t, T.clear, 150, 18);
  const badgeSwap = prog(t, emptyAt - 0.1, emptyAt + 0.25);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: -BLEED,
          top: G.top,
          width: G.colW + BLEED,
          height: 1080 - G.top + BLEED,
          background: C.panel,
          borderRight: `1px solid ${C.line}`,
        }}
      />
      <div style={{ position: "absolute", left: 28, top: 104 }}>
        <div style={{ fontFamily: F.ui, fontSize: 31, fontWeight: 650, color: C.text, letterSpacing: "-0.02em" }}>Tomorrow</div>
        <div style={{ fontFamily: F.ui, fontSize: 17, color: C.text2, marginTop: 6 }}>Tuesday, Oct 14</div>
      </div>
      <div style={{ position: "absolute", right: 1920 - (G.cardX + G.cardW), top: 112 }}>
        <div style={{ position: "relative", height: 34 }}>
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              padding: "0 14px",
              height: 34,
              borderRadius: 17,
              background: "rgba(255,255,255,0.06)",
              border: `1px solid ${C.line2}`,
              display: "flex",
              alignItems: "center",
              fontFamily: F.ui,
              fontSize: 16,
              fontWeight: 600,
              color: C.text,
              whiteSpace: "nowrap",
              opacity: 1 - badgeSwap,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {remaining} {remaining === 1 ? "booking" : "bookings"}
          </div>
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              padding: "0 14px",
              height: 34,
              borderRadius: 17,
              background: C.accentDim,
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontFamily: F.ui,
              fontSize: 16,
              fontWeight: 650,
              color: C.accent,
              whiteSpace: "nowrap",
              opacity: badgeSwap,
              transform: `scale(${0.9 + 0.1 * badgeSwap})`,
              transformOrigin: "right center",
            }}
          >
            <Moon size={15} stroke={2.2} />
            Clear
          </div>
        </div>
      </div>

      {t > emptyAt - 0.05 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            width: G.colW,
            top: 470,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            opacity: empty,
            transform: `translateY(${(1 - empty) * 18}px)`,
            // Under the approval card while it is open; lit above the night after.
            zIndex: t > T.approve + 0.6 ? 46 : 20,
          }}
        >
          <div
            style={{
              width: 76,
              height: 76,
              borderRadius: "50%",
              background: C.accentDim,
              display: "grid",
              placeItems: "center",
              color: C.accent,
              marginBottom: 22,
            }}
          >
            <Moon size={36} stroke={2} />
          </div>
          <div style={{ fontFamily: F.ui, fontSize: 28, fontWeight: 650, color: C.text, letterSpacing: "-0.015em" }}>
            Nothing tomorrow.
          </div>
          <div
            style={{
              fontFamily: F.ui,
              fontSize: 20,
              color: C.text2,
              marginTop: 10,
              opacity: rest,
              transform: `translateY(${(1 - rest) * 8}px)`,
            }}
          >
            Rest up, Ines.
          </div>
        </div>
      )}
    </>
  );
};

const hourLabel = (h: number) => (h === 12 ? "12 PM" : h > 12 ? `${h - 12}` : h === 9 ? "9 AM" : `${h}`);

export const WeekGrid: React.FC = () => {
  const hours = [];
  for (let h = G.firstHour; h <= G.lastHour + 3; h++) hours.push(h);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: G.gridX,
          top: G.top,
          width: 1920 - G.gridX + BLEED,
          height: 1080 - G.top + BLEED,
          background: C.bg,
        }}
      />
      {DAYS.map((d, i) => {
        const [dow, num] = d.split(" ");
        const x = G.gridX + G.gutter + i * G.dayW;
        return (
          <React.Fragment key={d}>
            <div style={{ position: "absolute", left: x + 14, top: 96, display: "flex", alignItems: "baseline", gap: 9 }}>
              <span style={{ fontFamily: F.ui, fontSize: 14, fontWeight: 600, letterSpacing: "0.08em", color: C.text3 }}>
                {dow.toUpperCase()}
              </span>
              <span style={{ fontFamily: F.ui, fontSize: 24, fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums" }}>{num}</span>
            </div>
            <div
              style={{
                position: "absolute",
                left: x,
                top: G.gridTop,
                width: 1,
                height: 1080 - G.gridTop + BLEED,
                background: C.line,
              }}
            />
          </React.Fragment>
        );
      })}
      {hours.map((h) => {
        const y = G.gridTop + (h - G.firstHour) * G.hourH;
        return (
          <React.Fragment key={h}>
            <div
              style={{
                position: "absolute",
                left: G.gridX + G.gutter,
                top: y,
                width: 1920 - G.gridX + BLEED,
                height: 1,
                background: C.line,
                opacity: 0.8,
              }}
            />
            {h <= G.lastHour && (
              <div
                style={{
                  position: "absolute",
                  left: G.gridX,
                  width: G.gutter - 12,
                  top: y - 9,
                  textAlign: "right",
                  fontFamily: F.ui,
                  fontSize: 13,
                  color: C.text3,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {hourLabel(h)}
              </div>
            )}
          </React.Fragment>
        );
      })}
      {EXISTING.map((b, i) => {
        const r = slotRect(b.day, b.start, b.hours);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              borderRadius: 6,
              background: "#13161a",
              borderLeft: "3px solid #2f333b",
              padding: "7px 10px",
              boxSizing: "border-box",
              overflow: "hidden",
            }}
          >
            <div style={{ fontFamily: F.ui, fontSize: 14, fontWeight: 600, color: "#7b7c77", whiteSpace: "nowrap" }}>{b.name}</div>
          </div>
        );
      })}
    </>
  );
};
