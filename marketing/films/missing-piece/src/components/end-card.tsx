import { ease, progress } from "../lib/anim";
import { C, F } from "../theme";
import { T } from "../timeline";
import { Abs, Eyebrow, Rise } from "./primitives";
import { Wordmark } from "./wordmark";

const headline = {
  fontFamily: F.display,
  fontSize: 132,
  fontWeight: 550,
  letterSpacing: "-0.042em",
  lineHeight: "132px",
  color: C.ink,
  whiteSpace: "nowrap",
} as const;

export function EndCard({ t }: { t: number }) {
  const mark = ease.emphasized(progress(t, T.end + 0.62, T.end + 1.2));
  const url = ease.outCubic(progress(t, T.end + 1.2, T.end + 1.6));
  const note = ease.outCubic(progress(t, T.end + 1.45, T.end + 1.85));
  return (
    <div style={{ position: "absolute", inset: 0, background: C.paper }}>
      <Abs x={186} y={262}>
        <Rise t={t} at={T.end} dur={0.5}>
          <Eyebrow size={24}>Open source · Embeddable · Self-hostable</Eyebrow>
        </Rise>
      </Abs>
      <Abs x={178} y={322}>
        <Rise t={t} at={T.end + 0.12} dur={0.7} style={headline}>
          Your product.
        </Rise>
        <Rise t={t} at={T.end + 0.27} dur={0.7} style={headline}>
          Agents inside.
        </Rise>
      </Abs>
      <Abs x={190} y={736} style={{ overflow: "hidden" }}>
        <div style={{ transform: `translateY(${(1 - mark) * 100}%)` }}>
          <Wordmark height={54} color={C.ink} />
        </div>
      </Abs>
      <Abs x={190} y={822} style={{ opacity: url }}>
        <div style={{ fontFamily: F.mono, fontSize: 30, color: C.ink, letterSpacing: "0.02em" }}>opengeni.ai</div>
      </Abs>
      <Abs x={1730} y={1000} style={{ opacity: note, transform: "translateX(-100%)" }}>
        <div style={{ fontFamily: F.mono, fontSize: 17, color: C.faint, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
          Illustrative product scenario
        </div>
      </Abs>
    </div>
  );
}
