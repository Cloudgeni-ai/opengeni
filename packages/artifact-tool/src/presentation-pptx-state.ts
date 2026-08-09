import type { Presentation } from "./presentation";
import type { PresentationLossPreservationEnvelope } from "./presentation-pptx-api";

const lossState = new WeakMap<Presentation, PresentationLossPreservationEnvelope>();

export function presentationLossState(
  presentation: Presentation,
): PresentationLossPreservationEnvelope | undefined {
  return lossState.get(presentation);
}

export function setPresentationLossState(
  presentation: Presentation,
  envelope: PresentationLossPreservationEnvelope | undefined,
): void {
  if (envelope) lossState.set(presentation, envelope);
  else lossState.delete(presentation);
}
