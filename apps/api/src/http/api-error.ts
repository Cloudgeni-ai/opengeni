import type { ErrorCode } from "@opengeni/contracts";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";

type ApiHttpErrorOptions = {
  code: ErrorCode;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

/** A public, structured API failure whose message and details are safe for clients. */
export class ApiHttpError extends HTTPException {
  readonly code: ErrorCode;
  readonly retryable: boolean | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, options: ApiHttpErrorOptions) {
    super(status as ContentfulStatusCode, { message: options.message });
    this.name = "ApiHttpError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.details = options.details;
  }
}
