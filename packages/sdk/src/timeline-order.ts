/** Browser-safe timeline ordering shared with server-side conversation snapshots. */
export {
  isAgentActivityEvent,
  isTurnExecutionEvidence,
  orderTimelineEvents,
  prescanTurnAnchors,
  type TimelineOrderEvent,
  type TurnAnchorPrescan,
} from "@opengeni/contracts/timeline-order";
