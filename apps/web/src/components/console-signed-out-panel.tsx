import { ArrowRightIcon, Loader2Icon, UserIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@opengeni/react/ui/button";
import { Notice } from "@opengeni/react/ui/notice";
import {
  consoleSignInOutcome,
  consoleSignedOutStep,
  type ConsoleSignedOutStep,
} from "@/lib/console-sign-in";

/**
 * Console's signed-out page on its own host. Console signs in with the
 * person's Opengeni account on the app host: right away when nothing says
 * otherwise, or with Continue after Sign out or a handoff that didn't finish,
 * so signing out never signs straight back in. Console's own email and Google
 * sign-in stay available below.
 */
export function ConsoleSignedOutPanel(props: {
  search: string;
  signedOut: boolean;
  lastAutoStartedAt: number | null;
  /** Starts the handoff: leaves this page for the app host. */
  onContinue: () => void;
  /** Console's own sign-in (email and Google). */
  fallback: ReactNode;
  /** Pins the first step, for previews. */
  initialStep?: ConsoleSignedOutStep;
}) {
  const [step, setStep] = useState<ConsoleSignedOutStep | "leaving">(
    () =>
      props.initialStep ??
      consoleSignedOutStep({
        search: props.search,
        signedOut: props.signedOut,
        lastAutoStartedAt: props.lastAutoStartedAt,
        now: Date.now(),
      }),
  );
  const failed = consoleSignInOutcome(props.search) === "failed";
  const unavailable = consoleSignInOutcome(props.search) === "unavailable";
  const { onContinue } = props;
  const started = useRef(false);

  useEffect(() => {
    if (step !== "continue" || started.current) return;
    started.current = true;
    setStep("leaving");
    onContinue();
  }, [step, onContinue]);

  if (step === "fallback") {
    return (
      <div className="w-full">
        {props.fallback}
        {unavailable ? null : (
          <Button
            type="button"
            variant="ghost"
            className="mt-3 w-full"
            onClick={() => setStep("continue")}
          >
            Continue with your Opengeni account
          </Button>
        )}
      </div>
    );
  }

  const leaving = step === "continue" || step === "leaving";
  return (
    <section className="w-full" aria-busy={leaving}>
      <div className="mb-4 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
          <UserIcon className="size-4" />
        </span>
        <div>
          <h2 className="text-base font-semibold">Sign in to Console</h2>
          <p className="text-sm text-fg-subtle">
            {leaving
              ? "Signing in with your Opengeni account…"
              : "Continue with your Opengeni account."}
          </p>
        </div>
      </div>
      {failed && !leaving ? (
        <Notice tone="failed" live="polite" className="mb-4">
          That sign-in didn't finish. Continue to try again.
        </Notice>
      ) : null}
      <Button
        type="button"
        className="w-full"
        disabled={leaving}
        onClick={() => setStep("continue")}
      >
        {leaving ? (
          <Loader2Icon className="animate-spin" aria-hidden="true" />
        ) : (
          <ArrowRightIcon aria-hidden="true" />
        )}
        {leaving ? "Continuing…" : "Continue"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="mt-3 w-full"
        disabled={leaving}
        onClick={() => setStep("fallback")}
      >
        Sign in with email or Google
      </Button>
    </section>
  );
}
