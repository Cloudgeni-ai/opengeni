/** Preserve previews only for transient failures, never an authoritative denial. */
export function retainArtifactsAfterRefreshFailure(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = error.status;
    return typeof status === "number" && (status === 408 || status === 429 || status >= 500);
  }
  return error instanceof TypeError; // Fetch transport failure.
}
