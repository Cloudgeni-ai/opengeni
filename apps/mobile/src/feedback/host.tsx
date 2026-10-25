/**
 * Signed-in only. Keeps the outbox bound to the account's client and sends
 * waiting reports on start, on return to the app and once a minute while any
 * wait; tracks the screen in view; and listens for a shake.
 */
import { Accelerometer } from "expo-sensors";
import { usePathname } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useAccount } from "@/account";
import { feedbackDraftStore, startFeedback } from "./draft";
import { bindFeedbackSender, feedbackOutbox, useFeedbackPending } from "./outbox";
import { useShakeToSendFeedback } from "./preference";
import { recordUncaughtErrors, setFeedbackScreen } from "./recent-errors";
import { createShakeDetector } from "./shake";

const SHAKE_SAMPLE_MS = 100;
/** A server hiccup the app never sees as offline must not strand a report until next launch. */
const PENDING_RETRY_MS = 60_000;

recordUncaughtErrors();

export function FeedbackHost() {
  const { account, client, workspaceId } = useAccount();
  const accountId = account?.signedOut ? null : (account?.id ?? null);
  const pathname = usePathname();
  const shakeEnabled = useShakeToSendFeedback();
  const pending = useFeedbackPending(accountId);

  useEffect(() => {
    setFeedbackScreen(pathname);
  }, [pathname]);

  useEffect(() => {
    bindFeedbackSender(accountId ? { accountId, client } : null);
    if (!accountId) return;
    const flush = () => {
      void feedbackOutbox.flush(accountId).catch(() => undefined);
    };
    flush();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") flush();
    });
    return () => {
      subscription.remove();
      bindFeedbackSender(null);
    };
  }, [accountId, client]);

  const hasPending = pending > 0;
  useEffect(() => {
    if (!accountId || !hasPending) return;
    const timer = setInterval(() => {
      if (AppState.currentState === "active")
        void feedbackOutbox.flush(accountId).catch(() => undefined);
    }, PENDING_RETRY_MS);
    return () => clearInterval(timer);
  }, [accountId, hasPending]);

  const canReport = Boolean(accountId && workspaceId);
  useEffect(() => {
    if (!shakeEnabled || !canReport) return;
    let subscription: { remove(): void } | null = null;
    let cancelled = false;
    const detect = createShakeDetector(() => {
      if (AppState.currentState !== "active" || feedbackDraftStore.busy()) return;
      void startFeedback("shake");
    });
    void Accelerometer.isAvailableAsync()
      .then((available) => {
        if (!available || cancelled) return;
        Accelerometer.setUpdateInterval(SHAKE_SAMPLE_MS);
        subscription = Accelerometer.addListener((sample) => detect(sample, Date.now()));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [shakeEnabled, canReport]);

  return null;
}
