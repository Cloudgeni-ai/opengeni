// Raw API errors carry status codes, request ids and server wording. Only
// sentences written for the person reach the screen; the rest get a fallback.

/** An error whose message is already meant for the person. */
export class PlainError extends Error {}

export function plainMessage(error: unknown, fallback: string): string {
  return error instanceof PlainError ? error.message : fallback;
}
