// The always-loaded half of the failed-turn recovery journey: the composer
// and session chrome report recovery steps here, and the lazily loaded banner
// (turn-failure-analytics.ts) installs the sink when a failure is shown. With
// no banner shown, a step is ignored.
export type TurnFailureStep =
  | "retry"
  | "switch_model"
  | "buy_credits"
  | "connect_model"
  | "new_session"
  | "send_message";

let sink: ((step: TurnFailureStep) => void) | null = null;

export function setTurnFailureStepSink(next: ((step: TurnFailureStep) => void) | null): void {
  sink = next;
}

/** Record a recovery step for whichever failure banner is visible, if any. */
export function noteTurnFailureAction(step: TurnFailureStep): void {
  try {
    sink?.(step);
  } catch {
    // Optional telemetry cannot fail product work.
  }
}
