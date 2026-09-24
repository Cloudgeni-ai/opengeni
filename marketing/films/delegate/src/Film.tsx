import React, { useEffect, useState } from "react";
import { AbsoluteFill, Audio, continueRender, delayRender, staticFile, useCurrentFrame } from "remotion";
import { C, FPS } from "./theme";
import { fontsReady } from "./fonts";
import { cameraAt } from "./camera";
import { T } from "./timeline";
import { HourApp } from "./components/HourApp";
import { BrandScenes } from "./components/BrandScenes";

export const Film: React.FC<{ withAudio?: boolean }> = ({ withAudio = true }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const [handle] = useState(() => delayRender("fonts"));
  useEffect(() => {
    fontsReady.then(() => continueRender(handle));
  }, [handle]);

  const cam = cameraAt(t);
  const { cx, cy } = cam;
  // The last click lands physically: a 1.4% punch-in that relaxes in ~0.3 s.
  const d = t - T.approve;
  const punch = d >= 0 && d < 0.9 ? 0.014 * Math.exp(-d / 0.16) * Math.min(1, d / 0.03) : 0;
  const s = cam.s * (1 + punch);
  const vignette = 1 - Math.min(1, Math.max(0, (t - T.wipe) / 0.4));
  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1920,
          height: 1080,
          transformOrigin: "0 0",
          transform: `translate(${960 - cx * s}px, ${540 - cy * s}px) scale(${s})`,
        }}
      >
        <HourApp t={t} />
      </div>
      {vignette > 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            opacity: vignette,
            background: "radial-gradient(ellipse 75% 70% at 50% 48%, rgba(0,0,0,0) 58%, rgba(0,0,0,0.30) 100%)",
          }}
        />
      )}
      <BrandScenes t={t} />
      {withAudio && <Audio src={staticFile("audio/mix.wav")} />}
    </AbsoluteFill>
  );
};
