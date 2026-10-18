/** Cleanup failed before an owned helper or environment could be returned. */
export class UnsettledCleanupError extends AggregateError {
  /** The helper process itself is proven gone (it crashed, or had to be
   * killed); only state it held, such as capture streams, may remain. */
  readonly processExited: boolean;

  constructor(
    errors: Iterable<unknown>,
    message: string,
    options: { processExited?: boolean } = {},
  ) {
    super(errors, message);
    this.name = "UnsettledCleanupError";
    this.processExited = options.processExited ?? false;
  }
}
