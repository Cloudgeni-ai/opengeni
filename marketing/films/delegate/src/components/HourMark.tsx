import React from "react";
import { C } from "../theme";
import { F } from "../fonts";

/** The "hour" mark: a dial with one filled hour. */
export const HourGlyph: React.FC<{ size: number; color?: string }> = ({ size, color = C.accent }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" style={{ display: "block" }}>
    <circle cx="16" cy="16" r="13" fill="none" stroke={color} strokeWidth="3" />
    <path d="M16 16 L16 3 A13 13 0 0 1 27.26 9.5 Z" fill={color} />
  </svg>
);

/** Wordmark set per letter so the first letter can be swapped (h → y). */
export const WORDMARK_SIZE = 31;
export const WORDMARK_LETTERS = ["h", "o", "u", "r"];

export const Wordmark: React.FC<{
  size?: number;
  color?: string;
  first?: React.ReactNode;
}> = ({ size = WORDMARK_SIZE, color = C.text, first }) => (
  <span
    style={{
      fontFamily: F.brandSans,
      fontWeight: 650,
      fontSize: size,
      letterSpacing: "-0.035em",
      color,
      lineHeight: 1,
      display: "inline-flex",
      alignItems: "baseline",
      fontVariationSettings: "'opsz' 32",
    }}
  >
    {first ?? <span>h</span>}
    <span>our</span>
  </span>
);
