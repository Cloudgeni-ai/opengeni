import React from "react";
import { Composition } from "remotion";
import { Film } from "./Film";
import { FPS, H, W } from "./theme";
import { DURATION_S } from "./timeline";

export const Root: React.FC = () => (
  <>
    <Composition
      id="TheLastClick"
      component={Film}
      durationInFrames={Math.round(DURATION_S * FPS)}
      fps={FPS}
      width={W}
      height={H}
      defaultProps={{ withAudio: true }}
    />
    <Composition
      id="TheLastClickSilent"
      component={Film}
      durationInFrames={Math.round(DURATION_S * FPS)}
      fps={FPS}
      width={W}
      height={H}
      defaultProps={{ withAudio: false }}
    />
  </>
);
