/** Cleanup failed before an owned helper or environment could be returned. */
export class UnsettledCleanupError extends AggregateError {
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message);
    this.name = "UnsettledCleanupError";
  }
}
