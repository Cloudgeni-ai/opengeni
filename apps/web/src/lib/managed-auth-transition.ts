export type ManagedSignOutResult<Session> =
  | { status: "signed_out"; session: null }
  | { status: "reconciled_failure"; session: Session | null; error: unknown };

/**
 * A failed sign-out response is ambiguous: the cookie mutation may still have
 * committed. Resolve that ambiguity from the authoritative session endpoint
 * before allowing an authenticated UI to render again.
 */
export async function signOutWithAuthoritativeReconciliation<Session>(input: {
  signOut: () => Promise<unknown>;
  readSession: () => Promise<Session | null>;
}): Promise<ManagedSignOutResult<Session>> {
  try {
    await input.signOut();
    return { status: "signed_out", session: null };
  } catch (error) {
    const session = await input.readSession();
    return { status: "reconciled_failure", session, error };
  }
}
