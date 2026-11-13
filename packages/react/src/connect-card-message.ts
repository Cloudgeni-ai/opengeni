import type { AdminStepUpRequest } from "./admin-step-up";

/**
 * A failure a connect card explains in its own words. Cards show its message;
 * any other failure (an API response, a network error, a library error) gets
 * the card's plain fallback line, so server or transport text never reaches
 * the person.
 */
export class ConnectCardMessage extends Error {
  override name = "ConnectCardMessage";
  /** The step was refused until the person confirms it's them with a passkey. */
  readonly stepUp: AdminStepUpRequest | undefined;

  constructor(message: string, options: { stepUp?: AdminStepUpRequest } = {}) {
    super(message);
    this.stepUp = options.stepUp;
  }
}
