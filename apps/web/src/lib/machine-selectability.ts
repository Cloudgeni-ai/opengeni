// Compute-selectability for an enrolled machine in the session "Run on" pickers.
//
// The backend create-time attach gate checks LIVENESS only — compute-only
// sessions (terminal/files/git/exec) are fully supported. A machine is selectable
// iff the control plane can REACH it: `online` or `display_unavailable` (headless
// — no desktop stream, but compute works). `consent_required` is also selectable
// — a machine whose SCREEN CONTROL isn't consented is still fully usable for
// compute and read-only viewing; only INPUT is withheld (so it must never be
// un-selectable on that basis). Only `offline` / `reconnecting` / `enrolling`
// genuinely can't attach. (Since the machines deriver no longer folds consent
// into the state, `consent_required` is a defensive inclusion.)
export function isMachineComputeSelectable(state: string): boolean {
  return state === "online" || state === "display_unavailable" || state === "consent_required";
}
