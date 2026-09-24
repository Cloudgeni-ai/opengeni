import React from "react";
import { AbsoluteFill, Audio, getStaticFiles, staticFile, useCurrentFrame } from "remotion";
import { BRAND, dmSans } from "./theme";
import { FPS, HEIGHT, T, WIDTH } from "./timeline";
import { cameraAt } from "./camera";
import { AppPage } from "./scenes/AppPage";
import { CODE_X, CodePage } from "./scenes/CodePage";
import { Supers } from "./scenes/Supers";
import { EndCard } from "./scenes/EndCard";
import { alpha, clamp, easeIn, prog } from "./lib/anim";

const SCORE = "audio/score.wav";

export const Film: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const cam = cameraAt(t);
  const pageChrome = clamp((0.97 - cam.s) / 0.2);
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
        <PageShadow x={0} k={pageChrome * (t >= T.openEnd ? 1 : 0)} border />
        <PageShadow x={CODE_X} k={pageChrome} />
        <AppPage t={t} />
        <CodePage t={t} />
        <Supers t={t} />
        <EndCard t={t} />
      </div>
      <Disclaimer t={t} />
      {hasScore ? <Audio src={staticFile(SCORE)} /> : null}
    </AbsoluteFill>
  );
};

const PageShadow: React.FC<{ x: number; k: number; border?: boolean }> = ({ x, k, border }) =>
  k <= 0 ? null : (
    <div
      style={{
        position: "absolute",
        left: x,
        top: 0,
        width: 1920,
        height: 1080,
        boxShadow: `0 40px 110px ${alpha(BRAND.ink, 0.14 * k)}`,
        outline: border ? `2px solid ${alpha("#cfcdc3", k)}` : undefined,
      }}
    />
  );

const Disclaimer: React.FC<{ t: number }> = ({ t }) => {
  const k = 1 - prog(t, T.wideHerStart, T.wideHerStart + 0.35, easeIn);
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
