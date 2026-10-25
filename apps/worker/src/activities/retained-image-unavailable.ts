/**
 * An image the conversation already sent (a user attachment or a retained tool
 * screenshot) could not be read from object storage right now, for example
 * while a storage replica catches up after an outage. The turn waits and
 * retries with connectivity backoff. It is a storage condition, never a model
 * provider one. Integrity mismatches and data that is gone are not this error:
 * retrying cannot bring those bytes back.
 */
export class RetainedAttachmentUnavailableError extends Error {
  readonly fileIds: readonly string[];

  constructor(fileIds: readonly string[], options?: { cause?: unknown }) {
    super(
      "An image from earlier in this conversation can't be read from storage right now.",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "RetainedAttachmentUnavailableError";
    this.fileIds = [...fileIds];
  }
}
