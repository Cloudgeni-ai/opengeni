import { useNavigate } from "@tanstack/react-router";
import { KeyRoundIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PASSKEY_STEP_UP_HANDOFF_PATH } from "@opengeni/contracts/managed-sign-in-methods";
import { FormDialog } from "@opengeni/react/ui/form-dialog";

import {
  AuthApiError,
  confirmAdminWithPasskey,
  passkeyStepUpConfirmed,
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
  if (error instanceof AuthApiError && error.code === "PASSKEY_RATE_LIMITED") return error.message;
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
  confirmed: () => Promise<boolean>;
  open: (url: string) => void;
  /** How often to ask whether the browser confirmed. */
  pollMs: number;
};

const browserHandoff: StepUpHandoffApi = {
  start: startPasskeyStepUpHandoff,
  confirmed: passkeyStepUpConfirmed,
  open: openInBrowser,
  pollMs: 2_000,
};

/**
 * The console's one admin step-up prompt. Admin changes the API refuses until
 * the person confirms with a passkey open it, and are sent again once they do.
 * Someone without a passkey is sent to add one.
 *
 * Inside the desktop app, passkey prompts can't open (see
 * `passkeysNeedBrowser`), so the confirmation is handed to the person's own
 * browser on this same server and the dialog waits for it, with a way out.
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

  // While the browser confirms, ask the server whether it has; stop when it
  // has, when the handoff expires, or when the dialog closes.
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiresAt = Date.parse(waiting.expiresAt);
    const check = async () => {
      if (!live) return;
      if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
        setWaiting(null);
        setError("The confirmation in your browser expired. Try again.");
        return;
      }
      try {
        if (await handoff.confirmed()) {
          if (!live) return;
          confirmed.current = true;
          closeRef.current(true);
          return;
        }
      } catch (caught) {
        if (!live) return;
        if (caught instanceof AuthApiError && caught.status === 403) {
          setWaiting(null);
          setError(adminStepUpErrorMessage(caught));
          return;
        }
        // A dropped request: keep waiting, the next check may get through.
      }
      if (live) timer = setTimeout(() => void check(), handoff.pollMs);
    };
    timer = setTimeout(() => void check(), handoff.pollMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [waiting, handoff]);

  if (!prompt) return null;
  if (!prompt.passkeyRegistered) {
    return (
      <FormDialog
        open
        onOpenChange={(open) => !open && close(false)}
        size="sm"
        leading={<KeyRoundIcon aria-hidden />}
        title="Add a passkey"
        description={
          inBrowser
            ? "Admin settings need a passkey to confirm it's you. Add one in your browser, then try again here."
            : "Admin settings need a passkey to confirm it's you. Add one to your account, then try again."
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
    return (
      <FormDialog
        open
        onOpenChange={(open) => !open && close(false)}
        size="sm"
        leading={<KeyRoundIcon aria-hidden />}
        title="Confirm in your browser"
        description="Use your passkey in the browser window that opened. This continues by itself once you have."
        submitLabel="Open browser again"
        onSubmit={() => {
          handoff.open(passkeyHandoffUrl(waiting.handoffId));
          return false;
        }}
      >
        <div role="status" className="flex items-center gap-2 text-sm text-fg-muted">
          <LoaderCircleIcon aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />
          <span>
            Waiting for your browser. Check it shows code{" "}
            <strong className="font-mono text-fg tabular-nums">
              {formatHandoffCode(waiting.code)}
            </strong>
            .
          </span>
        </div>
      </FormDialog>
    );
  }
  if (inBrowser) {
    return (
      <FormDialog
        open
        onOpenChange={(open) => !open && close(false)}
        size="sm"
        leading={<KeyRoundIcon aria-hidden />}
        title="Confirm it's you"
        description="Use your passkey to change admin settings. Passkeys open in your browser, then this app continues."
        submitLabel="Continue in browser"
        pendingLabel="Opening your browser…"
        error={error}
        onSubmit={async () => {
          setError(null);
          try {
            const started = await handoff.start();
            handoff.open(passkeyHandoffUrl(started.handoffId));
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
