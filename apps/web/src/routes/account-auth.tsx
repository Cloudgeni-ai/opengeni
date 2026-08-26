import { createBrowserAccountsClient } from "@opengeni/sdk/accounts";
import { Loader2Icon, ShieldCheckIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { apiBaseUrl } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
  isAccountAuthTransactionId,
  postAccountAuthPopupMessage,
} from "@/lib/browser-account-popup";

export function AccountAuthRoute({ transactionId }: { transactionId: string | undefined }) {
  const client = useMemo(() => createBrowserAccountsClient({ baseUrl: apiBaseUrl }), []);
  const completionOperationId = useRef(crypto.randomUUID());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validTransactionId = isAccountAuthTransactionId(transactionId) ? transactionId : null;

  function finish(type: "opengeni-account-auth-complete" | "opengeni-account-auth-cancel") {
    if (!validTransactionId) return;
    const posted = postAccountAuthPopupMessage(window.opener, window.location.origin, {
      type,
      transactionId: validTransactionId,
    });
    if (posted) {
      window.close();
    } else {
      window.location.replace("/");
    }
  }

  async function submit() {
    if (!validTransactionId || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const projection = await client.getSessionSet();
      await client.completeEmailPasswordTransaction({
        operationId: completionOperationId.current,
        expectedGeneration: projection.generation,
        transactionId: validTransactionId,
        email: email.trim(),
        password,
      });
      setPassword("");
      finish("opengeni-account-auth-complete");
    } catch (caught) {
      // Credentials stay inside this isolated window and are discarded after
      // every failed attempt. The idempotency key remains stable for an
      // outcome-unknown retry, while the password must be typed again.
      setPassword("");
      setError(caught instanceof Error ? caught.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  if (!validTransactionId) {
    return (
      <section className="flex flex-1 items-center justify-center px-4">
        <Notice tone="danger" title="Invalid account request">
          Close this window and start the account action again from OpenGeni.
        </Notice>
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
        <div className="mb-5 flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-brand-strong/20 text-brand forced-colors:border forced-colors:border-[CanvasText]">
            <ShieldCheckIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-base font-semibold">Authenticate this account</h1>
            <p className="mt-1 text-sm text-fg-subtle">
              Credentials stay in this isolated window. Your active account changes only after
              OpenGeni verifies the transaction.
            </p>
          </div>
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
