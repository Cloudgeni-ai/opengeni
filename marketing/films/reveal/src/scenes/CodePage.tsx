import React from "react";
import { BRAND, CODE, SERVICE, inter, mono } from "../theme";
import { ReasonPill } from "./AppPage";
import { T } from "../timeline";
import { CODE_LINES, HIGHLIGHTS, tokenize, type HighlightKey, type TokenKind } from "../data/code";
import { alpha, clamp, easeOut, prog } from "../lib/anim";

export const CODE_X = 2160;
export const CODE_FONT = 24;
export const CODE_LINE_H = 35;
export const CODE_TOP = 104;
export const CODE_LEFT = 400;
const CHAR_W = CODE_FONT * 0.6;

export const lineTop = (n: number) => CODE_TOP + (n - 1) * CODE_LINE_H;

const COLORS: Record<TokenKind, string> = {
  kw: CODE.keyword,
  id: CODE.text,
  prop: CODE.text,
  str: CODE.string,
  punct: CODE.punct,
  com: CODE.comment,
  space: CODE.text,
};

function highlightLevel(key: HighlightKey, t: number): number {
  const h = T.highlights.find((x) => x.key === key);
  if (!h) return 0;
  const inK = prog(t, h.start, h.start + 0.22, easeOut);
  const outK = prog(t, h.end - 0.05, h.end + 0.18, easeOut);
  return inK * (1 - outK);
}

export const CodePage: React.FC<{ t: number }> = ({ t }) => {
  const first = T.highlights[0];
  const last = T.highlights[T.highlights.length - 1];
  const focus =
    prog(t, first.start - 0.1, first.start + 0.25, easeOut) *
    (1 - prog(t, last.end - 0.05, last.end + 0.35, easeOut));
  const levels = {
    tenant: highlightLevel("tenant", t),
    tools: highlightLevel("tools", t),
    approval: highlightLevel("approval", t),
  } satisfies Record<HighlightKey, number>;

  const lineLevel = (n: number) =>
    Math.max(
      ...(Object.keys(HIGHLIGHTS) as HighlightKey[]).map((k) =>
        n >= HIGHLIGHTS[k].from && n <= HIGHLIGHTS[k].to ? levels[k] : 0,
      ),
    );

  return (
    <div
      style={{
        position: "absolute",
        left: CODE_X,
        top: 0,
        width: 1920,
        height: 1080,
        background: CODE.bg,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: CODE_LEFT - 104,
          top: 34,
          height: 40,
          display: "flex",
          alignItems: "center",
          gap: 14,
          fontFamily: mono,
          fontSize: 19,
        }}
      >
        <span style={{ color: CODE.comment }}>app/api/agent/</span>
        <span style={{ color: CODE.text, marginLeft: -14 }}>route.ts</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: CODE_LEFT - 104,
          top: 84,
          width: 1920 - (CODE_LEFT - 104) * 2,
          height: 1,
          background: "#393936",
        }}
      />
      {CODE_LINES.map((line, idx) => {
        const n = idx + 1;
        const lvl = lineLevel(n);
        const dim = 1 - 0.62 * focus * (1 - lvl);
        return (
          <React.Fragment key={n}>
            {lvl > 0 ? (
              <div
                style={{
                  position: "absolute",
                  left: CODE_LEFT - 22,
                  top: lineTop(n),
                  width: 1140,
                  height: CODE_LINE_H,
                  background: alpha(BRAND.orange, 0.12 * lvl),
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: 3,
                    height: CODE_LINE_H,
                    background: alpha(BRAND.orange, lvl),
                  }}
                />
              </div>
            ) : null}
            <div
              style={{
                position: "absolute",
                left: CODE_LEFT - 104,
                width: 64,
                top: lineTop(n),
                height: CODE_LINE_H,
                lineHeight: `${CODE_LINE_H}px`,
                textAlign: "right",
                fontFamily: mono,
                fontSize: CODE_FONT * 0.8,
                color: CODE.gutter,
                opacity: dim,
              }}
            >
              {n}
            </div>
            <div
              style={{
                position: "absolute",
                left: CODE_LEFT,
                top: lineTop(n),
                height: CODE_LINE_H,
                lineHeight: `${CODE_LINE_H}px`,
                fontFamily: mono,
                fontSize: CODE_FONT,
                whiteSpace: "pre",
                fontVariantLigatures: "none",
                opacity: dim,
              }}
            >
              {tokenize(line).map((tok, i) => {
                const isCueComment = tok.kind === "com" && levels.tools > 0;
                return (
                  <span
                    key={i}
                    style={{
                      color: isCueComment ? BRAND.orange : lvl > 0 && tok.kind !== "punct" ? brighten(COLORS[tok.kind], lvl) : COLORS[tok.kind],
                      fontStyle: tok.kind === "com" ? "italic" : "normal",
                    }}
                  >
                    {tok.text}
                  </span>
                );
              })}
            </div>
          </React.Fragment>
        );
      })}
      {(Object.keys(HIGHLIGHTS) as HighlightKey[]).map((key) => (
        <Cue key={key} hkey={key} level={levels[key]} t={t} />
      ))}
    </div>
  );
};

function brighten(color: string, lvl: number): string {
  return lvl > 0.5 ? "#ffffff" : color;
}

const Cue: React.FC<{ hkey: HighlightKey; level: number; t: number }> = ({ hkey, level, t }) => {
  if (level <= 0) return null;
  const h = HIGHLIGHTS[hkey];
  const maxChars = Math.max(
    ...h.clear.map((n) => {
      const line = CODE_LINES[n - 1];
      return (line.includes("//") ? line.slice(0, line.indexOf("//")).trimEnd() : line).length;
    }),
  );
  const x = CODE_LEFT + maxChars * CHAR_W + 36;
  const y = lineTop(Math.floor(h.cueLine)) + (h.cueLine % 1) * CODE_LINE_H + CODE_LINE_H / 2;
  const k = clamp(level);
  const start = T.highlights.find((item) => item.key === hkey)?.start ?? 0;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        display: "flex",
        alignItems: "center",
        gap: 16,
        opacity: k,
        transform: `translate(${(1 - k) * -14}px, -50%)`,
      }}
    >
      <svg viewBox="0 0 34 16" width={34} height={16} style={{ flex: "none" }}>
        <path d="M33 8H3M9 2L3 8l6 6" fill="none" stroke={BRAND.orange} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {hkey === "tenant" ? <TenantChip /> : hkey === "tools" ? <MovedBlock t={t} start={start} /> : <SendReplica t={t} start={start} />}
    </div>
  );
};

const TenantChip: React.FC = () => (
  <div
    style={{
      height: 54,
      padding: "0 22px 0 7px",
      borderRadius: 27,
      background: "#ffffff",
      display: "flex",
      alignItems: "center",
      gap: 12,
      fontFamily: inter,
      boxShadow: `0 0 0 2px ${BRAND.orange}`,
    }}
  >
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: 20,
        background: "#dccfbd",
        color: "#4a3d2c",
        fontSize: 15,
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      LO
    </div>
    <span style={{ fontSize: 21, fontWeight: 600, color: "#1d1d1b", letterSpacing: -0.2 }}>Studio Lena</span>
  </div>
);

const MovedBlock: React.FC<{ t: number; start: number }> = ({ t, start }) => {
  const slide = prog(t, start + 0.04, start + 0.5, easeOut);
  const svc = SERVICE.cut;
  return (
    <div
      style={{
        position: "relative",
        width: 264,
        height: 64,
        borderRadius: 8,
        background: svc.fill,
        overflow: "hidden",
        fontFamily: inter,
        transform: `translateX(${(1 - slide) * -26}px)`,
        boxShadow: `0 0 0 2px ${BRAND.orange}`,
      }}
    >
      <div style={{ position: "absolute", left: 0, top: 0, width: 4, bottom: 0, background: svc.bar }} />
      <div style={{ position: "absolute", left: 14, right: 12, top: 9, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 17, fontWeight: 600, color: svc.text, letterSpacing: -0.2 }}>Ana Ruiz</span>
        <ReasonPill text="her mornings" k={slide} />
      </div>
      <div style={{ position: "absolute", left: 14, top: 33, fontSize: 13.5, fontWeight: 500, color: alpha(svc.text, 0.72) }}>
        Tue 9:00 · Cut &amp; gloss
      </div>
    </div>
  );
};

export const SEND_REPLICA_PRESS = 0.45;

const SendReplica: React.FC<{ t: number; start: number }> = ({ t, start }) => {
  const at = start + SEND_REPLICA_PRESS;
  const press = prog(t, at, at + 0.07, easeOut) * (1 - prog(t, at + 0.07, at + 0.22, easeOut));
  const sent = t >= at + 0.1;
  return (
    <div style={{ position: "relative", padding: 6, borderRadius: 14, background: "#ffffff", boxShadow: `0 0 0 2px ${BRAND.orange}` }}>
      <div
        style={{
          width: 214,
          height: 44,
          borderRadius: 9,
          background: "#1d1d1b",
          color: "#f7f6f1",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: inter,
          fontSize: 17,
          fontWeight: 600,
          transform: `scale(${1 - 0.05 * press})`,
        }}
      >
        {sent ? "Sent" : "Send 6 messages"}
      </div>
      <svg
        viewBox="0 0 24 24"
        width={30}
        height={30}
        style={{
          position: "absolute",
          left: 150,
          top: 30,
          transform: `scale(${1 - 0.12 * press})`,
          filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.35))",
        }}
      >
        <path d="M4 2.5l15 9.2-6.6 1.3 3.9 7.3-2.7 1.4-3.9-7.3-4.8 4.6z" fill="#111" stroke="#fff" strokeWidth={1.4} strokeLinejoin="round" />
      </svg>
    </div>
  );
};
