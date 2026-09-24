import React from "react";
import { staticFile } from "remotion";
import { C } from "../theme";
import { F } from "../fonts";
import { clamp01, ease, lerp, prog, springAt } from "../anim";
import { T } from "../timeline";
import { OpenGeniWordmark } from "./OpenGeniWordmark";
import { CursorArrow, flopPose } from "./Cursor";
import { HourGlyph } from "./HourMark";
import { Check } from "./Icons";

type Tok = [string, "kw" | "fn" | "key" | "str" | "p" | "id"];

/** Selected, current SDK integration surfaces. The authenticated hourTools
 * MCP server, client/provider, tenant mapping, and error handling live outside
 * this excerpt; the film explicitly discloses those omissions. */
export const CODE: Tok[][] = [
  [["const ", "kw"], ["session", "id"], [" = await ", "kw"], ["og", "id"], [".", "p"], ["createSession", "fn"], ["(", "p"]],
  [["  workspaceId, { initialMessage: text,", "p"]],
  [["    mcpServers", "key"], [": [", "p"], ["hourTools", "id"], ["],", "p"]],
  [["    tools", "key"], [": [{ kind: ", "p"], ['"mcp"', "str"], [", id: ", "p"], ['"hour"', "str"], [" }],", "p"]],
  [["  });", "p"]],
  [["// inside hour's UI", "kw"]],
  [["<", "p"], ["SessionConversation", "fn"], [" sessionId={session.id} />", "p"]],
];

/** Paper-on-ink, like the backend code block on opengeni.ai. */
const TOK: Record<Tok[1], string> = {
  kw: "#9e9d95",
  fn: C.paper,
  key: C.paperDim,
  str: C.vermOnInk,
  p: "#86857d",
  id: C.paper,
};

const SIZE = 36;
const CHAR_W = SIZE * 0.6;
const LINE_H = 82;
const ORIGIN = { x: 120, y: 232 };
const BLOCK_W = 45 * CHAR_W;
const lineTop = (i: number) => ORIGIN.y + i * LINE_H;

/** One idea at a time: token, line, plain-English callout — and the exact
 * moment from the story that the line produced. */
const CALLOUTS = [
  { line: 2, token: "mcpServers + tools", at: T.ann2, until: T.ann3, text: ["Give it your", "app’s actions."], echo: "move" as const },
  { line: 6, token: "SessionConversation", at: T.ann3, until: T.line1, text: ["Put it inside", "your app."], echo: "approve" as const },
];

/** Replicas of the story's own UI, drawn exactly as they appeared in "hour". */
const Echo: React.FC<{ kind: "move" | "approve" | "ask" }> = ({ kind }) => {
  if (kind === "move") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            position: "relative",
            width: 212,
            height: 62,
            borderRadius: 7,
            background: "linear-gradient(0deg, rgba(126,168,255,0.17), rgba(126,168,255,0.17)), #191c22",
            border: "1px solid rgba(126,168,255,0.34)",
            overflow: "hidden",
          }}
        >
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: "#7ea8ff" }} />
          <div style={{ position: "absolute", left: 14, top: 10, fontFamily: F.ui, fontSize: 16, fontWeight: 650, color: C.text }}>Ben Carter</div>
          <div style={{ position: "absolute", left: 14, top: 34, fontFamily: F.ui, fontSize: 14, color: C.text2 }}>Thu 5:00 · Cut</div>
        </div>
        <div style={{ fontFamily: F.ui, fontSize: 18, color: C.paperDim }}>moved by the agent</div>
      </div>
    );
  }
  if (kind === "approve") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            width: 158,
            height: 54,
            borderRadius: 10,
            background: C.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            fontFamily: F.ui,
            fontSize: 19,
            fontWeight: 700,
            color: "#08241a",
          }}
        >
          <Check size={18} stroke={3} /> Approve
        </div>
        <div style={{ fontFamily: F.ui, fontSize: 18, color: C.paperDim }}>the last click</div>
      </div>
    );
  }
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        height: 56,
        padding: "0 20px 0 16px",
        borderRadius: 12,
        background: "#191c22",
        border: `1px solid ${C.line2}`,
        fontFamily: F.ui,
        fontSize: 18,
        color: C.text,
        whiteSpace: "nowrap",
      }}
    >
      <HourGlyph size={22} />
      I'm sick. Move tomorrow's clients…
    </div>
  );
};

export const BrandScenes: React.FC<{ t: number }> = ({ t }) => {
  if (t < T.wipe) return null;
  // The page under the product: warm brand ink, lit softly from above, so the
  // film stays in one world instead of flashing to a different one.
  const endCut = t >= T.line1;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: `radial-gradient(ellipse 90% 80% at 42% 38%, #292a27 0%, ${C.ink} 55%, #191a18 100%)`,
      }}
    >
      {!endCut && <CodeSpread t={t} />}
      {t < T.ann2 + 0.18 && <Bridge t={t} />}
      <EndCard t={t} />
      <FinePrint t={t} />
    </div>
  );
};

/** The very same hour result remains in frame as we name the product boundary.
 * This is the missing link between the customer story and the builder reveal. */
const Bridge: React.FC<{ t: number }> = ({ t }) => {
  const on = prog(t, T.wipe + 0.2, T.wipe + 0.75, ease.out);
  const away = prog(t, T.ann2 - 0.33, T.ann2 + 0.14, ease.inOut);
  const v = on * (1 - away);
  const brand = prog(t, T.ann1 - 0.25, T.ann1 + 0.35, ease.out);
  return (
    <div style={{ position: "absolute", inset: 0, background: C.ink, opacity: v, pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 120, top: 192, width: 768, height: 432, overflow: "hidden", boxShadow: "0 34px 90px rgba(0,0,0,0.38)", border: `1px solid ${C.paperDim}` }}>
        <img src={staticFile("stills/hour-result.png")} alt="Result inside the fictional hour booking app" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
      <div style={{ position: "absolute", left: 990, top: 214, width: 800, fontFamily: F.display, fontWeight: 650, fontSize: 64, letterSpacing: "-0.045em", lineHeight: 1.13, color: C.paper }}>
        <div>hour is a booking app.</div>
        <div style={{ marginTop: 44, opacity: brand, transform: `translateY(${(1 - brand) * 16}px)` }}>
          <div><span style={{ color: C.vermOnInk }}>OpenGeni</span> powers</div>
          <div>the agent inside.</div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 120, bottom: 156, height: 2, width: 1620, background: C.rule, opacity: 0.3 }} />
      <div style={{ position: "absolute", left: 120, bottom: 106, fontFamily: F.ui, fontSize: 28, color: C.paperDim }}>Your existing app. A capable agent in it.</div>
    </div>
  );
};

const CodeSpread: React.FC<{ t: number }> = ({ t }) => {
  const on = prog(t, T.ann2 - 0.1, T.ann2 + 0.4, ease.out);
  const whole = prog(t, T.whole, T.whole + 0.45, ease.inOut);
  // A slow push for life; the page never sits dead still.
  const drift = prog(t, T.ann2, T.line1, (x) => x);
  const scale = 1 + 0.035 * drift;
  const active = CALLOUTS.find((c) => t >= c.at - 0.02 && t < c.until) ?? null;

  const lineLevel = (i: number) => {
    // Before the first callout everything is quiet texture.
    let lit = 0;
    for (const c of CALLOUTS) {
      if (c.line !== i) continue;
      const k = prog(t, c.at, c.at + 0.32) * (1 - prog(t, c.until - 0.18, c.until + 0.12));
      lit = Math.max(lit, k);
    }
    return Math.max(lit, whole);
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        transform: `scale(${scale})`,
        transformOrigin: `${ORIGIN.x + BLOCK_W / 2}px 540px`,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: ORIGIN.x,
          top: ORIGIN.y - 74,
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontFamily: F.mono,
          fontSize: 18,
          letterSpacing: "0.14em",
          color: C.paperDim,
          opacity: on,
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: C.verm, display: "inline-block" }} />
        TWO PIECES · YOUR SERVER AND YOUR APP
      </div>
      {CALLOUTS.map((c) => {
        const k = prog(t, c.at, c.at + 0.3) * (1 - prog(t, c.until - 0.16, c.until));
        const hold = whole;
        const v = Math.max(k, hold * 0.55);
        if (v <= 0) return null;
        return (
          <div
            key={`bar${c.line}`}
            style={{
              position: "absolute",
              left: ORIGIN.x - 36,
              top: lineTop(c.line) + 4,
              width: BLOCK_W + 60,
              height: LINE_H - 8,
              background: `rgba(246,83,39,${0.13 * v})`,
              borderLeft: `4px solid rgba(246,83,39,${v})`,
            }}
          />
        );
      })}
      {CODE.map((line, i) => {
        const appear = prog(t, T.ann2 + 0.02 * i, T.ann2 + 0.3 + 0.02 * i, ease.out);
        const level = lineLevel(i);
        const opacity = appear * lerp(0.52, 1, level);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: ORIGIN.x,
              top: lineTop(i),
              height: LINE_H,
              display: "flex",
              alignItems: "center",
              fontFamily: F.mono,
              fontSize: SIZE,
              whiteSpace: "pre",
              opacity,
              transform: `translateY(${(1 - appear) * 10}px)`,
            }}
          >
            {line.map(([text, kind], j) => (
              <span key={j} style={{ color: TOK[kind], fontWeight: kind === "fn" ? 700 : kind === "id" ? 500 : 400 }}>
                {text}
              </span>
            ))}
          </div>
        );
      })}
      {active && <Callout t={t} c={active} />}
    </div>
  );
};

const Callout: React.FC<{ t: number; c: (typeof CALLOUTS)[number] }> = ({ t, c }) => {
  const inK = prog(t, c.at + 0.06, c.at + 0.4, ease.out);
  const outK = c.until === T.line1 ? 0 : prog(t, c.until - 0.2, c.until - 0.02, ease.in);
  const vis = inK * (1 - outK);
  const echoK = prog(t, c.at + 0.22, c.at + 0.52, ease.out);
  const cy = lineTop(c.line) + LINE_H / 2;
  const top = Math.min(Math.max(cy - 92, 150), 700);
  return (
    <div
      style={{
        position: "absolute",
        left: ORIGIN.x + BLOCK_W + 64,
        top,
        opacity: vis,
        transform: `translateY(${(1 - inK) * 14 - outK * 8}px)`,
      }}
    >
      <div style={{ fontFamily: F.mono, fontSize: 21, letterSpacing: "0.02em", color: C.vermOnInk, marginBottom: 14 }}>{c.token}</div>
      {c.text.map((l) => (
        <div
          key={l}
          style={{
            fontFamily: F.display,
            fontSize: 60,
            fontWeight: 640,
            letterSpacing: "-0.035em",
            lineHeight: 1.05,
            color: C.paper,
            whiteSpace: "nowrap",
          }}
        >
          {l}
        </div>
      ))}
      <div style={{ marginTop: 22, opacity: echoK, transform: `translateY(${(1 - echoK) * 10}px)` }}>
        <Echo kind={c.echo} />
      </div>
    </div>
  );
};

const EndCard: React.FC<{ t: number }> = ({ t }) => {
  if (t < T.line1) return null;
  const l1 = springAt(t, T.line1, 120, 19);
  const l2 = springAt(t, T.line2, 120, 19);
  const m = springAt(t, T.mark, 110, 20);
  const line: React.CSSProperties = {
    fontFamily: F.display,
    fontSize: 104,
    fontWeight: 640,
    letterSpacing: "-0.035em",
    lineHeight: 1.04,
    color: C.paper,
    whiteSpace: "nowrap",
  };
  // A barely perceptible drift, so the last frame is alive rather than a slide.
  const drift = prog(t, T.line1, T.end, (x) => x);
  return (
    <div style={{ position: "absolute", inset: 0, transform: `scale(${1 + 0.014 * drift})`, transformOrigin: "150px 480px" }}>
      <div
        style={{
          position: "absolute",
          left: 152,
          top: 196,
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontFamily: F.mono,
          fontSize: 20,
          letterSpacing: "0.14em",
          color: C.paperDim,
          opacity: clamp01(l1 * 1.3),
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: C.verm, display: "inline-block" }} />
        AN AGENT IN YOUR PRODUCT
      </div>
      <div style={{ position: "absolute", left: 150, top: 262, ...line, opacity: clamp01(l1 * 1.3), transform: `translateY(${(1 - l1) * 26}px)` }}>
        Your app could do this.
      </div>
      <div style={{ position: "absolute", left: 150, top: 262 + 116, ...line, opacity: clamp01(l2 * 1.3), transform: `translateY(${(1 - l2) * 26}px)` }}>
        Put an agent inside<span style={{ color: C.verm }}>.</span>
        <RestingCursor t={t} />
      </div>
      <div style={{ position: "absolute", left: 152, top: 560, fontFamily: F.ui, fontSize: 33, color: C.paperDim, opacity: clamp01(m * 1.4), transform: `translateY(${(1 - m) * 10}px)` }}>
        Start with a chat. Connect your own tools.
      </div>
      <div style={{ position: "absolute", left: 150, right: 150, top: 690, height: 1, background: C.paper, opacity: 0.3 * m, transformOrigin: "left", transform: `scaleX(${m})` }} />
      <div style={{ position: "absolute", left: 150, top: 736, opacity: clamp01(m * 1.4), transform: `translateY(${(1 - m) * 14}px)` }}>
        <OpenGeniWordmark height={50} color={C.paper} />
      </div>
      <div
        style={{
          position: "absolute",
          right: 150,
          top: 744,
          fontFamily: F.mono,
          fontSize: 28,
          letterSpacing: "0.02em",
          color: C.paper,
          opacity: clamp01(m * 1.4),
          transform: `translateY(${(1 - m) * 14}px)`,
        }}
      >
        opengeni.ai
      </div>
      <div style={{ position: "absolute", left: 150, top: 855, fontFamily: F.ui, fontSize: 36, letterSpacing: "-0.01em", color: C.paperDim, opacity: clamp01(m * 1.4) }}>
        Apache-2.0 · Managed or self-hosted
      </div>
    </div>
  );
};

const FinePrint: React.FC<{ t: number }> = ({ t }) => {
  const k = prog(t, T.code + 0.3, T.code + 0.8);
  return (
    <div
      style={{
        position: "absolute",
        left: 150,
        bottom: 50,
        fontFamily: F.mono,
        fontSize: 27,
        letterSpacing: "0.01em",
        color: "#8a8980",
        opacity: k,
      }}
    >
      Illustrative app. Excerpts omit auth, customer setup and the protected tool endpoint.
    </div>
  );
};

/** The protagonist's last beat: it strolls in and lies down after the period.
 * No click — the approval was the last one. */
const RestingCursor: React.FC<{ t: number }> = ({ t }) => {
  if (t < T.restIn) return null;
  const k = prog(t, T.restIn, T.restFlop - 0.02, ease.pointer);
  const x = lerp(520, 16, k);
  const y = lerp(420, -12, k);
  const pose = flopPose(t, T.restFlop);
  return (
    <span style={{ position: "relative", display: "inline-block", width: 0, height: 0, verticalAlign: "baseline" }}>
      <span style={{ position: "absolute", left: x + 6, top: y - 34 }}>
        <CursorArrow pose={pose} scale={1.6} />
      </span>
    </span>
  );
};
