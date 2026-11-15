import type { AdminStepUpRequest } from "./admin-step-up";

/** A refused step that waits for a passkey, and whether the card offers the host's step-up for it. */
export type CardStepUp = AdminStepUpRequest & { hostAction?: boolean };

/**
 * A failure a connect card explains in its own words. Cards show its message;
 * any other failure (an API response, a network error, a library error) gets
 * the card's plain fallback line, so server or transport text never reaches
 * the person.
 */
export class ConnectCardMessage extends Error {
  override name = "ConnectCardMessage";
  /** The step was refused until the person confirms it's them with a passkey. */
  readonly stepUp: CardStepUp | undefined;

  constructor(message: string, options: { stepUp?: CardStepUp } = {}) {
    super(message);
    this.stepUp = options.stepUp;
  }
}
