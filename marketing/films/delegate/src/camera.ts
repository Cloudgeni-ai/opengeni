import { Key, track, trackScale } from "./anim";
import { T } from "./timeline";
import { G } from "./data";
import { APPROVAL_H } from "./components/AgentPanel";

/** The wordmark's centre in app pixels (left 68, cap-height centred on the bar). */
export const MARK = { x: 103, y: 38 };
export const MARK_SCALE = 8;

const approvalCy = G.askY + G.askH - APPROVAL_H / 2 - 12;

/** Virtual camera over the 1920×1080 app. cx/cy = app point at frame centre. */
export const CAM: Key[] = [
  { t: 0, cx: 776, cy: 436, s: 1.24 },
  { t: T.dialogOpen, cx: 780, cy: 446, s: 1.25 },
  { t: T.cancelClick, cx: 846, cy: 522, s: 1.3 },
  { t: T.askClick + 0.25, cx: 312, cy: 962, s: 2.38 },
  { t: T.enter, cx: 314, cy: 966, s: 2.46 },
  { t: T.check - 0.05, cx: 392, cy: 452, s: 1.62 },
  { t: T.flights - 0.15, cx: 392, cy: 598, s: 1.64 },
  { t: T.flights + 0.95, cx: 960, cy: 540, s: 1 },
  { t: T.approvalIn - 0.3, cx: 956, cy: 542, s: 1.025 },
  { t: T.approvalIn + 0.8, cx: 334, cy: approvalCy, s: 1.8 },
  { t: T.approve, cx: 334, cy: approvalCy + 4, s: 1.87 },
  { t: T.clear, cx: 960, cy: 540, s: 1.0 },
  { t: T.toMark, cx: 960, cy: 540, s: 1 },
  { t: T.markArrive, cx: MARK.x, cy: MARK.y, s: MARK_SCALE },
];

export function cameraAt(t: number) {
  return { cx: track(CAM, t, "cx"), cy: track(CAM, t, "cy"), s: trackScale(CAM, t) };
}

/** App point → screen point for the camera at time t. */
export function toScreen(t: number, x: number, y: number) {
  const { cx, cy, s } = cameraAt(t);
  return { x: 960 + (x - cx) * s, y: 540 + (y - cy) * s, s };
}
