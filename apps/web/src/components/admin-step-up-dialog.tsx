import { useNavigate } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PASSKEY_STEP_UP_HANDOFF_PATH } from "@opengeni/contracts/managed-sign-in-methods";
import { Button } from "@opengeni/react/ui/button";
import { Field, TextInput } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";

import {
  AuthApiError,
  claimPasskeyStepUpHandoff,
  confirmAdminWithPasskey,
  startPasskeyStepUpHandoff,
  type PasskeyStepUpHandoff,
} from "@/api";
import { setAdminStepUpHandler, type AdminStepUpRequest } from "@/lib/admin-step-up";
import {
  openInBrowser,
  passkeyPromptDismissed,
  passkeyPromptUnavailable,
  passkeysNeedBrowser,
} from "@/lib/passkeys";

type Prompt = AdminStepUpRequest & { resolve: (confirmed: boolean) => void };

/** What a failed confirmation tells the person, in a sentence. */
export function adminStepUpErrorMessage(error: unknown): string {
  if (passkeyPromptDismissed(error)) return "No passkey was used. Try again when you're ready.";
  if (passkeyPromptUnavailable(error)) {
    return "Your browser didn't show a passkey prompt. Try again, or open Opengeni in another browser.";
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "The server didn't answer. Check your connection and try again.";
  }
  if (
    error instanceof AuthApiError &&
    (error.code === "PASSKEY_RATE_LIMITED" ||
      error.code === "PASSKEY_HANDOFF_WRONG_CODE" ||
      error.code === "PASSKEY_HANDOFF_NOT_CONFIRMED" ||
      error.code === "PASSKEY_HANDOFF_EXPIRED" ||
      error.code === "PASSKEY_HANDOFF_OTHER_SESSION")
  ) {
    return error.message;
  }
  if (error instanceof AuthApiError && error.code === "PASSKEY_NONE_REGISTERED") {
    return "Add a passkey to your account first.";
  }
  if (error instanceof AuthApiError && error.code === "PASSKEY_STEP_UP_SIGNED_OUT") {
    return "You were signed out. Sign in again, then try again.";
  }
  return "That passkey couldn't confirm it's you. Try again, or use another passkey.";
}

/** The browser page that confirms this handoff, on this same server. */
export function passkeyHandoffUrl(handoffId: string, origin = window.location.origin): string {
  const url = new URL(PASSKEY_STEP_UP_HANDOFF_PATH, origin);
  url.searchParams.set("handoff", handoffId);
  return url.toString();
}

/** `123456` as `123 456`, easier to compare at a glance. */
export function formatHandoffCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** How the dialog hands a step-up to the person's browser (replaceable in tests). */
export type StepUpHandoffApi = {
  start: () => Promise<PasskeyStepUpHandoff>;
  claim: (handoffId: string, code: string) => Promise<void>;
  open: (url: string) => void;
};

const browserHandoff: StepUpHandoffApi = {
  start: startPasskeyStepUpHandoff,
  claim: claimPasskeyStepUpHandoff,
  open: openInBrowser,
};

/** A handoff the dialog can't continue with: start again. */
function handoffEnded(error: unknown): boolean {
  return (
    error instanceof AuthApiError &&
    (error.code === "PASSKEY_HANDOFF_EXPIRED" ||
      error.code === "PASSKEY_HANDOFF_OTHER_SESSION" ||
      error.code === "PASSKEY_STEP_UP_SIGNED_OUT")
  );
}

/**
 * The console's one admin step-up prompt. Admin changes the API refuses until
 * the person confirms with a passkey open it, and are sent again once they do.
 * Someone without a passkey is sent to add one.
 *
 * Inside the desktop app, passkey prompts can't open (see
 * `passkeysNeedBrowser`), so the confirmation is handed to the person's own
 * browser on this same server. After their passkey there, the browser shows a
 * one-time code, which they type in here to confirm this session.
 */
export function AdminStepUpDialog({
  confirm = confirmAdminWithPasskey,
  inBrowser = passkeysNeedBrowser(),
  handoff = browserHandoff,
}: {
  confirm?: () => Promise<void>;
  inBrowser?: boolean;
  handoff?: StepUpHandoffApi;
}) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<PasskeyStepUpHandoff | null>(null);
  const [code, setCode] = useState("");
  const confirmed = useRef(false);
  const navigate = useNavigate();

  useEffect(
    () =>
      setAdminStepUpHandler(
        (request) =>
          new Promise<boolean>((resolve) => {
            confirmed.current = false;
            setError(null);
            setWaiting(null);
            setCode("");
            setPrompt({ ...request, resolve });
          }),
      ),
    [],
  );

  const close = (result: boolean) => {
    prompt?.resolve(result);
    setPrompt(null);
    setWaiting(null);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // A handoff lasts a few minutes; past that, start again. Counted from when
  // the server answered, so a wrong clock on this computer doesn't matter.
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setWaiting(null);
      setCode("");
      setError("The confirmation in your browser expired. Try again.");
    }, waiting.expiresInSeconds * 1000);
    return () => clearTimeout(timer);
  }, [waiting]);

  if (!prompt) return null;
  if (!prompt.passkeyRegistered) {
    return (
      <FormDialog
        open
        aboveOtherDialogs
        onOpenChange={(open) => !open && close(false)}
        size="sm"
        leading={<KeyRoundIcon aria-hidden />}
        title="Add a passkey"
        description={
          inBrowser
            ? "Changing who has access needs a passkey. Add one in your browser, then try again here."
            : "Changing who has access needs a passkey. Add one to your account, then try again."
        }
        submitLabel={inBrowser ? "Add in browser" : "Add passkey"}
        onSubmit={() => {
          close(false);
          if (inBrowser) {
            handoff.open(new URL("/settings/security", window.location.origin).toString());
          } else {
            void navigate({ to: "/settings/security" });
          }
        }}
      />
    );
  }
  if (inBrowser && waiting) {
    const complete = /^\d{6}$/u.test(code);
    return (
      <FormDialog
        open
        aboveOtherDialogs
        onOpenChange={(open) => !open && close(confirmed.current)}
        size="sm"
        leading={<KeyRoundIcon aria-hidden />}
        title="Confirm in your browser"
        description="Use your passkey in the browser window that opened. Then enter the code it shows."
        submitLabel="Confirm"
        pendingLabel="Confirming…"
        submitDisabled={!complete}
        error={error}
        footerStart={
          <Button
            type="button"
            variant="ghost"
            onClick={() => handoff.open(passkeyHandoffUrl(waiting.handoffId))}
          >
            Open browser again
          </Button>
        }
        onSubmit={async () => {
          setError(null);
          try {
            await handoff.claim(waiting.handoffId, code);
          } catch (caught) {
            setError(adminStepUpErrorMessage(caught));
            if (handoffEnded(caught)) {
              setWaiting(null);
              setCode("");
            }
            return false;
          }
          confirmed.current = true;
          close(true);
        }}
      >
        <Field label="Code from your browser">
          <TextInput
            mono
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            className="tabular-nums"
          />
        </Field>
      </FormDialog>
    );
  }
  if (inBrowser) {
    return (
      <FormDialog
        open
        aboveOtherDialogs
        onOpenChange={(open) => !open && close(false)}
        size="sm"
        leading={<KeyRoundIcon aria-hidden />}
        title="Confirm it's you"
        description="Use your passkey to change who has access. Passkeys open in your browser, which then shows a code to enter here."
        submitLabel="Continue in browser"
        pendingLabel="Opening your browser…"
        error={error}
        onSubmit={async () => {
          setError(null);
          try {
            const started = await handoff.start();
            handoff.open(passkeyHandoffUrl(started.handoffId));
            setCode("");
            setWaiting(started);
          } catch (caught) {
            setError(adminStepUpErrorMessage(caught));
          }
          return false;
        }}
      />
    );
  }
  return (
    <FormDialog
      open
      aboveOtherDialogs
      onOpenChange={(open) => !open && close(confirmed.current)}
      size="sm"
      leading={<KeyRoundIcon aria-hidden />}
      title="Confirm it's you"
      description="Use your passkey to change who has access. You won't be asked again until you sign out."
      submitLabel="Use passkey"
      pendingLabel="Waiting for your passkey…"
      error={error}
      onSubmit={async () => {
        setError(null);
        try {
          await confirm();
        } catch (caught) {
          setError(adminStepUpErrorMessage(caught));
          return false;
        }
        confirmed.current = true;
        close(true);
      }}
    />
  );
}
