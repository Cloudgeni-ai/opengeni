import { C, F } from "../theme";
import { T } from "../timeline";
import { Rise } from "./primitives";

const lineStyle = {
  fontFamily: F.display,
  fontSize: 80,
  fontWeight: 550,
  letterSpacing: "-0.035em",
  lineHeight: "84px",
  color: C.ink,
  whiteSpace: "nowrap",
} as const;

export function Supers({ t }: { t: number }) {
  if (t < T.super1 - 0.1 || t > T.supersOut + 0.6) return null;
  return (
    <div style={{ position: "absolute", left: 116, top: 334 }}>
      <Rise t={t} at={T.super1} dur={0.62} out={T.supersOut} style={lineStyle}>
        It knows exactly
      </Rise>
      <Rise t={t} at={T.super1 + 0.1} dur={0.62} out={T.supersOut + 0.04} style={lineStyle}>
        what to do.
      </Rise>
      <div style={{ height: 46 }} />
      <Rise t={t} at={T.super2} dur={0.62} out={T.supersOut + 0.08} style={lineStyle}>
        It just can’t
      </Rise>
      <Rise t={t} at={T.super2 + 0.1} dur={0.62} out={T.supersOut + 0.12} style={lineStyle}>
        do it.
      </Rise>
    </div>
  );
}
