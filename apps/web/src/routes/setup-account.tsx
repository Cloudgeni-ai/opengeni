import { Link } from "@tanstack/react-router";
import { CheckIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import type { OrganizationUserSetupPreview } from "@opengeni/contracts";

import { completeOrganizationUserSetup, previewOrganizationUserSetup } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { storeOrganizationInvitationContinuation } from "@/lib/organization-invitation-continuation";

const MIN_PASSWORD_LENGTH = 8;
const SETUP_TOKEN_REMOUNT_HANDOFF_MS = 30_000;

// `history.replaceState` is intentionally used to scrub the setup bearer
// before any API request. TanStack observes that history mutation and may
// remount this lazy route, so React component state alone is not a reliable
// handoff. Keep at most one token in process memory for one short remount window
// and release it when the active preview settles; never project it into history,
// web storage, logs, or a server-side surface.
let pendingBrowserSetupToken: {
  pathname: string;
  token: string;
  expiryTimer: number;
} | null = null;

export function SetupAccountRoute({ token }: { token?: string | undefined }) {
  const [setupToken] = useState(() => token ?? consumeSetupAccountTokenFromBrowserLocation());
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [operationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [preview, setPreview] = useState<OrganizationUserSetupPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(Boolean(setupToken));
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    let active = true;
    if (!setupToken) return;
    setPreviewLoading(true);
    setPreviewFailed(false);
    void previewOrganizationUserSetup({ token: setupToken })
      .then((result) => {
        if (!active) return;
        setPreview(result);
        if (result.state === "pending" && result.targetName) setName(result.targetName);
      })
      .catch(() => {
        if (active) setPreviewFailed(true);
      })
      .finally(() => {
        if (active) {
          releasePendingBrowserSetupToken(setupToken);
          setPreviewLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [setupToken]);

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
    <section className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 py-4 sm:items-center">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <KeyRoundIcon className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">
              {preview?.state === "pending"
                ? `Join ${preview.organizationName}`
                : "Join an organization"}
            </h1>
            <p className="text-sm text-fg-subtle">
              {preview?.state === "pending"
                ? "Sign in or create an account to accept this invitation."
                : "Use your existing OpenGeni account or create a new one."}
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
        ) : previewLoading ? (
          <div className="flex items-center gap-2 text-sm text-fg-subtle" role="status">
            <Loader2Icon className="size-4 animate-spin" />
            Checking this invitation…
          </div>
        ) : previewFailed ? (
          <Notice tone="failed" title="We couldn't check this invitation">
            Refresh the page to try again. Account setup has not started.
          </Notice>
        ) : preview?.state !== "pending" ? (
          <UnavailableSetupState state={preview?.state ?? "unavailable"} />
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="mb-4 rounded-md border border-border bg-surface-subtle p-3 text-sm">
              <p>
                <span className="font-medium">{preview.organizationName}</span> invited{" "}
                <span className="font-medium">{preview.targetEmail}</span> as{" "}
                {titleCase(preview.organizationRole)}.
              </p>
              {preview.sharedWorkspaceAccess.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {preview.sharedWorkspaceAccess.map((workspace) => (
                    <li key={workspace.workspaceId}>
                      {workspace.workspaceName}: {titleCase(workspace.role)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-fg-subtle">No shared workspaces are assigned yet.</p>
              )}
              <p className="mt-2 text-fg-subtle">
                This does not share anyone&apos;s Personal workspace.
              </p>
            </div>
            <div className="mb-4 rounded-md border border-border bg-surface-subtle p-3">
              <p className="text-sm font-medium">Already have an OpenGeni account?</p>
              <p className="mt-1 text-xs leading-5 text-fg-subtle">
                Sign in and we&apos;ll take you directly back to this invitation.
              </p>
              <Button asChild variant="secondary" size="sm" className="mt-3 w-full">
                <Link
                  to="/"
                  onClick={() =>
                    storeOrganizationInvitationContinuation({
                      organizationId: preview.organizationId,
                      organizationName: preview.organizationName,
                      targetEmail: preview.targetEmail,
                      expiresAt: preview.expiresAt,
                    })
                  }
                >
                  Sign in and continue
                </Link>
              </Button>
            </div>
            <div className="mb-4 flex items-center gap-3 text-xs text-fg-subtle">
              <span className="h-px flex-1 bg-border" />
              New to OpenGeni?
              <span className="h-px flex-1 bg-border" />
            </div>
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
              Create account and join
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}

function UnavailableSetupState({
  state,
}: {
  state: "unavailable" | "expired" | "revoked" | "completed";
}) {
  const copy = {
    unavailable: {
      title: "This setup link is unavailable",
      body: "Ask your organization administrator for a new invitation.",
    },
    expired: {
      title: "This setup link has expired",
      body: "Ask your organization administrator to retry the invitation.",
    },
    revoked: {
      title: "This invitation was revoked",
      body: "Contact your organization administrator if you still need access.",
    },
    completed: {
      title: "This account is already set up",
      body: "Sign in with the account created from this invitation.",
    },
  }[state];
  return (
    <>
      <Notice tone={state === "completed" ? "success" : "failed"} title={copy.title}>
        {copy.body}
      </Notice>
      <Button asChild variant="secondary" className="mt-4 w-full">
        <Link to="/">Return to sign in</Link>
      </Button>
    </>
  );
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
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
  if (token) {
    cachePendingBrowserSetupToken(window.location.pathname, token);
  }
  const availableToken =
    token ??
    (pendingBrowserSetupToken?.pathname === window.location.pathname
      ? pendingBrowserSetupToken.token
      : null);
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (scrubbedPath !== currentPath) window.history.replaceState(null, "", scrubbedPath);
  return availableToken;
}

function cachePendingBrowserSetupToken(pathname: string, token: string): void {
  if (pendingBrowserSetupToken) window.clearTimeout(pendingBrowserSetupToken.expiryTimer);
  const pending = {
    pathname,
    token,
    expiryTimer: 0,
  };
  pending.expiryTimer = window.setTimeout(() => {
    if (pendingBrowserSetupToken === pending) pendingBrowserSetupToken = null;
  }, SETUP_TOKEN_REMOUNT_HANDOFF_MS);
  pendingBrowserSetupToken = pending;
}

function releasePendingBrowserSetupToken(token: string): void {
  if (pendingBrowserSetupToken?.token !== token) return;
  window.clearTimeout(pendingBrowserSetupToken.expiryTimer);
  pendingBrowserSetupToken = null;
}
