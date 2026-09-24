import { ArrowUp, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { clamp, ease, progress } from "../lib/anim";
import { C, F } from "../theme";
import {
  MESSAGE,
  REPLY_WORDS,
  T,
  WIDGET_GREETING,
  WIDGET_SIGNOFF,
  WIDGET_STEPS,
  WIDGET_SUGGESTIONS,
  replyWordTime,
  typedCount,
} from "../timeline";

export const WIDGET = { x: 1195, y: 226, w: 486, h: 674 } as const;

const gradient = `linear-gradient(125deg, ${C.widgetA}, ${C.widgetB})`;

function Emoji({ name, size }: { name: "sparkles" | "weary" | "pray"; size: number }) {
  return (
    <img
      src={`assets/emoji/${name}.png`}
      alt=""
      style={{ width: size, height: size * (128 / 136), verticalAlign: "-0.18em", display: "inline-block" }}
    />
  );
}

/** Height that grows from 0 so older messages glide upward instead of jumping. */
function grow(t: number, at: number, full: number, dur = 0.22) {
  return full * ease.outCubic(progress(t, at, at + dur));
}

export function Widget({ t }: { t: number }) {
  const typed = MESSAGE.slice(0, typedCount(t));
  const sent = t >= T.send;
  const caretOn = !sent && Math.floor(t * 2.2) % 2 === 0;
  const dotsVisible = t >= T.dotsStart && t < T.replyStart;
  const replyVisible = t >= T.replyStart;
  const wordsShown = REPLY_WORDS.filter((_, i) => replyWordTime(i) <= t).length;

  // Pop: a small swell, then collapse to nothing, leaving the request behind.
  const popSwell = ease.outCubic(progress(t, T.pop, T.pop + 0.07));
  const popShrink = ease.inCubic(progress(t, T.pop + 0.07, T.pop + 0.3));
  const scale = t < T.pop ? 1 : (1 + 0.035 * popSwell) * (1 - popShrink);
  if (scale <= 0.001) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: WIDGET.x,
        top: WIDGET.y,
        width: WIDGET.w,
        height: WIDGET.h,
        borderRadius: 28,
        background: C.white,
        boxShadow: "0 26px 64px rgba(58, 28, 108, 0.24), 0 3px 10px rgba(58, 28, 108, 0.10)",
        overflow: "hidden",
        transform: `scale(${scale})`,
        transformOrigin: "70% 85%",
        fontFamily: F.widget,
        color: C.widgetText,
        opacity: clamp(1 - popShrink * 1.4),
      }}
    >
      <div
        style={{
          height: 92,
          background: gradient,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "0 24px",
          color: C.white,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.22)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Sparkles size={26} strokeWidth={2} />
        </div>
        <div>
          <div style={{ fontSize: 24, fontWeight: 650, letterSpacing: "-0.01em" }}>Acme Assistant</div>
          <div style={{ fontSize: 17, opacity: 0.82, marginTop: 3, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#7ef0b0", display: "inline-block" }} />
            Online · replies instantly
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          top: 92,
          left: 0,
          right: 0,
          bottom: 92,
          padding: "0 22px 18px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          gap: 14,
          overflow: "hidden",
        }}
      >
        <Bubble side="ai">
          {WIDGET_GREETING} <Emoji name="sparkles" size={22} />
        </Bubble>

        {sent ? null : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9, justifyContent: "flex-end", flexShrink: 0 }}>
            {WIDGET_SUGGESTIONS.map((label) => (
              <span
                key={label}
                style={{
                  border: `1.5px solid #ddd6f3`,
                  color: C.widgetA,
                  borderRadius: 999,
                  padding: "8px 15px",
                  fontSize: 17,
                  fontWeight: 550,
                  background: "#fbfaff",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {sent ? (
          <div style={{ height: grow(t, T.send, 118), overflow: "visible", display: "flex", justifyContent: "flex-end" }}>
            <div
              style={{
                transform: `translateY(${(1 - ease.emphasized(progress(t, T.send, T.send + 0.3))) * 24}px)`,
                opacity: ease.outCubic(progress(t, T.send, T.send + 0.18)),
                alignSelf: "flex-end",
              }}
            >
              <Bubble side="me">{MESSAGE}</Bubble>
            </div>
          </div>
        ) : null}

        {dotsVisible ? (
          <div style={{ height: grow(t, T.dotsStart, 56), display: "flex" }}>
            <Bubble side="ai">
              <TypingDots t={t} />
            </Bubble>
          </div>
        ) : null}

        {replyVisible ? (
          <Bubble side="ai" wide>
            <div>
              {REPLY_WORDS.slice(0, wordsShown).join(" ")}
              {wordsShown >= 5 ? (
                <>
                  {" "}
                  <Emoji name="weary" size={21} />
                </>
              ) : null}
            </div>
            <ol style={{ margin: "10px 0 0", padding: 0, listStyle: "none" }}>
              {WIDGET_STEPS.map((step, i) => {
                const at = T.listStart + i * T.listGap;
                if (t < at) return null;
                const p = ease.emphasized(progress(t, at, at + 0.26));
                return (
                  <li
                    key={step}
                    style={{
                      height: grow(t, at, 30),
                      opacity: p,
                      transform: `translateX(${(1 - p) * 10}px)`,
                      display: "flex",
                      gap: 10,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ width: 22, color: C.widgetA, fontWeight: 650 }}>{i + 1}.</span>
                    <span>{step}</span>
                  </li>
                );
              })}
            </ol>
            {t >= T.signoff ? (
              <div style={{ height: grow(t, T.signoff, 38), paddingTop: 10, opacity: ease.outCubic(progress(t, T.signoff, T.signoff + 0.2)) }}>
                {WIDGET_SIGNOFF} <Emoji name="sparkles" size={20} />
              </div>
            ) : null}
          </Bubble>
        ) : null}
      </div>

      <div
        style={{
          position: "absolute",
          left: 20,
          right: 20,
          bottom: 18,
          minHeight: 58,
          display: "flex",
          alignItems: "flex-end",
          gap: 12,
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 58,
            borderRadius: 22,
            border: "1.5px solid #e4e0ee",
            background: "#faf9fd",
            padding: "15px 18px",
            fontSize: 20,
            lineHeight: 1.36,
            color: typed && !sent ? C.widgetText : "#a9a4b8",
          }}
        >
          {sent || !typed ? "Message Acme Assistant…" : typed}
          {caretOn && typed ? (
            <span style={{ display: "inline-block", width: 2, height: 24, background: C.widgetA, verticalAlign: "-4px", marginLeft: 2 }} />
          ) : null}
        </div>
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: "50%",
            background: gradient,
            display: "grid",
            placeItems: "center",
            color: C.white,
            flexShrink: 0,
            transform: `scale(${t >= T.send - 0.06 && t < T.send + 0.1 ? 0.9 : 1})`,
          }}
        >
          <ArrowUp size={26} strokeWidth={2.4} />
        </div>
      </div>
    </div>
  );
}

function Bubble({ side, children, wide = false }: { side: "ai" | "me"; children: ReactNode; wide?: boolean }) {
  const me = side === "me";
  return (
    <div
      style={{
        alignSelf: me ? "flex-end" : "flex-start",
        maxWidth: wide ? 430 : me ? 330 : 360,
        padding: "14px 18px",
        borderRadius: 22,
        borderBottomRightRadius: me ? 6 : 22,
        borderTopLeftRadius: me ? 22 : 6,
        background: me ? gradient : C.widgetBubble,
        color: me ? C.white : C.widgetText,
        fontSize: me ? 20 : 19,
        lineHeight: 1.4,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

function TypingDots({ t }: { t: number }) {
  return (
    <div style={{ display: "flex", gap: 7, height: 26, alignItems: "center" }}>
      {[0, 1, 2].map((i) => {
        const phase = Math.sin((t - T.dotsStart) * 9 - i * 0.9);
        return (
          <span
            key={i}
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: C.widgetA,
              opacity: 0.35 + 0.45 * (phase * 0.5 + 0.5),
              transform: `translateY(${-3 * Math.max(0, phase)}px)`,
            }}
          />
        );
      })}
    </div>
  );
}

export const widgetGradient = gradient;
