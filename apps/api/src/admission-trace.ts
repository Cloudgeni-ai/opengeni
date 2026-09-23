import type { Observability } from "@opengeni/observability";

/** Only committed, non-replayed server event identities mint admission anchors. */
export function recordAcceptedApiAdmission(
  observability: Observability | undefined,
  result: { accepted: { id: string }; replay: boolean },
): void {
  if (result.replay) return;
  try {
    observability?.recordAdmissionTrace(result.accepted.id);
  } catch {
    // Telemetry must never turn a committed admission into an HTTP failure.
  }
}
