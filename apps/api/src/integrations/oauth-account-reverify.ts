import type { ConnectionMetadata } from "@opengeni/contracts";
import {
  decideOAuthAccountConnection,
  identityConfirmsAccount,
  unverifiedLoginsBlockingNewAccount,
} from "./oauth-account-identity";

/** At most this many earlier logins are checked again for one sign-in. */
export const MAX_REVERIFIED_LOGINS = 3;

export type ReverifyLoginsInput = {
  /** The decision input the connection will be decided with. */
  decision: Parameters<typeof decideOAuthAccountConnection>[0];
  /** Reads a stored login's account with its own credentials; undefined when it can't. */
  verify: (login: ConnectionMetadata) => Promise<Record<string, string> | undefined>;
  /** Records the confirmed account on the login; false when the login changed meanwhile. */
  save: (login: ConnectionMetadata, identity: Record<string, string>) => Promise<boolean>;
  onFailure?: (login: ConnectionMetadata, error: unknown) => void;
};

/**
 * Before a new, verified account is refused because an earlier login of the
 * same service was never confirmed (account_reconnect_required), check those
 * logins again with their own stored credentials and record the accounts they
 * belong to. The connection is then decided again from the stored rows, so a
 * login confirmed here is told apart from the new account, and one that can't
 * be confirmed keeps today's refusal. Never throws; returns how many logins
 * were confirmed.
 */
export async function reverifyLoginsBlockingNewAccount(
  input: ReverifyLoginsInput,
): Promise<number> {
  const blocking = unverifiedLoginsBlockingNewAccount(input.decision);
  if (!blocking.length || blocking.length > MAX_REVERIFIED_LOGINS) return 0;
  const results = await Promise.all(
    blocking.map(async (login) => {
      try {
        const identity = await input.verify(login);
        if (!identity || !identityConfirmsAccount(identity, input.decision.identityKeys))
          return false;
        return await input.save(login, identity);
      } catch (error) {
        input.onFailure?.(login, error);
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}
