import { useNavigate } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { FormDialog } from "@opengeni/react/ui/form-dialog";

import { AuthApiError, confirmAdminWithPasskey } from "@/api";
import { setAdminStepUpHandler, type AdminStepUpRequest } from "@/lib/admin-step-up";
import { passkeyPromptDismissed } from "@/lib/passkeys";

type Prompt = AdminStepUpRequest & { resolve: (confirmed: boolean) => void };

/** What a failed confirmation tells the person, in a sentence. */
export function adminStepUpErrorMessage(error: unknown): string {
  if (passkeyPromptDismissed(error)) return "No passkey was used. Try again when you're ready.";
  if (error instanceof AuthApiError && error.code === "PASSKEY_RATE_LIMITED") return error.message;
  if (error instanceof AuthApiError && error.code === "PASSKEY_NONE_REGISTERED") {
    return "Add a passkey to your account first.";
  }
  return "That passkey couldn't confirm it's you. Try again, or use another passkey.";
}

/**
 * The console's one admin step-up prompt. Admin changes the API refuses until
 * the person confirms with a passkey open it, and are sent again once they do.
 * Someone without a passkey is sent to add one.
 */
export function AdminStepUpDialog({
  confirm = confirmAdminWithPasskey,
}: {
  confirm?: () => Promise<void>;
}) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmed = useRef(false);
  const navigate = useNavigate();

  useEffect(
    () =>
      setAdminStepUpHandler(
        (request) =>
          new Promise<boolean>((resolve) => {
            confirmed.current = false;
            setError(null);
            setPrompt({ ...request, resolve });
          }),
      ),
    [],
  );

  const close = (result: boolean) => {
    prompt?.resolve(result);
    setPrompt(null);
  };

  if (!prompt) return null;
  if (!prompt.passkeyRegistered) {
    return (
      <FormDialog
        open
        onOpenChange={(open) => !open && close(false)}
        size="sm"
        leading={<KeyRoundIcon aria-hidden />}
        title="Add a passkey"
        description="Admin settings need a passkey to confirm it's you. Add one to your account, then try again."
        submitLabel="Add passkey"
        onSubmit={() => {
          close(false);
          void navigate({ to: "/settings/security" });
        }}
      />
    );
  }
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && close(confirmed.current)}
      size="sm"
      leading={<KeyRoundIcon aria-hidden />}
      title="Confirm it's you"
      description="Use your passkey to change admin settings. You won't be asked again until you sign out."
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
