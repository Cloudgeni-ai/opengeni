/**
 * `details.code` on a 422 `validation_failed` envelope when the requested or
 * stored model is not in the live model catalog (retired, removed, or never
 * offered). Retrying the same request cannot succeed; the client must choose
 * another model. Additive to the public error envelope: `code` stays
 * `validation_failed` and the message keeps its historical text.
 */
export const MODEL_UNAVAILABLE_ERROR_CODE = "model_unavailable" as const;

/** Typed cause for a model that is not selectable in the live catalog. */
export class ModelUnavailableError extends Error {
  readonly code = MODEL_UNAVAILABLE_ERROR_CODE;

  constructor(readonly modelId: string) {
    super(`model is not available: ${modelId}`);
    this.name = "ModelUnavailableError";
  }
}

export function isModelUnavailableError(error: unknown): error is ModelUnavailableError {
  return error instanceof ModelUnavailableError;
}
