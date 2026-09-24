import { Key, track, trackScale } from "./anim";
import { T } from "./timeline";
import { G } from "./data";
import { APPROVAL_H } from "./components/AgentPanel";

const approvalCy = G.askY + APPROVAL_H / 2 + 12;
const ben = { x: G.cardX + G.cardW / 2, y: G.listY + G.cardH / 2 };
/** "Nothing tomorrow. Rest up, Ines." — the last image of the night. */
const rest = { x: G.colW / 2 + 40, y: 590 };

/** Virtual camera over the 1920×1080 app. cx/cy = app point at frame centre. */
export const CAM: Key[] = [
  { t: 0, cx: 872, cy: 496, s: 1.1 },
  { t: T.dialogOpen, cx: 872, cy: 500, s: 1.12 },
  { t: T.cancelClick, cx: 880, cy: 530, s: 1.24 },
  { t: T.askClick + 0.3, cx: 330, cy: 238, s: 2.46 },
  { t: T.enter, cx: 332, cy: 242, s: 2.52 },
  // The proof: a close-up on Ben's card as the app reads his history.
  { t: T.check - 0.05, cx: ben.x + 12, cy: ben.y, s: 2.78 },
  { t: T.check + 0.45, cx: ben.x + 14, cy: ben.y + 4, s: 2.82 },
  { t: T.check + 1.25, cx: 430, cy: 622, s: 1.42 },
  { t: T.flights - 0.15, cx: 430, cy: 626, s: 1.44 },
  { t: T.flights + 0.85, cx: 960, cy: 540, s: 1 },
  { t: T.approvalIn - 0.3, cx: 956, cy: 542, s: 1.025 },
  // Close enough that the drafted message reads on a phone.
  { t: T.approvalIn + 0.8, cx: 344, cy: approvalCy, s: 1.98 },
  { t: T.approve, cx: 344, cy: approvalCy + 4, s: 2.06 },
  { t: T.clear, cx: 960, cy: 540, s: 1.0 },
  // Lights out: drift toward the only words still lit.
  { t: T.wipe + 0.4, cx: rest.x + 60, cy: rest.y, s: 1.5 },
];

export function cameraAt(t: number) {
  return { cx: track(CAM, t, "cx"), cy: track(CAM, t, "cy"), s: trackScale(CAM, t) };
}
