import type { CSSProperties, ReactNode } from "react";
import { ease, progress, type Ease } from "../lib/anim";
import { C } from "../theme";

export function Abs({
  x,
  y,
  w,
  h,
  style,
  children,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        ...(w === undefined ? {} : { width: w }),
        ...(h === undefined ? {} : { height: h }),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A line of type that rises into place from behind its own baseline mask. */
export function Rise({
  t,
  at,
  dur = 0.6,
  out,
  outDur = 0.38,
  children,
  style,
  lift = 1.08,
  e = ease.emphasized,
}: {
  t: number;
  at: number;
  dur?: number;
  out?: number;
  outDur?: number;
  children: ReactNode;
  style?: CSSProperties;
  lift?: number;
  e?: Ease;
}) {
  const pin = e(progress(t, at, at + dur));
  const pout = out === undefined ? 0 : ease.exit(progress(t, out, out + outDur));
  const y = (1 - pin) * lift * 100 - pout * lift * 100;
  return (
    <div style={{ overflow: "hidden", paddingBottom: "0.12em", marginBottom: "-0.12em", ...style }}>
      <div style={{ transform: `translate3d(0, ${y}%, 0)`, visibility: pin <= 0 || pout >= 1 ? "hidden" : "visible" }}>
        {children}
      </div>
    </div>
  );
}

/** Replaces one value with another by rolling it vertically, like a split-flap. */
export function Roll({
  t,
  at,
  from,
  to,
  dur = 0.55,
  style,
}: {
  t: number;
  at: number;
  from: ReactNode;
  to: ReactNode;
  dur?: number;
  style?: CSSProperties;
}) {
  const p = ease.emphasized(progress(t, at, at + dur));
  return (
    <div style={{ display: "grid", overflow: "hidden", ...style }}>
      <div style={{ gridArea: "1 / 1", transform: `translate3d(0, ${-p * 100}%, 0)`, visibility: p >= 1 ? "hidden" : "visible" }}>
        {from}
      </div>
      <div style={{ gridArea: "1 / 1", transform: `translate3d(0, ${(1 - p) * 100}%, 0)`, visibility: p <= 0 ? "hidden" : "visible" }}>
        {to}
      </div>
    </div>
  );
}

export function LiveDot({ size = 10, color = C.orange, style }: { size?: number; color?: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

/** Mono eyebrow in the site's voice: dot, uppercase, letter-spaced. */
export function Eyebrow({
  children,
  color = C.ink,
  dot = C.orange,
  size = 22,
  style,
}: {
  children: ReactNode;
  color?: string;
  dot?: string | null;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: size * 0.55,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: size,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {dot ? <LiveDot size={size * 0.42} color={dot} /> : null}
      <span>{children}</span>
    </div>
  );
}
