import React from "react";
import { C } from "../theme";
import { F } from "../fonts";
import { clamp01, ease, lerp, prog, springAt } from "../anim";
import { T } from "../timeline";
import { MARK_SCALE } from "../camera";
import { Wordmark, WORDMARK_SIZE } from "./HourMark";
import { OpenGeniWordmark } from "./OpenGeniWordmark";

type Tok = [string, "kw" | "fn" | "key" | "str" | "p" | "id" | "your"];

/** Real @opengeni/sdk call (OpenGeniClient.createSession). Excerpt: the client
 * construction and error handling are omitted and say so on screen. */
export const CODE: Tok[][] = [
  [["await ", "kw"], ["opengeni", "id"], [".", "p"], ["createSession", "fn"], ["(", "p"], ["workspaceId", "id"], [", {", "p"]],
  [["  initialMessage", "key"], [": ", "p"], ["text", "id"], [",", "p"]],
  [["  tools", "key"], [": [{ ", "p"], ["kind", "key"], [": ", "p"], ['"mcp"', "str"], [", ", "p"], ["id", "key"], [": ", "p"], ['"your-app"', "str"], [" }],", "p"]],
  [["  mcpServers", "key"], [": [{", "p"]],
  [["    id", "key"], [": ", "p"], ['"your-app"', "str"], [",", "p"]],
  [["    url", "key"], [": ", "p"], ['"https://', "str"], ["your", "your"], ['.app/mcp"', "str"], [",", "p"]],
  [["    headers", "key"], [": { ", "p"], ["Authorization", "key"], [": ", "p"], ["userToken", "id"], [" },", "p"]],
  [["    requireApproval", "key"], [": [", "p"], ['"send_messages"', "str"], ["],", "p"]],
  [["  }],", "p"]],
  [["});", "p"]],
];

const TOK_COLOR: Record<Tok[1], string> = {
  kw: "#9a998f",
  fn: C.ink,
  key: "#5d5e57",
  str: "#b8401b",
  p: "#a3a299",
  id: C.ink,
  your: "#b8401b",
};

const CODE_SIZE = 35;
const CHAR_W = CODE_SIZE * 0.6;
const LINE_H = 57;
const CARD = { x: 132, y: 190, padX: 44, head: 60, padY: 28 };
const CARD_W = 44 * CHAR_W + CARD.padX * 2;
const CARD_H = CARD.head + CARD.padY * 2 + CODE.length * LINE_H;
const codeLeft = CARD.x + CARD.padX;
const lineTop = (i: number) => CARD.y + CARD.head + CARD.padY + i * LINE_H;
const YOUR_COL = 18;
export const YOUR_TARGET = { x: codeLeft + YOUR_COL * CHAR_W, y: lineTop(5), w: 4 * CHAR_W, h: LINE_H };

const ANN = [
  { line: 0, at: T.ann1, label: "A cloud agent, per customer" },
  { line: 5, at: T.ann2, label: "Your product's own actions" },
  { line: 7, at: T.ann3, label: "Needs your user's OK" },
];

/** Screen box of the in-app wordmark once the camera has landed on it. */
const START = { x: 960 + (68 - 103) * MARK_SCALE, y: 540 + (22 - 38) * MARK_SCALE, size: WORDMARK_SIZE * MARK_SCALE };

export const BrandScenes: React.FC<{ t: number }> = ({ t }) => {
  if (t < T.wipe) return null;
  const wipe = prog(t, T.wipe, T.wipe + 0.5, ease.inOut);
  const paperH = 1080 * wipe;

  // "your" leaves the product and lands inside the code.
  const fly = prog(t, T.yourFly, T.yourFly + 0.85, ease.camera);
  const size = Math.exp(lerp(Math.log(START.size), Math.log(CODE_SIZE * 1.06), fly));
  const endX = YOUR_TARGET.x + YOUR_TARGET.w / 2 - 0.53 * CODE_SIZE * 1.06 * 2;
  const endY = YOUR_TARGET.y + (LINE_H - CODE_SIZE * 1.06) / 2 - 2;
  const wx = lerp(START.x, endX, fly);
  const wy = lerp(START.y, endY, fly);
  const landed = prog(t, T.yourFly + 0.78, T.yourFly + 0.92, (x) => x);

  const codeOn = prog(t, T.code, T.code + 0.45, ease.out);
  const out = prog(t, T.codeOut, T.codeOut + 0.38, ease.in);

  const word = (color: string) => (
    <div style={{ position: "absolute", left: wx, top: wy, opacity: 1 - landed }}>
      <Wordmark size={size} color={color} first={<span>y</span>} />
    </div>
  );

  return (
    <>
      {/* Above the rising paper: the lit word on the dark app */}
      <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 0 ${paperH}px 0)` }}>{word(C.text)}</div>
      {/* The paper world */}
      <div style={{ position: "absolute", inset: 0, clipPath: `inset(${1080 - paperH}px 0 0 0)`, background: C.paper }}>
        <div style={{ position: "absolute", inset: 0, opacity: 1 - out, transform: `translateY(${-40 * out}px)` }}>
          <CodeCard t={t} on={codeOn} landed={landed} />
        </div>
        {word(C.ink)}
        <EndCard t={t} />
        <FinePrint t={t} />
      </div>
    </>
  );
};

const CodeCard: React.FC<{ t: number; on: number; landed: number }> = ({ t, on, landed }) => (
  <>
    <div
      style={{
        position: "absolute",
        left: CARD.x,
        top: CARD.y - 50,
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontFamily: F.mono,
        fontSize: 17,
        letterSpacing: "0.14em",
        color: C.ink2,
        opacity: on,
      }}
    >
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: C.verm, display: "inline-block" }} />
      YOUR BACKEND
    </div>
    <div
      style={{
        position: "absolute",
        left: CARD.x,
        top: CARD.y,
        width: CARD_W,
        height: CARD_H,
        background: C.paper2,
        border: `1px solid ${C.rule}`,
        opacity: on,
        transform: `translateY(${(1 - on) * 14}px)`,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: CARD.head,
          borderBottom: `1px solid ${C.rule}`,
          display: "flex",
          alignItems: "center",
          paddingLeft: CARD.padX,
          fontFamily: F.mono,
          fontSize: 18,
          color: C.muted,
        }}
      >
        server.ts
      </div>
    </div>
    {ANN.map((a) => {
      const k = prog(t, a.at, a.at + 0.3, ease.out);
      if (k <= 0) return null;
      return (
        <div
          key={`hl${a.line}`}
          style={{
            position: "absolute",
            left: CARD.x + 1,
            top: lineTop(a.line) + 3,
            width: (CARD_W - 2) * k,
            height: LINE_H - 6,
            background: "rgba(246,83,39,0.085)",
            borderLeft: `4px solid ${C.verm}`,
          }}
        />
      );
    })}
    {CODE.map((line, i) => {
      const k = prog(t, T.code + 0.06 + i * 0.035, T.code + 0.36 + i * 0.035, ease.out);
      let col = 0;
      return (
        <div
          key={i}
          style={{
            position: "absolute",
            left: codeLeft,
            top: lineTop(i),
            height: LINE_H,
            display: "flex",
            alignItems: "center",
            fontFamily: F.mono,
            fontSize: CODE_SIZE,
            whiteSpace: "pre",
            opacity: k,
            transform: `translateX(${(1 - k) * 10}px)`,
          }}
        >
          {line.map(([text, kind], j) => {
            const el = (
              <span
                key={j}
                style={{
                  color: TOK_COLOR[kind],
                  fontWeight: kind === "fn" ? 700 : kind === "id" ? 500 : 400,
                  opacity: kind === "your" ? landed : 1,
                }}
              >
                {text}
              </span>
            );
            col += text.length;
            return el;
          })}
        </div>
      );
    })}
    {ANN.map((a) => {
      const k = prog(t, a.at + 0.08, a.at + 0.5, ease.out);
      if (k <= 0) return null;
      const y = lineTop(a.line) + LINE_H / 2;
      const x0 = CARD.x + CARD_W + 14;
      return (
        <React.Fragment key={`ann${a.line}`}>
          <div style={{ position: "absolute", left: x0, top: y, width: 40 * k, height: 2, background: C.verm }} />
          <div
            style={{
              position: "absolute",
              left: x0 + 54,
              top: y - 26,
              fontFamily: F.brandSans,
              fontSize: 41,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: C.ink,
              whiteSpace: "nowrap",
              opacity: k,
              transform: `translateX(${(1 - k) * 16}px)`,
            }}
          >
            {a.label}
          </div>
        </React.Fragment>
      );
    })}
  </>
);

const EndCard: React.FC<{ t: number }> = ({ t }) => {
  if (t < T.line1 - 0.05) return null;
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
    fontVariationSettings: "'wdth' 100",
  };
  return (
    <>
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
    </>
  );
};

const FinePrint: React.FC<{ t: number }> = ({ t }) => {
  const k = prog(t, T.code + 0.3, T.code + 0.8);
  return (
    <div
      style={{
        position: "absolute",
        left: 150,
        bottom: 54,
        fontFamily: F.mono,
        fontSize: 16,
        letterSpacing: "0.02em",
        color: C.muted,
        opacity: k,
      }}
    >
      “hour” is a fictional app. Code is an excerpt of the real SDK call; client setup and error handling omitted.
    </div>
  );
};
