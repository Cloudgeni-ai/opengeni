// ----------------------------------------------------------------------------
// Bring-your-own-compute — Machines view-model.
//
// The data-contract types (MachineView / MetricSample / MachinesResponse /
// MachineMetricsSeriesResponse / MachineKind / MachineState) are the
// orchestrator-owned SHARED DATA CONTRACT that M10 ships in `@opengeni/sdk`
// (hand-written mirrors of `@opengeni/contracts`, pinned by contract-parity).
// M9 RE-EXPORTS them here so the dashboard UI imports a single, stable name and
// never drifts from the API — exactly as the contract intends.
//
// (During concurrent M9/M10 development this module briefly carried a local
// view-model with the same field names; once M10 landed the SDK types we
// reconciled to re-export them — the field names were identical by design.)
//
// Endpoints these model (M10 owns the SDK client methods):
//   GET /v1/workspaces/:ws/machines                        -> MachinesResponse
//   GET /v1/workspaces/:ws/machines/:enrollmentId/metrics/series?window=1h
//                                                          -> { samples: MetricSample[] }
// ----------------------------------------------------------------------------
import type {
  MachineKind,
  MachineMetricsSeriesResponse,
  MachinesResponse,
  MachineState,
  MachineView,
  MetricSample,
} from "@opengeni/sdk";

export type {
  MachineKind,
  MachineMetricsSeriesResponse,
  MachinesResponse,
  MachineState,
  MachineView,
  MetricSample,
};

// --- connection-status grouping (a PURE UI projection — not a contract type) --

/**
 * The three connection-status pill values the UI surfaces across the dashboard,
 * the dock, and the timeline. `consent_required` / `display_unavailable` /
 * `enrolling` are NOT connection states — they map onto a connection state for
 * the pill and carry their own badge separately.
 */
export type ConnectionStatus = "online" | "reconnecting" | "offline";

/** Project a machine `state` onto its connection-status pill value. */
export function connectionStatusForState(state: MachineState): ConnectionStatus {
  switch (state) {
    case "online":
    case "consent_required":
    case "display_unavailable":
      // The control plane is reachable; the limitation is consent / no display.
      return "online";
    case "reconnecting":
    case "enrolling":
      return "reconnecting";
    case "offline":
      return "offline";
    default: {
      // Exhaustiveness guard — a new state must be classified explicitly.
      const _never: never = state;
      return _never;
    }
  }
}
