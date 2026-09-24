import React from "react";
import { C } from "../theme";
import { F } from "../fonts";
import { clamp01, ease, lerp, prog, springAt } from "../anim";
import { T } from "../timeline";
import { OpenGeniWordmark } from "./OpenGeniWordmark";

type Tok = [string, "kw" | "fn" | "key" | "str" | "p" | "id"];

/** Real @opengeni/sdk call (OpenGeniClient.createSession). Excerpt: client
 * construction and error handling are omitted, and the fine print says so. */
export const CODE: Tok[][] = [
  [["await ", "kw"], ["opengeni", "id"], [".", "p"], ["createSession", "fn"], ["(", "p"], ["workspaceId", "id"], [", {", "p"]],
  [["  initialMessage", "key"], [": ", "p"], ["text", "id"], [",", "p"]],
  [["  tools", "key"], [": [{ ", "p"], ["kind", "key"], [": ", "p"], ['"mcp"', "str"], [", ", "p"], ["id", "key"], [": ", "p"], ['"your-app"', "str"], [" }],", "p"]],
  [["  mcpServers", "key"], [": [{", "p"]],
  [["    id", "key"], [": ", "p"], ['"your-app"', "str"], [",", "p"]],
  [["    url", "key"], [": ", "p"], ['"https://your.app/mcp"', "str"], [",", "p"]],
  [["    headers", "key"], [": { ", "p"], ["Authorization", "key"], [": ", "p"], ["userToken", "id"], [" },", "p"]],
  [["    requireApproval", "key"], [": [", "p"], ['"send_messages"', "str"], ["],", "p"]],
  [["  }],", "p"]],
  [["});", "p"]],
];

const TOK: Record<Tok[1], string> = {
  kw: "#8f8e85",
  fn: C.ink,
  key: "#55564f",
  str: "#b8401b",
  p: "#9b9a91",
  id: C.ink,
};

const SIZE = 38;
const CHAR_W = SIZE * 0.6;
const LINE_H = 60;
const ORIGIN = { x: 124, y: 240 };
const BLOCK_W = 44 * CHAR_W;
const lineTop = (i: number) => ORIGIN.y + i * LINE_H;

/** One idea at a time: token, line, plain-English callout. */
const CALLOUTS = [
  { line: 5, token: "url", at: T.ann1, until: T.ann2, text: ["Your product's", "own actions."] },
  { line: 7, token: "requireApproval", at: T.ann2, until: T.ann3, text: ["Your user", "says yes first."] },
  { line: 0, token: "createSession", at: T.ann3, until: T.line1, text: ["A cloud agent", "for each customer."] },
];

export const BrandScenes: React.FC<{ t: number }> = ({ t }) => {
  if (t < T.wipe) return null;
  // The page under the product. Its light comes up as the product lifts away,
  // so the eye adapts instead of being flashed.
  const light = prog(t, T.wipe, T.wipe + 1.35, ease.out);
  const endCut = t >= T.line1;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: C.paper,
        filter: light < 1 ? `brightness(${0.62 + 0.38 * light})` : undefined,
      }}
    >
      {!endCut && <CodeSpread t={t} />}
      <EndCard t={t} />
      <FinePrint t={t} />
    </div>
  );
};

const CodeSpread: React.FC<{ t: number }> = ({ t }) => {
  const on = prog(t, T.code, T.code + 0.5, ease.out);
  const whole = prog(t, T.whole, T.whole + 0.45, ease.inOut);
  // A slow push for life; the page never sits dead still.
  const drift = prog(t, T.code, T.line1, (x) => x);
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
          color: C.ink2,
          opacity: on,
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: C.verm, display: "inline-block" }} />
        YOUR BACKEND
      </div>
      {CALLOUTS.map((c) => {
        const k = prog(t, c.at, c.at + 0.3) * (1 - prog(t, c.until - 0.16, c.until));
        const hold = c.line === 0 ? whole : 0;
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
              background: `rgba(246,83,39,${0.09 * v})`,
              borderLeft: `4px solid rgba(246,83,39,${v})`,
            }}
          />
        );
      })}
      {CODE.map((line, i) => {
        const appear = prog(t, T.code + 0.04 * i, T.code + 0.3 + 0.04 * i, ease.out);
        const level = lineLevel(i);
        const opacity = appear * lerp(0.3, 1, level);
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
  const cy = lineTop(c.line) + LINE_H / 2;
  const top = Math.min(Math.max(cy - 92, 150), 820);
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
      <div style={{ fontFamily: F.mono, fontSize: 21, letterSpacing: "0.02em", color: C.vermDeep, marginBottom: 14 }}>{c.token}</div>
      {c.text.map((l) => (
        <div
          key={l}
          style={{
            fontFamily: F.display,
            fontSize: 60,
            fontWeight: 640,
            letterSpacing: "-0.035em",
            lineHeight: 1.05,
            color: C.ink,
            whiteSpace: "nowrap",
          }}
        >
          {l}
        </div>
      ))}
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
    color: C.ink,
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
          color: C.ink2,
          opacity: clamp01(l1 * 1.3),
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: C.verm, display: "inline-block" }} />
        AGENTS INSIDE YOUR PRODUCT
      </div>
      <div style={{ position: "absolute", left: 150, top: 262, ...line, opacity: clamp01(l1 * 1.3), transform: `translateY(${(1 - l1) * 26}px)` }}>
        Your product does the work.
      </div>
      <div style={{ position: "absolute", left: 150, top: 262 + 116, ...line, opacity: clamp01(l2 * 1.3), transform: `translateY(${(1 - l2) * 26}px)` }}>
        Your users keep the last click<span style={{ color: C.verm }}>.</span>
      </div>
      <div style={{ position: "absolute", left: 150, right: 150, top: 690, height: 1, background: C.ink, opacity: 0.85 * m, transformOrigin: "left", transform: `scaleX(${m})` }} />
      <div style={{ position: "absolute", left: 150, top: 736, opacity: clamp01(m * 1.4), transform: `translateY(${(1 - m) * 14}px)` }}>
        <OpenGeniWordmark height={50} color={C.ink} />
      </div>
      <div
        style={{
          position: "absolute",
          right: 150,
          top: 744,
          fontFamily: F.mono,
          fontSize: 28,
          letterSpacing: "0.02em",
          color: C.ink,
          opacity: clamp01(m * 1.4),
          transform: `translateY(${(1 - m) * 14}px)`,
        }}
      >
        opengeni.ai
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
        fontSize: 18,
        letterSpacing: "0.01em",
        color: C.muted,
        opacity: k,
      }}
    >
      “hour” is a fictional app. Code is an excerpt of the real SDK call; client setup and error handling omitted.
    </div>
  );
};
