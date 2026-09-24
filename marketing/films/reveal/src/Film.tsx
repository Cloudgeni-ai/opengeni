import React from "react";
import { AbsoluteFill, Audio, getStaticFiles, staticFile, useCurrentFrame } from "remotion";
import { BRAND, dmSans } from "./theme";
import { FPS, HEIGHT, T, WIDTH } from "./timeline";
import { cameraAt, SLIDE_DISTANCE, SLIDE_OUT, FINAL_CENTER_X, BRAND_TOP } from "./camera";
import { AppPage } from "./scenes/AppPage";
import { CodePage } from "./scenes/CodePage";
import { Super } from "./scenes/Supers";
import { BrandRow } from "./scenes/EndCard";
import { alpha, clamp, easeIn, easeInOut, prog } from "./lib/anim";

const SCORE = "audio/score.wav";

export const Film: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const cam = cameraAt(t);
  const pageChrome = clamp((0.97 - cam.s) / 0.2);
  const slide =
    -SLIDE_OUT * prog(t, T.slideStart, T.slideEnd, easeInOut) +
    (SLIDE_OUT - SLIDE_DISTANCE) * prog(t, T.finalStart, T.finalEnd, easeInOut);
  const sliding = t > T.slideStart && t < T.slideEnd;
  const codeVisible = t >= T.slideStart - 0.02;
  const hasScore = getStaticFiles().some((f) => f.name === SCORE);

  return (
    <AbsoluteFill style={{ background: BRAND.paper, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          transformOrigin: "0 0",
          transform: `translate(${WIDTH / 2}px, ${HEIGHT / 2}px) scale(${cam.s}) translate(${-cam.x}px, ${-cam.y}px)`,
        }}
      >
        {codeVisible ? (
          <>
            <PageShadow k={pageChrome} />
            <CodePage t={t} />
            <Super text="One handler for you." x={0} t={t} at={T.superYou} />
          </>
        ) : null}
        <div style={{ position: "absolute", left: 0, top: 0, transform: `translateX(${slide}px)` }}>
          <PageShadow k={pageChrome * (t >= T.openEnd ? 1 : 0)} border lift={sliding ? 1 : 0} />
          <AppPage t={t} />
          <Super text="One sentence for her." x={0} t={t} at={T.superHer} />
        </div>
        <BrandRow t={t} cx={FINAL_CENTER_X} top={BRAND_TOP} />
      </div>
      <Disclaimer t={t} />
      {hasScore ? <Audio src={staticFile(SCORE)} /> : null}
    </AbsoluteFill>
  );
};

const PageShadow: React.FC<{ k: number; border?: boolean; lift?: number }> = ({ k, border, lift = 0 }) =>
  k <= 0 ? null : (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
        boxShadow: `0 ${40 + 30 * lift}px ${110 + 60 * lift}px ${alpha(BRAND.ink, (0.14 + 0.12 * lift) * k)}`,
        outline: border ? `2px solid ${alpha("#cfcdc3", k)}` : undefined,
      }}
    />
  );

const Disclaimer: React.FC<{ t: number }> = ({ t }) => {
  const k = 1 - prog(t, T.slideStart, T.slideStart + 0.35, easeIn);
  if (k <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 30,
        bottom: 26,
        padding: "5px 12px",
        borderRadius: 6,
        background: alpha(BRAND.paper, 0.92),
        fontFamily: dmSans,
        fontSize: 19,
        color: alpha(BRAND.ink, 0.62),
        opacity: k,
      }}
    >
      Fictional app. Simulated screens.
    </div>
  );
};
