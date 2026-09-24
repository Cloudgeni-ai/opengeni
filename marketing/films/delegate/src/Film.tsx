import React, { useEffect, useState } from "react";
import { AbsoluteFill, Audio, continueRender, delayRender, staticFile, useCurrentFrame } from "remotion";
import { C, FPS } from "./theme";
import { fontsReady } from "./fonts";
import { cameraAt } from "./camera";
import { T } from "./timeline";
import { ease, prog } from "./anim";
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

  // Morning: the product lifts off the page like an object, then slides away,
  // revealing what it took, underneath it.
  const lift = prog(t, T.wipe, T.wipe + 0.5, ease.out);
  const slide = prog(t, T.wipe + 0.36, T.wipe + 1.14, ease.inOut);
  const surfaceGone = t >= T.wipe + 1.14;
  const surfaceScale = 1 - 0.075 * lift - 0.03 * slide;

  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      <BrandScenes t={t} />
      {!surfaceGone && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            borderRadius: 22 * lift,
            transform: `translateY(${-1260 * slide}px) scale(${surfaceScale})`,
            transformOrigin: "50% 50%",
            boxShadow: lift > 0 ? `0 ${46 * lift}px ${130 * lift}px rgba(40,30,20,${0.32 * lift}), 0 ${6 * lift}px ${16 * lift}px rgba(40,30,20,${0.18 * lift})` : "none",
            background: C.bg,
          }}
        >
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
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              background: "radial-gradient(ellipse 75% 70% at 50% 48%, rgba(0,0,0,0) 58%, rgba(0,0,0,0.30) 100%)",
            }}
          />
        </div>
      )}
      {withAudio && <Audio src={staticFile("audio/mix.wav")} />}
    </AbsoluteFill>
  );
};
