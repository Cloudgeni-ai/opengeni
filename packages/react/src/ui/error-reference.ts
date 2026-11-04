/*
 * The request reference on an error's one-line text. Dependency-free: the
 * toast wrapper loads it on every page.
 *
 * An expected refusal (a 4xx: a permission, a conflict, a check) says what to
 * do and carries no reference. An unexpected failure (a 5xx, or a failure
 * with no status) keeps its reference as a trailing "Reference: <id>." so
 * the surface showing it can offer it discreetly (a toast's "Copy details",
 * Technical details) instead of printing it.
 */

const API_STATUS_PREFIX = /(^|[.!?]\s+)(?:(?:OpenGeni|Opengeni) )?API (\d{3}):\s*/u;
const REFERENCE_TAIL = /\s*Reference:\s*([\w.:-]+?)\.?\s*$/u;

export interface ErrorTextParts {
  /** The text without an "API 409:" prefix or the reference. */
  text: string;
  /** The request reference, for an unexpected failure only. */
  reference: string | undefined;
}

/** True for a 4xx: the request was refused for a reason the person can act on. */
export function isExpectedApiStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500;
}

/** The status in a raw "API 409: ..." message, if it has one. */
export function apiStatusInText(text: string): number | undefined {
  const match = API_STATUS_PREFIX.exec(text);
  return match ? Number(match[2]) : undefined;
}

/**
 * Splits text meant for a person into what to show and the reference to offer
 * discreetly. A raw "API 4xx: ..." message loses its prefix and its reference.
 */
export function splitErrorText(text: string): ErrorTextParts {
  let rest = text;
  let reference: string | undefined;
  const tail = REFERENCE_TAIL.exec(rest);
  if (tail) {
    reference = tail[1];
    rest = rest.slice(0, tail.index);
  }
  const prefix = API_STATUS_PREFIX.exec(rest);
  if (prefix) {
    if (isExpectedApiStatus(Number(prefix[2]))) reference = undefined;
    rest = rest.slice(0, prefix.index) + prefix[1] + rest.slice(prefix.index + prefix[0].length);
  }
  return { text: rest.trim(), reference };
}
