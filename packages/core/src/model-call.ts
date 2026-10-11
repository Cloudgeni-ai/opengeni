import type { AccessGrant } from "@opengeni/contracts";
import type { SingleModelCallRequest, SingleModelCallResult } from "@opengeni/runtime";

/**
 * Stateless single model calls: one request to one workspace model with no
 * tools, no agent loop and no session. The public chat completions endpoint
 * is the transport; agentic work uses sessions. The host-owned service picks
 * the model, credential and subscription account exactly as a turn would,
 * admits the call against the same funding rules and settles actual usage.
 */

export type ModelCallCaller = {
  grant: AccessGrant;
  accountId: string;
  workspaceId: string;
  /** The authenticated subject whose model and subscription authority apply. */
  subjectId: string;
};

export type ModelCallInput = ModelCallCaller & {
  /** Product model id or alias; null selects the workspace default model. */
  model: string | null;
  request: Omit<SingleModelCallRequest, "signal">;
  /** Server-generated identity; the settlement idempotency key derives from it. */
  requestId: string;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void | Promise<void>;
};

export type ModelCallOutput = {
  /** Canonical product model id that served the call. */
  model: string;
  result: SingleModelCallResult;
};

export type ModelCallModel = {
  id: string;
  label: string;
  providerLabel: string;
};

export interface ModelCallService {
  /** Models the caller may use for a single call, in catalog order. */
  listModels(caller: ModelCallCaller): Promise<ModelCallModel[]>;
  call(input: ModelCallInput): Promise<ModelCallOutput>;
}

export type ModelCallErrorType =
  | "invalid_request_error"
  | "not_found_error"
  | "insufficient_quota"
  | "rate_limit_error"
  | "api_error"
  | "service_unavailable";

/**
 * A refusal or failure with a public status and an OpenAI-style error type.
 * Messages are safe to return to the caller.
 */
export class ModelCallError extends Error {
  readonly status: number;
  readonly type: ModelCallErrorType;
  readonly code: string | null;
  readonly param: string | null;
  constructor(input: {
    status: number;
    type: ModelCallErrorType;
    message: string;
    code?: string | null;
    param?: string | null;
  }) {
    super(input.message);
    this.name = "ModelCallError";
    this.status = input.status;
    this.type = input.type;
    this.code = input.code ?? null;
    this.param = input.param ?? null;
  }
}
