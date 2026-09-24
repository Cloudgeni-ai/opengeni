import React from "react";
import { BRAND, archivo } from "../theme";
import { easeOut, prog } from "../lib/anim";

export const SUPER_Y = -300;
export const SUPER_SIZE = 124;

/** A line of the punchline. Words rise out of a baseline mask, one by one. */
export const Super: React.FC<{ text: string; x: number; t: number; at: number }> = ({ text, x, t, at }) => {
  const words = text.split(" ");
  return (
    <div
      style={{
        position: "absolute",
        left: x - 6,
        top: SUPER_Y,
        display: "flex",
        gap: SUPER_SIZE * 0.24,
        fontFamily: archivo,
        fontWeight: 600,
        fontSize: SUPER_SIZE,
        letterSpacing: -SUPER_SIZE * 0.035,
        lineHeight: 1.12,
        color: BRAND.ink,
        whiteSpace: "nowrap",
      }}
    >
      {words.map((w, i) => {
        const k = prog(t, at + i * 0.07, at + i * 0.07 + 0.55, easeOut);
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", paddingBottom: 12 }}>
            <span style={{ display: "inline-block", transform: `translateY(${(1 - k) * 105}%)` }}>{w}</span>
          </span>
        );
      })}
    </div>
  );
};
