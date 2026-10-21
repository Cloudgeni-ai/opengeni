import { OpenGeniApiError } from "@opengeni/sdk";

import { ApiError } from "./app-api";

export type RetainedArtifactLoadErrorPresentation = Readonly<{
  title: string;
  description: string;
  retryable: boolean;
  supportReference: string | null;
}>;

const unavailablePresentation = {
  title: "Artifact unavailable",
  description:
    "This file isn't available. It may have been removed, or you may not have access to it.",
} as const;

// Someone else's Only me file. Says only that it is private, never whose it
// is or what it is called, and what to do about it.
export const PRIVATE_FILE_PRESENTATION = {
  title: "This file is private",
  description:
    "Only its owner can open it, usually because it came from their Only me chat. Ask them to share it with the workspace.",
} as const;

const temporaryPresentation = {
  title: "Couldn't load this file",
  description: "The file could not be loaded. Try again in a moment.",
} as const;

const networkPresentation = {
  title: "Couldn't load this file",
  description: "The app could not reach Opengeni. Check your connection and try again.",
} as const;

const NETWORK_FETCH_MESSAGE =
  /^(Failed to fetch|fetch failed|Load failed|NetworkError when attempting to fetch resource\.)$/u;

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/** The API's typed "private" answer: the file exists but is Only me for someone else. */
export function isPrivateFileLoadError(error: unknown): boolean {
  if (errorStatus(error) !== 403 || !error || typeof error !== "object") return false;
  const body = (error as { body?: unknown }).body;
  if (typeof body !== "string" || body.length > 4096) return false;
  try {
    const parsed = JSON.parse(body) as {
      available?: unknown | undefined;
      reason?: unknown | undefined;
    };
    return parsed.available === false && parsed.reason === "private";
  } catch {
    return false;
  }
}

function isNetworkTypeError(error: unknown): boolean {
  return error instanceof TypeError && NETWORK_FETCH_MESSAGE.test(error.message);
}

function isLocalUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === "This artifact is no longer available.";
}

/** Correlation ids only — never parse API prefix text from Error.message. */
function supportReference(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { correlationId?: unknown }).correlationId;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
  if (!/^[\w.:-]+$/u.test(value)) return null;
  return value;
}

function typedRetryable(error: unknown): boolean {
  if (error instanceof OpenGeniApiError) {
    return error.retryable || error.outcomeUnknown;
  }
  if (error instanceof ApiError) {
    return error.retryable || error.outcomeUnknown;
  }
  if (!error || typeof error !== "object") return false;
  const record = error as { retryable?: unknown; outcomeUnknown?: unknown };
  return record.retryable === true || record.outcomeUnknown === true;
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Route-scoped copy for retained-file loads. A missing file and any other
 * refusal stay indistinguishable; only the API's typed private answer says
 * the file exists and is Only me for someone else. Retry is only for typed
 * transient/network/server failures.
 */
export function retainedArtifactLoadErrorPresentation(
  error: unknown,
): RetainedArtifactLoadErrorPresentation {
  const status = errorStatus(error);
  const reference = supportReference(error);
  const unavailable = {
    ...unavailablePresentation,
    retryable: false,
    supportReference: reference,
  };

  if (isLocalUnavailableError(error)) return unavailable;
  if (isPrivateFileLoadError(error))
    return {
      ...PRIVATE_FILE_PRESENTATION,
      retryable: false,
      supportReference: reference,
    };
  if (status === 400 || status === 401 || status === 403 || status === 404) return unavailable;

  if (status === 0 || isNetworkTypeError(error)) {
    return {
      ...networkPresentation,
      retryable: true,
      supportReference: reference,
    };
  }

  if (typedRetryable(error) || (status !== null && retryableHttpStatus(status))) {
    return {
      ...temporaryPresentation,
      retryable: true,
      supportReference: reference,
    };
  }

  return unavailable;
}
