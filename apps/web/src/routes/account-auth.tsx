import { BrowserAccountsApiError, createBrowserAccountsClient } from "@opengeni/sdk/accounts";
import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchClientConfig } from "@/api";
import {
  ManagedAuthDivider,
  ManagedSocialAuthButtons,
  type ManagedSocialProvider,
} from "@/components/managed-social-auth-buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  accountAuthPopupAcknowledgement,
  isAccountAuthTransactionId,
  postAccountAuthPopupMessage,
} from "@/lib/browser-account-popup";
import { readOrganizationInvitationContinuation } from "@/lib/organization-invitation-continuation";

const browserAccountsApiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export function AccountAuthRoute({
  transactionId,
  socialOutcome,
}: {
  transactionId: string | undefined;
  socialOutcome?: "complete" | "error";
}) {
  const client = useMemo(
    () => createBrowserAccountsClient({ baseUrl: browserAccountsApiBaseUrl }),
    [],
  );
  const completionAttempt = useRef<{
    operationId: string;
    expectedGeneration: string;
  } | null>(null);
  const socialStartAttempt = useRef<{
    provider: ManagedSocialProvider;
    operationId: string;
    expectedGeneration: string;
  } | null>(null);
  const finishInFlight = useRef(false);
  const [invitation] = useState(readInvitationFromOpener);
  const [email, setEmail] = useState(invitation?.targetEmail ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [socialBusy, setSocialBusy] = useState<ManagedSocialProvider | null>(null);
  const [socialProviders, setSocialProviders] = useState<ManagedSocialProvider[]>([]);
  const [error, setError] = useState<string | null>(
    socialOutcome === "error" ? "Social authentication did not complete" : null,
  );
  const validTransactionId = isAccountAuthTransactionId(transactionId) ? transactionId : null;

  const finish = useCallback(
    (type: "opengeni-account-auth-complete" | "opengeni-account-auth-cancel") => {
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
    },
    [validTransactionId],
  );

  useEffect(() => {
    let active = true;
    void fetchClientConfig()
      .then((config) => {
        if (!active || config.auth.mode !== "managedSession") return;
        setSocialProviders(config.auth.socialProviders ?? []);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (socialOutcome === "complete") finish("opengeni-account-auth-complete");
  }, [finish, socialOutcome]);

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

  async function submitSocial(provider: ManagedSocialProvider) {
    if (!validTransactionId) return;
    setSocialBusy(provider);
    setError(null);
    try {
      const projection = await client.getSessionSet();
      const existing = socialStartAttempt.current;
      const attempt =
        existing?.provider === provider
          ? existing
          : {
              provider,
              operationId: crypto.randomUUID(),
              expectedGeneration: projection.generation,
            };
      socialStartAttempt.current = attempt;
      const result = await client.startSocialTransaction({
        operationId: attempt.operationId,
        expectedGeneration: attempt.expectedGeneration,
        transactionId: validTransactionId,
        provider,
      });
      socialStartAttempt.current = null;
      window.location.assign(result.url);
    } catch (caught) {
      if (
        !(caught instanceof BrowserAccountsApiError && caught.code === "operation_outcome_unknown")
      ) {
        socialStartAttempt.current = null;
      }
      setError(caught instanceof Error ? caught.message : "Authentication failed");
      setSocialBusy(null);
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

  if (socialOutcome === "complete") {
    return (
      <section className="flex flex-1 items-center justify-center px-4">
        <div role="status" className="flex items-center gap-2 text-sm text-fg-subtle">
          <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
          Finishing sign in…
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
            {invitation
              ? `Sign in as ${invitation.targetEmail} to continue joining ${invitation.organizationName}.`
              : "This window keeps the account you choose separate until OpenGeni verifies the sign-in."}
          </p>
        </div>
        {!invitation ? (
          <>
            <ManagedSocialAuthButtons
              providers={socialProviders}
              busyProvider={socialBusy}
              disabled={busy}
              onSelect={(provider) => void submitSocial(provider)}
            />
            {socialProviders.length > 0 ? <ManagedAuthDivider /> : null}
          </>
        ) : null}
        <div className="mb-3">
          <Label htmlFor="account-auth-email">Email</Label>
          <Input
            id="account-auth-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            readOnly={invitation !== null}
            className="mt-2 min-h-11"
            autoFocus
            disabled={busy || socialBusy !== null}
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
            disabled={busy || socialBusy !== null}
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
            disabled={busy || socialBusy !== null}
            onClick={() => finish("opengeni-account-auth-cancel")}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="min-h-11"
            disabled={busy || socialBusy !== null || !email.trim() || !password}
          >
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

function readInvitationFromOpener() {
  try {
    return window.opener
      ? readOrganizationInvitationContinuation(window.opener.sessionStorage)
      : null;
  } catch {
    return null;
  }
}
