export type CreatedSessionRouteAuthority = Readonly<{
  sessionId: string;
  /** Null once draft settlement is durable; navigation may still need retrying. */
  settleDraft: (() => Promise<boolean>) | null;
}>;

type CreatedSessionRouteAttempt = Readonly<{
  sessionId: string;
  /**
   * Reconcile the draft consumed by this create. A conflict is recoverable and
   * must not discard the durable authority of the already-created session.
   */
  settleDraft: () => Promise<boolean>;
}>;

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
 * exact ID until navigation succeeds. Draft settlement remains attached to that
 * authority until it is durable; a later retry must settle, then navigate to the
 * same session rather than issuing another create with a fresh idempotency key.
 */
export async function runNewSessionRouteSubmission(
  options: RunNewSessionRouteSubmissionOptions,
): Promise<boolean> {
  let authority = options.authority;
  if (!authority) {
    const created = await options.create();
    if (!created) return false;
    authority = created;
    options.onAuthorityChange(authority);
  }

  if (authority.settleDraft) {
    if (!(await authority.settleDraft())) return false;
    authority = { sessionId: authority.sessionId, settleDraft: null };
    options.onAuthorityChange(authority);
  }

  await options.navigate(authority.sessionId);
  options.onAuthorityChange(null);
  return true;
}
