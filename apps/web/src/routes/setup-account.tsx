import { Link } from "@tanstack/react-router";
import { CheckIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";

import { completeOrganizationUserSetup } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";

const MIN_PASSWORD_LENGTH = 8;

export function SetupAccountRoute({ token }: { token?: string | undefined }) {
  const [setupToken] = useState(() => token ?? consumeSetupAccountTokenFromBrowserLocation());
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [operationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError("Enter your name.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (!setupToken) return;
    setBusy(true);
    try {
      await completeOrganizationUserSetup({
        token: setupToken,
        name: name.trim(),
        password,
        operationId,
      });
      setDone(true);
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : String(caught);
      setError(
        /invalid|expired|belongs|404/i.test(raw)
          ? "This setup link is invalid or has expired. Ask your organization administrator for a new invitation."
          : "We couldn't finish account setup. Try again with the same link.",
      );
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
            <h1 className="text-base font-semibold">Set up your account</h1>
            <p className="text-sm text-fg-subtle">
              Create your login for the organization that invited you.
            </p>
          </div>
        </div>

        {done ? (
          <>
            <Notice tone="success" title="Account ready">
              Your email is verified and your organization access is ready.
            </Notice>
            <Button asChild className="mt-4 w-full">
              <Link to="/">
                <CheckIcon className="size-4" />
                Sign in
              </Link>
            </Button>
          </>
        ) : !setupToken ? (
          <>
            <Notice tone="failed" title="This link is incomplete">
              Ask your organization administrator for a new invitation.
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
              <Label htmlFor="setup-account-name">Your name</Label>
              <Input
                id="setup-account-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                className="mt-2"
                autoFocus
              />
            </div>
            <div className="mb-3">
              <Label htmlFor="setup-account-password">Password</Label>
              <Input
                id="setup-account-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                className="mt-2"
              />
            </div>
            <div>
              <Label htmlFor="setup-account-confirm">Confirm password</Label>
              <Input
                id="setup-account-confirm"
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
              Create account
            </Button>
            <Button asChild variant="ghost" className="mt-2 w-full">
              <Link to="/">I already have an account</Link>
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}

export function setupAccountTokenFromUrl(value: string): {
  token: string | null;
  scrubbedPath: string;
} {
  const url = new URL(value, "https://opengeni.invalid");
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const candidate = fragment.get("token");
  const token = candidate && candidate.length <= 2_048 ? candidate : null;
  fragment.delete("token");
  url.searchParams.delete("token");
  const remainingFragment = fragment.toString();
  return {
    token,
    scrubbedPath: `${url.pathname}${url.search}${remainingFragment ? `#${remainingFragment}` : ""}`,
  };
}

function consumeSetupAccountTokenFromBrowserLocation(): string | null {
  if (typeof window === "undefined") return null;
  const { token, scrubbedPath } = setupAccountTokenFromUrl(window.location.href);
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (scrubbedPath !== currentPath) window.history.replaceState(null, "", scrubbedPath);
  return token;
}
