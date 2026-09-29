// Password-reset completion page (TOP-LEVEL route, sibling of /device). The
// managed-auth backend emails `<PUBLIC_BASE_URL>/reset-password?token=…`
// (Better Auth `sendResetPassword`); this page reads that token, collects a new
// password, and POSTs `{ newPassword, token }` to `/v1/auth/reset-password`.
//
// It is PUBLIC by construction — a user resetting a forgotten password is not
// signed in — so `RootRouteComponent` renders this route ahead of the auth
// gate and WITHOUT the app context provider. Nothing here may call
// `useAppContext`; it depends only on the query string and the auth endpoint.
import { Link } from "@tanstack/react-router";
import { CheckIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";

import { AuthApiError, resetPassword } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { apiErrorAdvice } from "@/lib/api-error";

// Minimum matches the sign-up form's `password.length < 8` rule so the two
// screens agree on what a valid password is.
const MIN_PASSWORD_LENGTH = 8;

// `authRequest` throws `AuthApiError` with the status, Better Auth's code and
// its sentence. An invalid or expired token is the overwhelmingly common
// failure, so say so plainly; a short validation sentence (a password that is
// too long) is kept; anything else says what to do instead of echoing the
// server.
function friendlyResetError(error: unknown): string {
  if (error instanceof AuthApiError) {
    if (/token|expire|invalid/i.test(`${error.code ?? ""} ${error.message}`)) {
      return "This reset link is invalid or has expired. Request a new one from the sign-in screen.";
    }
    if (error.status === 429) return "Too many attempts. Wait a moment and try again.";
    if (error.status === 400 || error.status === 422) return apiErrorAdvice(error);
  }
  if (error instanceof TypeError) return apiErrorAdvice(error);
  return "We couldn't reset your password. Please try again.";
}

export function ResetPasswordRoute({ token }: { token?: string | undefined }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const hasToken = Boolean(token);

  async function submit() {
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (!token) {
      return;
    }
    setBusy(true);
    try {
      await resetPassword({ newPassword: password, token });
      setDone(true);
    } catch (caught) {
      setError(friendlyResetError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="og-page-glow flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <KeyRoundIcon className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">Reset password</h1>
            <p className="text-sm text-fg-subtle">
              Choose a new password for your Opengeni account.
            </p>
          </div>
        </div>

        {done ? (
          <>
            <Notice tone="success" title="Password updated">
              Your password has been changed. Sign in with your new password to continue.
            </Notice>
            <Button asChild className="mt-4 w-full">
              <Link to="/">
                <CheckIcon className="size-4" />
                Continue to sign in
              </Link>
            </Button>
          </>
        ) : !hasToken ? (
          <>
            <Notice tone="failed" title="This link is incomplete">
              The reset link is missing its token, so we can't verify the request. Request a new
              reset email and open the link from your inbox.
            </Notice>
            <Button asChild variant="outline" className="mt-4 w-full">
              <Link to="/">Return to sign in</Link>
            </Button>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="mb-3">
              <Label htmlFor="reset-password-new">New password</Label>
              <Input
                id="reset-password-new"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                className="mt-2"
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="reset-password-confirm">Confirm password</Label>
              <Input
                id="reset-password-confirm"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                className="mt-2"
              />
            </div>
            {error ? (
              <Notice tone="failed" className="mt-4">
                {error}
              </Notice>
            ) : null}
            <Button type="submit" className="mt-4 w-full" disabled={busy}>
              {busy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <CheckIcon className="size-4" />
              )}
              Reset password
            </Button>
            <Button asChild variant="ghost" className="mt-2 w-full">
              <Link to="/">Back to sign in</Link>
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}
