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

import { resetPassword } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";

// Minimum matches the sign-up form's `password.length < 8` rule so the two
// screens agree on what a valid password is.
const MIN_PASSWORD_LENGTH = 8;

// `authRequest` throws `Error("Auth <status>: <body>")` where the body is the
// Better Auth JSON error. Pull out a human-readable line; an invalid or expired
// token is the overwhelmingly common failure, so say so plainly.
function friendlyResetError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const body = raw.replace(/^Auth\s+\d+:\s*/, "");
  let message = body;
  try {
    const parsed = JSON.parse(body) as { message?: unknown; code?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      message = parsed.message;
    } else if (typeof parsed.code === "string" && parsed.code.trim()) {
      message = parsed.code;
    }
  } catch {
    // Body was not JSON — fall back to the raw text.
  }
  if (/token|expire|invalid/i.test(message)) {
    return "This reset link is invalid or has expired. Request a new one from the sign-in screen.";
  }
  return message.trim() || "We couldn't reset your password. Please try again.";
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
    <section className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <KeyRoundIcon className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">Reset password</h1>
            <p className="text-sm text-fg-subtle">
              Choose a new password for your OpenGeni account.
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
            <Button asChild variant="secondary" className="mt-4 w-full">
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
