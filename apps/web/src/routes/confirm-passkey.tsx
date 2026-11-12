// Where the desktop app sends the person's browser to confirm an admin change
// with their passkey (`PASSKEY_STEP_UP_HANDOFF_PATH`). Passkey prompts can't
// open in the app itself, so the app starts a handoff on this server; here,
// signed in to the same account, the person uses their passkey and gets a
// one-time code to type into the app. The code is what confirms the app, so
// a link forwarded by someone else gains them nothing unless the code is
// shared too, which the page warns against.
import { CheckIcon, KeyRoundIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@opengeni/react/ui/button";
import { Notice } from "@opengeni/react/ui/notice";

import { AuthApiError, confirmPasskeyHandoff } from "@/api";
import { adminStepUpErrorMessage, formatHandoffCode } from "@/components/admin-step-up-dialog";

export type ConfirmPasskeyApi = {
  /** Runs the passkey ceremony for the handoff; resolves to the code for the app. */
  confirm: (handoffId: string) => Promise<string>;
};

const defaultApi: ConfirmPasskeyApi = { confirm: confirmPasskeyHandoff };

type State =
  | { kind: "ready" }
  | { kind: "confirming" }
  | { kind: "done"; code: string }
  | { kind: "unavailable"; message: string };

/** Why this page can't confirm, in a sentence the person can act on. */
export function handoffUnavailableMessage(error: unknown): string {
  if (error instanceof AuthApiError && error.code === "PASSKEY_HANDOFF_OTHER_ACCOUNT") {
    return "This browser is signed in to a different account than the app. Sign in here with the app's account, then select Continue in browser in the app again.";
  }
  if (error instanceof AuthApiError && error.code === "PASSKEY_HANDOFF_EXPIRED") {
    return "This confirmation expired or was already used. Start again in the app.";
  }
  return "Couldn't confirm. Check your connection and start again in the app.";
}

export function ConfirmPasskeyRoute({
  api = defaultApi,
  handoff,
}: {
  api?: ConfirmPasskeyApi;
  /** The handoff to confirm; by default the page's `?handoff=`. */
  handoff?: string;
}) {
  const handoffId = useMemo(
    () => handoff ?? new URLSearchParams(window.location.search).get("handoff") ?? "",
    [handoff],
  );
  const [state, setState] = useState<State>(() =>
    handoffId
      ? { kind: "ready" }
      : { kind: "unavailable", message: "This link is incomplete. Start again in the app." },
  );
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    setState({ kind: "confirming" });
    try {
      setState({ kind: "done", code: await api.confirm(handoffId) });
    } catch (caught) {
      if (
        caught instanceof AuthApiError &&
        (caught.code === "PASSKEY_HANDOFF_EXPIRED" ||
          caught.code === "PASSKEY_HANDOFF_OTHER_ACCOUNT")
      ) {
        setState({ kind: "unavailable", message: handoffUnavailableMessage(caught) });
        return;
      }
      setError(adminStepUpErrorMessage(caught));
      setState({ kind: "ready" });
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
              {state.kind === "done" ? "Enter this code in the app" : "Confirm it's you"}
            </h1>
            <p className="text-sm text-fg-subtle">For the Opengeni app</p>
          </div>
        </div>
        {state.kind === "unavailable" ? (
          <div role="alert">
            <Notice tone="failed">{state.message}</Notice>
          </div>
        ) : state.kind === "done" ? (
          <>
            <p
              aria-label={`Code ${state.code}`}
              className="font-mono text-3xl font-semibold tracking-wider text-fg tabular-nums"
            >
              {formatHandoffCode(state.code)}
            </p>
            <p className="mt-3 text-sm text-fg-muted">
              Type it into the Opengeni app on this computer. Never share it: anyone with this code
              can change admin settings as you.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              Continue only if you just selected Continue in browser in the Opengeni app. If you
              didn't, close this page.
            </p>
            {error ? (
              <div role="alert" className="mt-4">
                <Notice tone="failed">{error}</Notice>
              </div>
            ) : null}
            <Button
              className="mt-4 w-full"
              disabled={state.kind === "confirming"}
              onClick={() => void confirm()}
            >
              {state.kind === "confirming" ? "Waiting for your passkey…" : "Use passkey"}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
