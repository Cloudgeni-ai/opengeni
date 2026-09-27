import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  clearSignInChangeFeedback,
  isVerificationLinkCallbackError,
  readSignInCallbackError,
  readSignInChangeFeedback,
  signInFeedbackEvent,
} from "@/lib/sign-in-feedback";

/** Retain login feedback through the landing-workspace redirect, but never integration callbacks. */
export function SignInCallbackNotice({
  userId,
  verificationLinkError = "notice",
}: {
  userId: string | null;
  /**
   * Who reports an expired or invalid email-verification link: this notice, no
   * one yet (the session is still loading), or the signed-out auth panel, whose
   * resend form replaces this notice for good.
   */
  verificationLinkError?: "notice" | "pending" | "auth-panel";
}) {
  const [message, setMessage] = useState(() =>
    window.location.pathname === "/" || window.location.pathname === "/settings/security"
      ? (readSignInCallbackError(window.location.search) ??
        (new URLSearchParams(window.location.search).get("signInMethod") === "error"
          ? "The sign-in connection didn't complete. Sign in with an existing method, then retry from Personal settings → Security."
          : null))
      : null,
  );
  const [returned, setReturned] = useState(
    () =>
      window.location.pathname === "/" &&
      new URLSearchParams(window.location.search).get("signInMethod") === "connected",
  );
  const linkError = isVerificationLinkCallbackError(message);
  useEffect(() => {
    if (linkError && verificationLinkError === "auth-panel") setMessage(null);
  }, [linkError, verificationLinkError]);
  const shownMessage = linkError && verificationLinkError !== "notice" ? null : message;
  const [receipt, setReceipt] = useState(readSignInChangeFeedback);
  useEffect(() => {
    const update = () => setReceipt(readSignInChangeFeedback());
    window.addEventListener(signInFeedbackEvent, update);
    return () => window.removeEventListener(signInFeedbackEvent, update);
  }, []);
  const ownReceipt = receipt && (userId === null || receipt.userId === userId) ? receipt : null;
  if (!shownMessage && !ownReceipt && !returned) return null;
  return (
    <div role="alert" className="mx-auto w-full max-w-3xl px-4 pt-3">
      <Notice
        tone={shownMessage ? "failed" : "info"}
        title={shownMessage ? "Sign-in needs attention" : "Review your sign-in methods"}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMessage(null);
              setReturned(false);
              clearSignInChangeFeedback();
            }}
          >
            Dismiss
          </Button>
        }
      >
        {shownMessage ?? ownReceipt?.message ?? (
          <>
            The provider returned to OpenGeni. Sign in with an existing method if asked, then review
            your current connections in{" "}
            <a className="underline underline-offset-2" href="/settings/security">
              Personal settings → Security
            </a>
            .
          </>
        )}
        {ownReceipt && userId === null ? (
          <p className="mt-1">
            Sign in again as {ownReceipt.email} with a remaining sign-in method to continue.
          </p>
        ) : null}
      </Notice>
    </div>
  );
}
