export type CreatedSessionRouteAuthority = Readonly<{
  sessionId: string;
}>;

type CreatedSessionRouteAttempt = CreatedSessionRouteAuthority & {
  /**
   * Reconcile the draft consumed by this create. A conflict is recoverable and
   * must not discard the durable authority of the already-created session.
   */
  settleDraft: () => Promise<boolean>;
};

export type RunNewSessionRouteSubmissionOptions = {
  authority: CreatedSessionRouteAuthority | null;
  create: () => Promise<CreatedSessionRouteAttempt | null>;
  navigate: (sessionId: string) => Promise<void>;
  onAuthorityChange: (authority: CreatedSessionRouteAuthority | null) => void;
};

/**
 * Owns the post-create boundary for the sessions-index route.
 *
 * Session creation is the authoritative commit. Once it succeeds, retain its
 * exact ID until navigation succeeds. Draft preservation may legitimately stop
 * on an OCC conflict, but a later retry must only navigate to that same session
 * rather than issuing another create with a fresh idempotency key.
 */
export async function runNewSessionRouteSubmission(
  options: RunNewSessionRouteSubmissionOptions,
): Promise<boolean> {
  let authority = options.authority;
  if (!authority) {
    const created = await options.create();
    if (!created) return false;
    authority = { sessionId: created.sessionId };
    options.onAuthorityChange(authority);
    if (!(await created.settleDraft())) return false;
  }

  await options.navigate(authority.sessionId);
  options.onAuthorityChange(null);
  return true;
}
