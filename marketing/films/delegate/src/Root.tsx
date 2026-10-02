import React from "react";
import { Composition } from "remotion";
import { Film } from "./Film";
import { FPS, H, W } from "./theme";
import { DURATION_S } from "./timeline";
import { InsideProduct } from "./InsideProduct";
import insideTimeline from "./inside-product-timeline.json";

export const Root: React.FC = () => (
  <>
    <Composition
      id="InsideYourProduct"
      component={InsideProduct}
      durationInFrames={insideTimeline.duration * insideTimeline.fps}
      fps={insideTimeline.fps}
      width={W}
      height={H}
      defaultProps={{ withAudio: true }}
    />
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
