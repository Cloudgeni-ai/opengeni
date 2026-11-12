// Where the desktop app sends the person's browser to confirm an admin change
// with their passkey (`PASSKEY_STEP_UP_HANDOFF_PATH`). Passkey prompts can't
// open in the app itself, so the app starts a handoff on this server and waits;
// here, signed in to the same account, the person uses their passkey, which
// confirms the app's session too. The code matches the one the app shows.
import { CheckIcon, KeyRoundIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@opengeni/react/ui/button";
import { Notice } from "@opengeni/react/ui/notice";

import { AuthApiError, confirmAdminWithPasskey, readPasskeyStepUpHandoff } from "@/api";
import { adminStepUpErrorMessage, formatHandoffCode } from "@/components/admin-step-up-dialog";

export type ConfirmPasskeyApi = {
  read: (handoffId: string) => Promise<{ code: string }>;
  confirm: (handoffId: string) => Promise<void>;
};

const defaultApi: ConfirmPasskeyApi = {
  read: readPasskeyStepUpHandoff,
  confirm: confirmAdminWithPasskey,
};

type State =
  | { kind: "loading" }
  | { kind: "ready"; code: string }
  | { kind: "confirming"; code: string }
  | { kind: "done" }
  | { kind: "unavailable"; message: string };

/** Why this page can't confirm, in a sentence the person can act on. */
export function handoffUnavailableMessage(error: unknown): string {
  if (error instanceof AuthApiError && error.code === "PASSKEY_HANDOFF_OTHER_ACCOUNT") {
    return "This browser is signed in to a different account than the app. Sign in here with the app's account, then select Continue in browser in the app again.";
  }
  if (error instanceof AuthApiError && error.code === "PASSKEY_HANDOFF_SIGNED_OUT") {
    return error.message;
  }
  if (error instanceof AuthApiError && error.code === "PASSKEY_HANDOFF_EXPIRED") {
    return "This confirmation expired or was already used. Start again in the app.";
  }
  return "Couldn't load this confirmation. Check your connection and reload this page.";
}

export function ConfirmPasskeyRoute({ api = defaultApi }: { api?: ConfirmPasskeyApi }) {
  const handoffId = useMemo(
    () => new URLSearchParams(window.location.search).get("handoff") ?? "",
    [],
  );
  const [state, setState] = useState<State>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!handoffId) {
      setState({
        kind: "unavailable",
        message: "This link is incomplete. Start again in the app.",
      });
      return;
    }
    let live = true;
    void api
      .read(handoffId)
      .then((handoff) => {
        if (live) setState({ kind: "ready", code: handoff.code });
      })
      .catch((caught) => {
        if (live) setState({ kind: "unavailable", message: handoffUnavailableMessage(caught) });
      });
    return () => {
      live = false;
    };
  }, [api, handoffId]);

  async function confirm(code: string) {
    setError(null);
    setState({ kind: "confirming", code });
    try {
      await api.confirm(handoffId);
      setState({ kind: "done" });
    } catch (caught) {
      if (
        caught instanceof AuthApiError &&
        (caught.code === "PASSKEY_HANDOFF_EXPIRED" ||
          caught.code === "PASSKEY_HANDOFF_OTHER_ACCOUNT" ||
          caught.code === "PASSKEY_HANDOFF_SIGNED_OUT")
      ) {
        setState({ kind: "unavailable", message: handoffUnavailableMessage(caught) });
        return;
      }
      setError(adminStepUpErrorMessage(caught));
      setState({ kind: "ready", code });
    }
  }

  return (
    <section className="og-page-glow flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            {state.kind === "done" ? (
              <CheckIcon aria-hidden className="size-4" />
            ) : (
              <KeyRoundIcon aria-hidden className="size-4" />
            )}
          </span>
          <div>
            <h1 className="text-base font-semibold">
              {state.kind === "done" ? "Confirmed" : "Confirm it's you"}
            </h1>
            <p className="text-sm text-fg-subtle">For the Opengeni app</p>
          </div>
        </div>
        {state.kind === "loading" ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading…
          </p>
        ) : state.kind === "unavailable" ? (
          <div role="alert">
            <Notice tone="failed">{state.message}</Notice>
          </div>
        ) : state.kind === "done" ? (
          <p role="status" className="text-sm text-fg-muted">
            The app continues by itself. You can close this tab.
          </p>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              Continue only if the Opengeni app shows this code:
            </p>
            <p className="mt-2 font-mono text-2xl font-semibold tracking-wider text-fg tabular-nums">
              {formatHandoffCode(state.code)}
            </p>
            {error ? (
              <div role="alert" className="mt-4">
                <Notice tone="failed">{error}</Notice>
              </div>
            ) : null}
            <Button
              className="mt-4 w-full"
              disabled={state.kind === "confirming"}
              onClick={() => void confirm(state.code)}
            >
              {state.kind === "confirming" ? "Waiting for your passkey…" : "Use passkey"}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
