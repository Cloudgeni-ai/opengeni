/** A reconnect lost its exact account, generation, or accepted ownership fence. */
export class SubscriptionAccountChangedError extends Error {
  constructor() {
    super("Subscription account changed. Reload before reconnecting.");
    this.name = "SubscriptionAccountChangedError";
  }
}
