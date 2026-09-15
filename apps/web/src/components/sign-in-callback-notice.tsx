import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  clearSignInChangeFeedback,
  readSignInCallbackError,
  readSignInChangeFeedback,
  signInFeedbackEvent,
} from "@/lib/sign-in-feedback";

/** Retain login feedback through the landing-workspace redirect, but never integration callbacks. */
export function SignInCallbackNotice({ userId }: { userId: string | null }) {
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
  const [receipt, setReceipt] = useState(readSignInChangeFeedback);
  useEffect(() => {
    const update = () => setReceipt(readSignInChangeFeedback());
    window.addEventListener(signInFeedbackEvent, update);
    return () => window.removeEventListener(signInFeedbackEvent, update);
  }, []);
  const ownReceipt = receipt && (userId === null || receipt.userId === userId) ? receipt : null;
  if (!message && !ownReceipt && !returned) return null;
  return (
    <div role="alert" className="mx-auto w-full max-w-3xl px-4 pt-3">
      <Notice
        tone={message ? "failed" : "info"}
        title={message ? "Sign-in needs attention" : "Review your sign-in methods"}
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
        {message ?? ownReceipt?.message ?? (
          <>
            The provider returned to OpenGeni. Sign in with an existing method if asked, then review
            your current connections in{" "}
            <a className="underline underline-offset-2" href="/settings/security">
              Personal settings → Security
            </a>
            .
          </>
        )}
      </Notice>
    </div>
  );
}
