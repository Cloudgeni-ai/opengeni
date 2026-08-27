import { BrowserAccountsApiError, createBrowserAccountsClient } from "@opengeni/sdk/accounts";
import { Loader2Icon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  accountAuthPopupAcknowledgement,
  isAccountAuthTransactionId,
  postAccountAuthPopupMessage,
} from "@/lib/browser-account-popup";

const browserAccountsApiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export function AccountAuthRoute({ transactionId }: { transactionId: string | undefined }) {
  const client = useMemo(
    () => createBrowserAccountsClient({ baseUrl: browserAccountsApiBaseUrl }),
    [],
  );
  const completionAttempt = useRef<{
    operationId: string;
    expectedGeneration: string;
  } | null>(null);
  const finishInFlight = useRef(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validTransactionId = isAccountAuthTransactionId(transactionId) ? transactionId : null;

  function finish(type: "opengeni-account-auth-complete" | "opengeni-account-auth-cancel") {
    if (!validTransactionId || finishInFlight.current) return;
    const opener = window.opener;
    if (!opener) {
      window.location.replace("/");
      return;
    }
    finishInFlight.current = true;
    const message = {
      type,
      transactionId: validTransactionId,
    } as const;
    let resendTimer: number | null = null;
    let timeoutTimer: number | null = null;
    const cleanup = () => {
      window.removeEventListener("message", onAcknowledgement);
      if (resendTimer !== null) window.clearInterval(resendTimer);
      if (timeoutTimer !== null) window.clearTimeout(timeoutTimer);
    };
    const onAcknowledgement = (event: MessageEvent<unknown>) => {
      if (
        !accountAuthPopupAcknowledgement(event, {
          origin: window.location.origin,
          opener,
          transactionId: validTransactionId,
        })
      ) {
        return;
      }
      cleanup();
      window.close();
    };
    const post = () => postAccountAuthPopupMessage(opener, window.location.origin, message);
    window.addEventListener("message", onAcknowledgement);
    if (!post()) {
      cleanup();
      window.location.replace("/");
      return;
    }
    // Keep the isolated popup alive until the exact opener acknowledges the
    // non-secret receipt. WebKit can discard a queued postMessage when its
    // sender closes immediately; bounded replay is safe because settlement is
    // authority-reread and transaction-idempotent.
    resendTimer = window.setInterval(post, 100);
    timeoutTimer = window.setTimeout(() => {
      cleanup();
      window.location.replace("/");
    }, 3_000);
  }

  async function submit() {
    if (!validTransactionId || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const projection = await client.getSessionSet();
      const attempt = completionAttempt.current ?? {
        operationId: crypto.randomUUID(),
        expectedGeneration: projection.generation,
      };
      completionAttempt.current = attempt;
      await client.completeEmailPasswordTransaction({
        operationId: attempt.operationId,
        expectedGeneration: attempt.expectedGeneration,
        transactionId: validTransactionId,
        email: email.trim(),
        password,
      });
      completionAttempt.current = null;
      setPassword("");
      finish("opengeni-account-auth-complete");
    } catch (caught) {
      // Credentials stay inside this isolated window and are discarded after
      // every failed attempt. Preserve both the idempotency key and its exact
      // generation only when transport loss made the committed outcome
      // unknown. Definitive failures start a fresh command on the next submit.
      if (
        !(caught instanceof BrowserAccountsApiError && caught.code === "operation_outcome_unknown")
      ) {
        completionAttempt.current = null;
      }
      setPassword("");
      setError(caught instanceof Error ? caught.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  if (!validTransactionId) {
    return (
      <section className="flex flex-1 items-center justify-center px-4">
        <div
          role="alert"
          className="w-full max-w-sm rounded-lg border border-status-failed/50 bg-surface p-5 shadow-sm forced-colors:border-[CanvasText]"
        >
          <h1 className="text-base font-semibold">Invalid account request</h1>
          <p className="mt-2 text-sm text-fg-subtle">
            Close this window and start the account action again from OpenGeni.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-1 items-center justify-center px-4 py-8">
      <form
        noValidate
        className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-sm forced-colors:border-[CanvasText]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="mb-5">
          <h1 className="text-base font-semibold">Authenticate this account</h1>
          <p className="mt-1 text-sm text-fg-subtle">
            Credentials stay in this isolated window. Your active account changes only after
            OpenGeni verifies the transaction.
          </p>
        </div>
        <div className="mb-3">
          <Label htmlFor="account-auth-email">Email</Label>
          <Input
            id="account-auth-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-2 min-h-11"
            autoFocus
            disabled={busy}
          />
        </div>
        <div>
          <Label htmlFor="account-auth-password">Password</Label>
          <Input
            id="account-auth-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 min-h-11"
            disabled={busy}
          />
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-status-failed">
            Authentication did not complete. Check the credentials and try again.
          </p>
        ) : null}
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => finish("opengeni-account-auth-cancel")}
          >
            Cancel
          </Button>
          <Button type="submit" className="min-h-11" disabled={busy || !email.trim() || !password}>
            {busy ? (
              <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            Continue
          </Button>
        </div>
      </form>
    </section>
  );
}
