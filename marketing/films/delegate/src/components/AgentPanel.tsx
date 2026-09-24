import React from "react";
import { C } from "../theme";
import { F } from "../fonts";
import { G, PREVIEW, REQUEST } from "../data";
import { ease, lerp, prog, springAt } from "../anim";
import { T, TYPE_TIMES, flightEnd, sentAt, typedCount } from "../timeline";
import { ArrowUp, Check, Sparkle } from "./Icons";

const LINE_BREAK = REQUEST.indexOf("to next week");
const LINE1 = REQUEST.slice(0, LINE_BREAK).trimEnd();

export const APPROVAL_H = 438;
const PAD = 26;
export const APPROVE_BTN = { x: G.askX + G.askW - PAD - 158, y: G.askY + APPROVAL_H - PAD - 54, w: 158, h: 54 };
const STATUS_H = 106;

function statusAt(t: number): { text: string; count?: string; done?: boolean } {
  if (t < T.flights) return { text: "Looking at each client's history" };
  if (t < T.draft) {
    let n = 0;
    for (let i = 0; i < 7; i++) if (t >= flightEnd(i)) n++;
    return { text: "Moving them to next week", count: `${n} / 7` };
  }
  if (t < T.approvalIn) return { text: "Writing a note to each client" };
  if (t < sentAt(6) + 0.35) return { text: "Sending 7 messages" };
  return { text: "Done. Tomorrow is clear.", done: true };
}

export const AgentPanel: React.FC<{ t: number }> = ({ t }) => {
  const focused = t >= T.askClick;
  const submitted = t >= T.enter;
  const n = typedCount(t);
  const typed = REQUEST.slice(0, n);
  const line1 = typed.slice(0, Math.min(n, LINE1.length));
  const line2 = n > LINE_BREAK ? typed.slice(LINE_BREAK) : "";
  const twoLines = n > LINE_BREAK;
  const lastKey = n > 0 ? TYPE_TIMES[n - 1] : -1;
  const caretOn = !submitted && focused && (t - lastKey < 0.5 || Math.floor((t - T.askClick) * 1.9) % 2 === 0);

  // Height choreography (the bottom edge is fixed). Every state change is
  // sequential: outgoing content leaves, the panel resizes, incoming arrives.
  const grow2 = springAt(t, TYPE_TIMES[LINE_BREAK] ?? 99, 260, 24);
  const typingH = lerp(G.askH, 112, twoLines ? grow2 : 0);
  const toStatus = springAt(t, T.enter + 0.06, 210, 23);
  const toApproval = springAt(t, T.approvalIn + 0.08, 150, 19);
  const collapseAt = T.approve + 0.17;
  const fromApproval = springAt(t, collapseAt, 340, 34);
  let h = focused ? typingH : G.askH;
  if (submitted) h = lerp(typingH, STATUS_H, toStatus);
  if (t >= T.approvalIn) h = lerp(STATUS_H, APPROVAL_H, toApproval);
  if (t >= collapseAt) h = lerp(APPROVAL_H, STATUS_H, fromApproval);

  const typingOut = submitted ? prog(t, T.enter + 0.02, T.enter + 0.17) : 0;
  const typingVis = 1 - typingOut;
  const statusIn1 = prog(t, T.enter + 0.15, T.enter + 0.38, ease.out);
  const statusOut = prog(t, T.approvalIn, T.approvalIn + 0.12);
  const approvalIn = prog(t, T.approvalIn + 0.15, T.approvalIn + 0.42, ease.out);
  const approvalOut = prog(t, T.approve + 0.09, T.approve + 0.19);
  const statusIn2 = prog(t, T.approve + 0.3, T.approve + 0.5, ease.out);
  const approvalVis = t >= T.approvalIn && t < collapseAt ? approvalIn * (1 - approvalOut) : 0;
  const statusVis = !submitted ? 0 : t < T.approvalIn ? statusIn1 : t < T.approve + 0.3 ? 1 - statusOut : statusIn2;
  const statusRise = t < T.approvalIn ? 1 - statusIn1 : 1 - statusIn2;

  const st = statusAt(t);
  const spin = (t - T.enter) * 140;
  const pressed = t >= T.approve - 0.03 && t < T.approve + 0.12;
  const focusRing = focused && !submitted;
  const doneK = st.done ? springAt(t, sentAt(6) + 0.35, 220, 18) : 0;

  return (
    <div
      style={{
        position: "absolute",
        left: G.askX,
        top: G.askY,
        width: G.askW,
        height: h,
        borderRadius: 14,
        background: C.raised,
        border: `1px solid ${focusRing ? "rgba(134,214,176,0.7)" : C.line2}`,
        boxShadow: `0 24px 70px rgba(0,0,0,0.55), 0 0 0 ${focusRing ? 4 : 0}px rgba(134,214,176,0.12)`,
        overflow: "hidden",
        zIndex: 40,
      }}
    >
      {typingVis > 0 && (
        <div style={{ position: "absolute", inset: 0, opacity: typingVis, transform: `translateY(${-18 * typingOut}px)` }}>
          <div style={{ position: "absolute", left: 20, top: 22, color: focused ? C.accent : C.text3 }}>
            <Sparkle size={24} />
          </div>
          <div
            style={{
              position: "absolute",
              left: 56,
              top: 16,
              right: 66,
              fontFamily: F.ui,
              fontSize: 25,
              lineHeight: "36px",
              letterSpacing: "-0.01em",
              color: C.text,
              whiteSpace: "pre",
            }}
          >
            {n === 0 ? (
              <span style={{ color: C.text3 }}>
                {caretOn && <Caret />}Ask hour to do something…
              </span>
            ) : (
              <>
                <div>
                  {line1}
                  {!twoLines && caretOn && <Caret />}
                </div>
                {twoLines && (
                  <div>
                    {line2}
                    {caretOn && <Caret />}
                  </div>
                )}
              </>
            )}
          </div>
          <div
            style={{
              position: "absolute",
              right: 14,
              bottom: 14,
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: n > 0 ? C.accent : "rgba(255,255,255,0.07)",
              color: n > 0 ? "#08241a" : C.text3,
              display: "grid",
              placeItems: "center",
              transform: `scale(${t >= T.enter - 0.05 && t < T.enter + 0.1 ? 0.88 : 1})`,
            }}
          >
            <ArrowUp size={20} stroke={2.4} />
          </div>
        </div>
      )}

      {statusVis > 0 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: STATUS_H,
            opacity: statusVis,
            transform: `translateY(${12 * statusRise}px)`,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 22,
              right: 22,
              top: 17,
              fontFamily: F.ui,
              fontSize: 17,
              color: C.text2,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            <span style={{ color: C.text3 }}>You · </span>
            {REQUEST}
          </div>
          <div style={{ position: "absolute", left: 22, right: 22, top: 53, height: 1, background: C.line }} />
          <div style={{ position: "absolute", left: 20, top: 65, display: "flex", alignItems: "center", gap: 12 }}>
            {st.done ? (
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: C.accent,
                  color: "#08241a",
                  display: "grid",
                  placeItems: "center",
                  transform: `scale(${0.6 + 0.4 * doneK})`,
                }}
              >
                <Check size={16} stroke={3} />
              </div>
            ) : (
              <div style={{ color: C.accent }}>
                <Sparkle size={24} spin={spin} />
              </div>
            )}
            <div style={{ fontFamily: F.ui, fontSize: 21, fontWeight: 600, color: C.text, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>
              {st.text}
            </div>
          </div>
          {st.count && (
            <div
              style={{
                position: "absolute",
                right: 22,
                top: 67,
                fontFamily: F.ui,
                fontSize: 18,
                fontWeight: 600,
                color: C.text2,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {st.count}
            </div>
          )}
        </div>
      )}

      {approvalVis > 0 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: APPROVAL_H,
            opacity: approvalVis,
            transform: `translateY(${14 * (1 - approvalIn)}px)`,
          }}
        >
          <div style={{ position: "absolute", left: PAD, top: 28, display: "flex", alignItems: "center", gap: 9, color: C.accent }}>
            <Sparkle size={20} />
            <span style={{ fontFamily: F.ui, fontSize: 16, fontWeight: 650, color: C.text2 }}>hour</span>
          </div>
          <div
            style={{
              position: "absolute",
              right: PAD,
              top: 23,
              height: 32,
              padding: "0 12px",
              borderRadius: 8,
              border: `1px solid ${C.line2}`,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: F.mono,
              fontSize: 15,
              color: C.text2,
            }}
          >
            send_messages
            <span style={{ color: C.text3 }}>·</span>
            <span style={{ fontFamily: F.ui, fontWeight: 650, color: C.accent, fontSize: 15 }}>needs your OK</span>
          </div>
          <div
            style={{
              position: "absolute",
              left: PAD,
              top: 74,
              fontFamily: F.ui,
              fontSize: 32,
              fontWeight: 700,
              color: C.text,
              letterSpacing: "-0.02em",
            }}
          >
            Send 7 messages as Ines?
          </div>
          {[2, 1].map((k) => (
            <div
              key={k}
              style={{
                position: "absolute",
                left: PAD + k * 12,
                right: PAD + k * 12,
                top: 132 + 150 + k * 9 - 20,
                height: 20,
                borderRadius: "0 0 12px 12px",
                background: `rgba(255,255,255,${0.035 - k * 0.01})`,
                border: `1px solid ${C.line2}`,
                borderTop: "none",
                opacity: 1 - k * 0.3,
              }}
            />
          ))}
          <div
            style={{
              position: "absolute",
              left: PAD,
              right: PAD,
              top: 132,
              height: 150,
              boxSizing: "border-box",
              borderRadius: 10,
              background: "#1e2128",
              border: `1px solid ${C.line2}`,
              padding: "14px 18px",
            }}
          >
            <div style={{ fontFamily: F.ui, fontSize: 14, fontWeight: 650, color: C.text3, letterSpacing: "0.04em" }}>
              TO {PREVIEW.to.toUpperCase()}
            </div>
            <div style={{ fontFamily: F.ui, fontSize: 20, lineHeight: "30px", color: C.text, marginTop: 6 }}>{PREVIEW.body}</div>
          </div>
          <div style={{ position: "absolute", left: PAD, top: 318, fontFamily: F.ui, fontSize: 17, color: C.text2 }}>
            + 6 more, each written for that client
          </div>
          <div
            style={{
              position: "absolute",
              left: APPROVE_BTN.x - G.askX - 12 - APPROVE_BTN.w,
              top: APPROVAL_H - PAD - APPROVE_BTN.h,
              width: APPROVE_BTN.w,
              height: APPROVE_BTN.h,
              borderRadius: 10,
              border: `1px solid #3a3f48`,
              display: "grid",
              placeItems: "center",
              fontFamily: F.ui,
              fontSize: 19,
              fontWeight: 600,
              color: C.text2,
            }}
          >
            Deny
          </div>
          <div
            style={{
              position: "absolute",
              left: APPROVE_BTN.x - G.askX,
              top: APPROVAL_H - PAD - APPROVE_BTN.h,
              width: APPROVE_BTN.w,
              height: APPROVE_BTN.h,
              borderRadius: 10,
              background: pressed ? "#74c9a0" : C.accent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 9,
              fontFamily: F.ui,
              fontSize: 19,
              fontWeight: 700,
              color: "#08241a",
              transform: `scale(${pressed ? 0.965 : 1})`,
            }}
          >
            <Check size={18} stroke={3} />
            Approve
          </div>
        </div>
      )}
    </div>
  );
};

const Caret: React.FC = () => (
  <span
    style={{
      display: "inline-block",
      width: 2.5,
      height: 29,
      background: C.accent,
      marginLeft: 1,
      marginRight: 1,
      verticalAlign: "-6px",
      borderRadius: 1,
    }}
  />
);
