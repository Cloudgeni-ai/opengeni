import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import type { ComposerState } from "../../hooks/use-composer";
import { getComposerSendBlocker, type ComposerSendBlocker } from "./composer-send-blocking";

/** What else an open chat's Send waits on, apart from its model choice. */
export type SessionSendState = {
  uploadPending: boolean;
  repositoryError: string | null;
  personalDecision: boolean;
  machineAccessDenied: boolean;
  /** Something Send needs is still loading (the chat's tools, attachments, accounts). */
  loading: boolean;
  /** One of them failed to load; it shows its own message. */
  loadFailed: boolean;
};

export type SessionSendGate = {
  /** Whether the composer's model choice can run, as last committed. */
  committedPolicyValid: boolean;
  commitPolicyValid: (valid: boolean) => void;
  /** Send's blocker, read while the composer renders and when Send is pressed. */
  blocker: (state: SessionSendState) => ComposerSendBlocker | null;
};

/**
 * The session page's Send guard. Whether the model choice can run depends on
 * the composer's own policy, so the page works it out after the composer
 * renders, while the guard needs it during that render: the guard reads the
 * committed answer (state, updated by useSessionComposerDelivery before paint).
 */
export function useSessionSendGate(): SessionSendGate {
  const [committedPolicyValid, commitPolicyValid] = useState(false);
  const blocker = useCallback(
    (state: SessionSendState) =>
      getComposerSendBlocker({
        uploadPending: state.uploadPending,
        repositoryError: state.repositoryError,
        policyValid: committedPolicyValid,
        personalDecision: state.personalDecision,
        machineAccessDenied: state.machineAccessDenied,
        personalLoading: state.loading || state.loadFailed,
      }),
    [committedPolicyValid],
  );
  return { committedPolicyValid, commitPolicyValid, blocker };
}

/**
 * The session composer as the page hands it out. Send reports `preparing`
 * while the committed model check lags the current one, while the model list
 * is still loading without a runnable choice, while an unavailable model is
 * being replaced, and while anything else Send needs is loading. A Send
 * pressed early then waits for the composer instead of being dropped in
 * between; a failure ends the wait and shows its own message.
 */
export function useSessionComposerDelivery<T extends ComposerState>(
  composer: T,
  gate: SessionSendGate,
  {
    policyValid,
    catalogLoading,
    replacingModel,
    send,
  }: {
    /** Whether the composer's model choice can run, worked out in this render. */
    policyValid: boolean;
    catalogLoading: boolean;
    replacingModel: boolean;
    send: SessionSendState;
  },
): T {
  const { commitPolicyValid, committedPolicyValid } = gate;
  useLayoutEffect(() => {
    commitPolicyValid(policyValid);
  }, [commitPolicyValid, policyValid]);
  const preparing =
    composer.preparing === true ||
    policyValid !== committedPolicyValid ||
    (catalogLoading && !policyValid) ||
    replacingModel ||
    send.loading;
  return useMemo(
    () => ((composer.preparing === true) === preparing ? composer : { ...composer, preparing }),
    [composer, preparing],
  );
}
