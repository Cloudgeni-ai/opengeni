import React from "react";
import { BRAND, archivo, mono } from "../theme";
import { T } from "../timeline";
import { easeOut, prog } from "../lib/anim";

// Wordmark path from the live opengeni.ai navigation (2026-09-24).
const WORDMARK_PATH =
  "M20,0 H103 A20,20 0 0 1 123,20 V80 A20,20 0 0 1 103,100 H20 A20,20 0 0 1 0,80 V20 A20,20 0 0 1 20,0 Z M20,20 H103 L103,20 V80 L103,80 H20 L20,80 V20 L20,20 Z M143,0 H239 A20,20 0 0 1 259,20 V50 A20,20 0 0 1 239,70 H163 V100 H143 Z M163,20 H239 L239,20 V50 L239,50 H163 L163,50 V20 L163,20 Z M279,0 H389 V20 H299 V40 H379 V60 H299 V80 H389 V100 H279 Z M409,0 H429 L500.72,71.72 V0 H520.72 V100 H500.72 L429,28.28 V100 H409 Z M560.72,0 H650.72 V20 H560.72 V80 H636.72 V60 H593.72 V40 H656.72 V100 H560.72 A20,20 0 0 1 540.72,80 V20 A20,20 0 0 1 560.72,0 Z M676.72,0 H786.72 V20 H696.72 V40 H776.72 V60 H696.72 V80 H786.72 V100 H676.72 Z M806.72,0 H826.72 L898.43,71.72 V0 H918.43 V100 H898.43 L826.72,28.28 V100 H806.72 Z M938.43,0 h20 v100 h-20 Z";

export const Wordmark: React.FC<{ width: number; color: string }> = ({ width, color }) => (
  <svg viewBox="0 0 958.43 100" width={width} height={(width * 100) / 958.43} style={{ display: "block" }}>
    <path fillRule="evenodd" d={WORDMARK_PATH} fill={color} />
  </svg>
);

export const END_CX = 2040;
export const END_CY = 2860;

export const EndCard: React.FC<{ t: number }> = ({ t }) => {
  const k1 = prog(t, T.endEnd - 0.55, T.endEnd + 0.25, easeOut);
  const k2 = prog(t, T.endEnd - 0.25, T.endEnd + 0.5, easeOut);
  const k3 = prog(t, T.endEnd + 0.15, T.endEnd + 0.8, easeOut);
  return (
    <div
      style={{
        position: "absolute",
        left: END_CX - 1500,
        top: END_CY - 600,
        width: 3000,
        height: 1200,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ opacity: k1, transform: `translateY(${(1 - k1) * 40}px)` }}>
        <Wordmark width={1340} color={BRAND.ink} />
      </div>
      <div
        style={{
          marginTop: 150,
          fontFamily: archivo,
          fontWeight: 500,
          fontSize: 122,
          letterSpacing: -122 * 0.03,
          color: BRAND.ink,
          opacity: k2,
          transform: `translateY(${(1 - k2) * 30}px)`,
        }}
      >
        AI that works in your product.
      </div>
      <div
        style={{
          marginTop: 96,
          display: "flex",
          alignItems: "center",
          gap: 34,
          fontFamily: mono,
          fontSize: 66,
          color: BRAND.muted,
          letterSpacing: 2,
          opacity: k3,
        }}
      >
        <span style={{ width: 26, height: 26, background: BRAND.orange, display: "inline-block" }} />
        opengeni.ai
      </div>
    </div>
  );
};
