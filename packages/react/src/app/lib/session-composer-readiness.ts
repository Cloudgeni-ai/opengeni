import { useLayoutEffect, useMemo } from "react";
import type { ComposerState } from "../../hooks/use-composer";

export type SessionComposerReadiness = {
  /** Whether the composer's model choice can run, worked out in this render. */
  policyValid: boolean;
  /** The same answer as last committed; Send's guard reads it while the composer renders. */
  committedPolicyValid: boolean;
  commitPolicyValid: (valid: boolean) => void;
  /** Something else Send waits on is still loading (tools, accounts, the model list). */
  loading: boolean;
};

/**
 * The session composer as the page hands it out. Whether its model choice can
 * run depends on the composer's own policy, so the page works it out after
 * the composer renders, while the composer's Send guard needs it during that
 * render. The guard reads the committed answer (state, set before paint);
 * Send reports `preparing` while the two differ or anything it waits on is
 * loading, so a Send pressed early waits for the composer instead of being
 * dropped in between.
 */
export function useSessionComposerDelivery<T extends ComposerState>(
  composer: T,
  { policyValid, committedPolicyValid, commitPolicyValid, loading }: SessionComposerReadiness,
): T {
  useLayoutEffect(() => {
    commitPolicyValid(policyValid);
  }, [commitPolicyValid, policyValid]);
  const preparing = composer.preparing === true || loading || policyValid !== committedPolicyValid;
  return useMemo(
    () => ((composer.preparing === true) === preparing ? composer : { ...composer, preparing }),
    [composer, preparing],
  );
}
