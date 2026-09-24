import React, { useEffect, useState } from "react";
import { AbsoluteFill, Audio, continueRender, delayRender, staticFile, useCurrentFrame } from "remotion";
import { C, FPS } from "./theme";
import { fontsReady } from "./fonts";
import { cameraAt } from "./camera";
import { HourApp } from "./components/HourApp";
import { BrandScenes } from "./components/BrandScenes";

export const Film: React.FC<{ withAudio?: boolean }> = ({ withAudio = true }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const [handle] = useState(() => delayRender("fonts"));
  useEffect(() => {
    fontsReady.then(() => continueRender(handle));
  }, [handle]);

  const { cx, cy, s } = cameraAt(t);
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
      <BrandScenes t={t} />
      {withAudio && <Audio src={staticFile("audio/mix.wav")} />}
    </AbsoluteFill>
  );
};
