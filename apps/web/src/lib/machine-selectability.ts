// Compute-selectability for an enrolled machine in the session "Run on" pickers.
//
// The backend create-time attach gate checks LIVENESS only — compute-only
// sessions (terminal/files/git/exec) are fully supported, so `display_unavailable`
// means "no desktop stream", NOT "can't attach". A machine is selectable iff its
// liveness is online: `online` or `display_unavailable`. `consent_required` must
// still gate (consent), and `offline` / `reconnecting` / `enrolling` genuinely
// can't attach.
export function isMachineComputeSelectable(state: string): boolean {
  return state === "online" || state === "display_unavailable";
}
