import { ArrowUp, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { clamp, ease, lerp, progress } from "../lib/anim";
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

/**
 * The bolted-on assistant. It is deliberately well made — the joke is what it does, not how
 * it looks — but its rounded, floating, violet language is foreign to the product it sits on.
 */
const V = {
  accent: "#6b4cf6",
  accentSoft: "#efeafe",
  ink: "#1d1a2e",
  sub: "#77738a",
  line: "#ebe9f2",
  body: "#fbfbfe",
} as const;

export const widgetUserColour = V.accent;

const INTRO_H = 54;
const DOTS_H = 26;
const CHIPS_H = 88;

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
function grow(t: number, at: number, full: number, dur = 0.24) {
  return full * ease.outCubic(progress(t, at, at + dur));
}

export function Widget({ t }: { t: number }) {
  const typed = MESSAGE.slice(0, typedCount(t));
  const sent = t >= T.send;
  const caretOn = !sent && Math.floor(t * 2.2) % 2 === 0;
  const chipsGone = ease.inOutCubic(progress(t, T.send, T.send + 0.3));
  const bubbleIn = t >= T.dotsStart;
  const intro = ease.inOutCubic(progress(t, T.replyStart - 0.04, T.replyStart + 0.26));

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
        borderRadius: 26,
        background: C.white,
        border: `1px solid ${V.line}`,
        boxShadow: "0 28px 64px rgba(24, 18, 52, 0.16), 0 3px 10px rgba(24, 18, 52, 0.06)",
        overflow: "hidden",
        transform: `scale(${scale})`,
        transformOrigin: "70% 85%",
        fontFamily: F.widget,
        color: V.ink,
        opacity: clamp(1 - popShrink * 1.4),
      }}
    >
      <div
        style={{
          height: 86,
          borderBottom: `1px solid ${V.line}`,
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 22px",
        }}
      >
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: "50%",
            background: `linear-gradient(135deg, ${V.accent}, #c24bf0)`,
            display: "grid",
            placeItems: "center",
            color: C.white,
          }}
        >
          <Sparkles size={24} strokeWidth={2} />
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 650, letterSpacing: "-0.01em" }}>Acme Assistant</div>
          <div style={{ fontSize: 15.5, color: V.sub, marginTop: 3, display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#34c77b", display: "inline-block" }} />
            AI · replies instantly
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          top: 86,
          left: 0,
          right: 0,
          bottom: 92,
          background: V.body,
          padding: "0 22px 16px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          gap: 14,
          overflow: "hidden",
        }}
      >
        <Bubble side="ai">
          {WIDGET_GREETING} <Emoji name="sparkles" size={21} />
        </Bubble>

        {chipsGone < 1 ? (
          <div
            style={{
              height: CHIPS_H * (1 - chipsGone),
              marginTop: -14 * chipsGone,
              opacity: 1 - clamp(chipsGone * 2),
              display: "flex",
              flexWrap: "wrap",
              alignContent: "flex-start",
              gap: 9,
              justifyContent: "flex-end",
              flexShrink: 0,
              overflow: "hidden",
            }}
          >
            {WIDGET_SUGGESTIONS.map((label) => (
              <span
                key={label}
                style={{
                  border: "1.5px solid #e2dcf8",
                  color: V.accent,
                  borderRadius: 999,
                  padding: "7px 14px",
                  fontSize: 16.5,
                  fontWeight: 550,
                  background: C.white,
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </span>
            ))}
          </div>
        ) : null}

        {sent ? (
          <div style={{ height: grow(t, T.send, 108, 0.3), display: "flex", justifyContent: "flex-end", flexShrink: 0, overflow: "visible" }}>
            <div
              style={{
                // the bubble rises out of the input it was typed into
                transform: `translateY(${(1 - ease.emphasized(progress(t, T.send, T.send + 0.4))) * 112}px)`,
                alignSelf: "flex-end",
              }}
            >
              <Bubble side="me">{MESSAGE}</Bubble>
            </div>
          </div>
        ) : null}

        {bubbleIn ? (
          <div style={{ flexShrink: 0, alignSelf: "flex-start", opacity: ease.outCubic(progress(t, T.dotsStart, T.dotsStart + 0.16)) }}>
            <Bubble side="ai" wide>
              <div style={{ position: "relative", height: lerp(DOTS_H, INTRO_H, intro), overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 0, opacity: 1 - clamp(intro * 3) }}>
                  <TypingDots t={t} />
                </div>
                <div style={{ opacity: clamp(intro * 3 - 0.4), width: 394 }}>
                  {REPLY_WORDS.map((word, i) => (
                    <span key={i} style={{ opacity: ease.outCubic(progress(t, replyWordTime(i), replyWordTime(i) + 0.12)) }}>
                      {word}
                      {i === 4 ? (
                        <>
                          {" "}
                          <Emoji name="weary" size={20} />
                        </>
                      ) : null}{" "}
                    </span>
                  ))}
                </div>
              </div>
              <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {WIDGET_STEPS.map((step, i) => {
                  const at = T.listStart + i * T.listGap;
                  if (t < at) return null;
                  const p = ease.emphasized(progress(t, at, at + 0.26));
                  return (
                    <li
                      key={step}
                      style={{
                        height: grow(t, at, 29),
                        marginTop: i === 0 ? grow(t, at, 8) : 0,
                        opacity: p,
                        transform: `translateX(${(1 - p) * 10}px)`,
                        display: "flex",
                        gap: 10,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span style={{ width: 22, color: V.accent, fontWeight: 650 }}>{i + 1}.</span>
                      <span>{step}</span>
                    </li>
                  );
                })}
              </ol>
              {t >= T.signoff ? (
                <div
                  style={{
                    height: grow(t, T.signoff, 36),
                    paddingTop: 8,
                    overflow: "hidden",
                    opacity: ease.outCubic(progress(t, T.signoff, T.signoff + 0.2)),
                  }}
                >
                  {WIDGET_SIGNOFF} <Emoji name="sparkles" size={19} />
                </div>
              ) : null}
            </Bubble>
          </div>
        ) : null}
      </div>

      <div
        style={{
          position: "absolute",
          left: 18,
          right: 18,
          bottom: 18,
          minHeight: 58,
          display: "flex",
          alignItems: "flex-end",
          gap: 11,
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 58,
            borderRadius: 18,
            border: "1.5px solid #e4e0ee",
            background: C.white,
            padding: "15px 17px",
            fontSize: 20,
            lineHeight: 1.36,
            color: typed && !sent ? V.ink : "#aaa6b8",
            position: "relative",
          }}
        >
          {sent ? (
            <>
              <span style={{ opacity: ease.outCubic(progress(t, T.send + 0.18, T.send + 0.4)) }}>Message Acme Assistant…</span>
              <span style={{ position: "absolute", left: 17, top: 15, right: 17, color: V.ink, opacity: 1 - ease.outCubic(progress(t, T.send, T.send + 0.1)) }}>
                {typed}
              </span>
            </>
          ) : typed ? (
            typed
          ) : (
            "Message Acme Assistant…"
          )}
          {caretOn && typed ? (
            <span style={{ display: "inline-block", width: 2, height: 24, background: V.accent, verticalAlign: "-4px", marginLeft: 2 }} />
          ) : null}
        </div>
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: "50%",
            background: V.accent,
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
        padding: "13px 18px",
        borderRadius: 20,
        borderBottomRightRadius: me ? 6 : 20,
        borderTopLeftRadius: me ? 20 : 6,
        background: me ? V.accent : C.white,
        border: me ? "none" : `1px solid ${V.line}`,
        color: me ? C.white : V.ink,
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
    <div style={{ display: "flex", gap: 7, height: DOTS_H, alignItems: "center" }}>
      {[0, 1, 2].map((i) => {
        const phase = Math.sin((t - T.dotsStart) * 9 - i * 0.9);
        return (
          <span
            key={i}
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: V.accent,
              opacity: 0.35 + 0.45 * (phase * 0.5 + 0.5),
              transform: `translateY(${-3 * Math.max(0, phase)}px)`,
            }}
          />
        );
      })}
    </div>
  );
}
