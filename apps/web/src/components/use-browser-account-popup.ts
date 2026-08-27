import { useBrowserAccounts } from "@opengeni/react/accounts";
import type { ManagedAuthLoginTransaction } from "@opengeni/sdk/accounts";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

import {
  accountAuthPopupFeatures,
  accountAuthPopupMessage,
  accountAuthPopupPath,
  postAccountAuthPopupAcknowledgement,
} from "@/lib/browser-account-popup";

type PendingPopup = {
  popup: Window;
  transactionId: string;
};

export type BrowserAccountPopupController = {
  open: (
    begin: () => Promise<ManagedAuthLoginTransaction>,
    options?: {
      onError?: (error: unknown) => void;
      onSettled?: () => void;
    },
  ) => void;
};

/**
 * Opens the isolated credential window synchronously (preserving browser user
 * activation), then treats its postMessage as a hint to reread server
 * authority. The popup never sends credentials, provider tokens, or a client
 * projection to the opener.
 */
export function useBrowserAccountPopup(): BrowserAccountPopupController {
  const accounts = useBrowserAccounts();
  const pendingRef = useRef<PendingPopup | null>(null);
  const startingPopupRef = useRef<Window | null>(null);
  const settledCallbackRef = useRef<(() => void) | null>(null);
  const lifecycleRef = useRef(0);

  const clearPending = useCallback(() => {
    pendingRef.current = null;
    settledCallbackRef.current = null;
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const pending = pendingRef.current;
      if (!pending) return;
      const message = accountAuthPopupMessage(event, {
        origin: window.location.origin,
        popup: pending.popup,
        transactionId: pending.transactionId,
      });
      if (!message) return;
      postAccountAuthPopupAcknowledgement(
        pending.popup,
        window.location.origin,
        message.transactionId,
      );
      const onSettled = settledCallbackRef.current;
      clearPending();
      const settle =
        message.type === "opengeni-account-auth-complete"
          ? accounts.settleExternalLoginTransaction(message.transactionId)
          : accounts.cancelLoginTransaction().then(() => false);
      void settle
        .then(() => onSettled?.())
        .catch((error) =>
          toast.error("Account authentication did not settle", {
            description: String(error),
          }),
        );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [accounts, clearPending]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const pending = pendingRef.current;
      if (!pending?.popup.closed) return;
      // A successful popup posts before closing. Delay the close-only fallback
      // one event-loop turn so that queued message wins over cancellation.
      window.setTimeout(() => {
        if (pendingRef.current !== pending) return;
        const onSettled = settledCallbackRef.current;
        clearPending();
        void accounts
          .cancelLoginTransaction()
          .then(() => onSettled?.())
          .catch((error) =>
            toast.error("Couldn't cancel account authentication", {
              description: String(error),
            }),
          );
      }, 0);
    }, 250);
    return () => window.clearInterval(timer);
  }, [accounts, clearPending]);

  useEffect(
    () => () => {
      lifecycleRef.current += 1;
      startingPopupRef.current?.close();
      pendingRef.current?.popup.close();
      startingPopupRef.current = null;
      clearPending();
    },
    [clearPending],
  );

  const open = useCallback<BrowserAccountPopupController["open"]>((begin, options) => {
    const existing = pendingRef.current;
    if (existing && !existing.popup.closed) {
      existing.popup.focus();
      return;
    }
    const starting = startingPopupRef.current;
    if (starting && !starting.closed) {
      starting.focus();
      return;
    }
    const popup = window.open(
      "about:blank",
      "opengeni-account-auth",
      accountAuthPopupFeatures(window),
    );
    if (!popup) {
      const error = new Error("The account authentication popup was blocked");
      options?.onError?.(error);
      if (!options?.onError) {
        toast.error("The account window was blocked", {
          description: "Allow popups for this site, then try again.",
        });
      }
      return;
    }
    const lifecycle = lifecycleRef.current;
    startingPopupRef.current = popup;
    settledCallbackRef.current = options?.onSettled ?? null;
    void begin()
      .then((transaction) => {
        if (lifecycleRef.current !== lifecycle || startingPopupRef.current !== popup) {
          popup.close();
          return;
        }
        startingPopupRef.current = null;
        pendingRef.current = { popup, transactionId: transaction.id };
        popup.location.replace(accountAuthPopupPath(transaction.id));
      })
      .catch((error) => {
        if (startingPopupRef.current === popup) startingPopupRef.current = null;
        popup.close();
        options?.onError?.(error);
        if (!options?.onError) {
          toast.error("Couldn't start account authentication", {
            description: String(error),
          });
        }
        options?.onSettled?.();
        if (settledCallbackRef.current === options?.onSettled) {
          settledCallbackRef.current = null;
        }
      });
  }, []);

  return { open };
}
