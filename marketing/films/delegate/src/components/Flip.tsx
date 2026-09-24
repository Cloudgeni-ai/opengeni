import React from "react";
import { C } from "../theme";
import { clamp01, ease } from "../anim";
import { T } from "../timeline";
import { Wordmark, WORDMARK_SIZE } from "./HourMark";

const FLIP_DUR = 0.36;

/** First letter of the wordmark: "h" folds away, "y" unfolds (split-flap). */
export const FlipLetter: React.FC<{ t: number }> = ({ t }) => {
  const k = clamp01((t - T.flip) / FLIP_DUR);
  if (k <= 0) return <span>h</span>;
  if (k >= 1) return <span>y</span>;
  const firstHalf = k < 0.5;
  const s = firstHalf ? 1 - ease.in(k * 2) : ease.out((k - 0.5) * 2);
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <span style={{ visibility: "hidden" }}>{firstHalf ? "h" : "y"}</span>
      <span
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transform: `scaleY(${Math.max(0.001, s)})`,
          transformOrigin: "50% 62%",
          filter: `brightness(${0.55 + 0.45 * s})`,
        }}
      >
        {firstHalf ? "h" : "y"}
      </span>
    </span>
  );
};

/** In-app wordmark (camera layer), kept lit above the "lights out" dim. */
export const HourFlipWordmark: React.FC<{ t: number }> = ({ t }) => (
  <div style={{ position: "absolute", left: 68, top: 22, zIndex: 46 }}>
    <Wordmark size={WORDMARK_SIZE} color={C.text} first={<FlipLetter t={t} />} />
  </div>
);
