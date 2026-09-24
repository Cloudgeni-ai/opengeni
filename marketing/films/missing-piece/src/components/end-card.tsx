import { ease, progress } from "../lib/anim";
import { C, F } from "../theme";
import { T } from "../timeline";
import { Abs, Eyebrow, Rise } from "./primitives";
import { Wordmark } from "./wordmark";

const line = {
  fontFamily: F.display,
  fontSize: 92,
  fontWeight: 550,
  letterSpacing: "-0.04em",
  lineHeight: "94px",
  color: C.ink,
  whiteSpace: "nowrap",
} as const;

/**
 * Act 6 rhymes with act 2: the same composition (type left, product right), the opposite
 * truth. The product on the right is the real final state of the story, agent inside.
 */
export function EndTagline({ t }: { t: number }) {
  if (t < T.end - 0.1) return null;
  const mark = ease.emphasized(progress(t, T.wordmark - 0.5, T.wordmark));
  const url = ease.outCubic(progress(t, T.wordmark + 0.2, T.wordmark + 0.6));
  const note = ease.outCubic(progress(t, T.wordmark + 0.45, T.wordmark + 0.85));
  return (
    <>
      <Abs x={118} y={280}>
        <Rise t={t} at={T.end} dur={0.5}>
          <Eyebrow size={21}>Open source · Embeddable · Self-hostable</Eyebrow>
        </Rise>
      </Abs>
      <Abs x={112} y={332}>
        <Rise t={t} at={T.end + 0.1} dur={0.66} style={line}>
          Your product.
        </Rise>
        <Rise t={t} at={T.end + 0.24} dur={0.66} style={line}>
          Agents inside.
        </Rise>
      </Abs>
      <Abs x={120} y={738} style={{ overflow: "hidden" }}>
        <div style={{ transform: `translateY(${(1 - mark) * 102}%)` }}>
          <Wordmark height={44} color={C.ink} />
        </div>
      </Abs>
      <Abs x={120} y={794} style={{ opacity: url }}>
        <div style={{ fontFamily: F.mono, fontSize: 27, color: C.ink, letterSpacing: "0.02em" }}>opengeni.ai</div>
      </Abs>
      <Abs x={852} y={850} style={{ opacity: note }}>
        <div style={{ fontFamily: F.mono, fontSize: 17, color: C.muted2, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
          Illustrative product scenario
        </div>
      </Abs>
    </>
  );
}
