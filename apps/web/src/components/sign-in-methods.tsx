import { KeyRoundIcon, ShieldCheckIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import type { ManagedSocialProvider } from "@/components/managed-social-auth-buttons";

export type SignInMethodView = {
  provider: ManagedSocialProvider;
  connected: boolean;
  available: boolean;
  email: string | null;
  emailLabel?: string;
  handle: string | null;
  canDisconnect: boolean;
  reconnectRequired: boolean;
};

export type SignInMethodsViewProps = {
  methods: SignInMethodView[];
  hasPassword: boolean;
  passwordAvailable: boolean;
  busy: boolean;
  recentAuthRequired: boolean;
  error: string | null;
  success: string | null;
  onReauthenticate: () => void;
  onConnect: (provider: ManagedSocialProvider) => void;
  onDisconnect: (provider: ManagedSocialProvider) => Promise<boolean>;
  onPassword: (password: string, currentPassword?: string) => Promise<boolean>;
};

export function providerLabel(provider: ManagedSocialProvider): string {
  return provider === "google" ? "Google" : "GitHub";
}

/** Presentation model is separate from the browser-cookie API and its actor fence. */
export function SignInMethodsView(props: SignInMethodsViewProps) {
  const [disconnect, setDisconnect] = useState<ManagedSocialProvider | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const disconnectTrigger = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const locked = props.busy || props.recentAuthRequired;

  async function savePassword() {
    setValidation(null);
    if (password.length < 8 || password.length > 128) {
      setValidation("Use 8 to 128 characters for your new password.");
      return;
    }
    if (password !== confirmation) {
      setValidation("The passwords don't match. Enter the same new password in both fields.");
      return;
    }
    const submitted = password;
    const previous = currentPassword;
    // Passwords live only in this form and request, never in recovery storage.
    setPassword("");
    setConfirmation("");
    setCurrentPassword("");
    if (await props.onPassword(submitted, props.hasPassword ? previous : undefined))
      setPasswordOpen(false);
  }

  return (
    <div className="grid min-w-0 gap-6" aria-busy={props.busy}>
      <div>
        <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight">
          Security
        </h1>
        <p className="mt-1 text-sm leading-6 text-fg-muted">
          Manage how you sign in to your personal OpenGeni account.
        </p>
      </div>
      {props.error ? (
        <div role="alert">
          <Notice tone="failed">{props.error}</Notice>
        </div>
      ) : null}
      {props.success ? (
        <div role="status">
          <Notice tone="success">{props.success}</Notice>
        </div>
      ) : null}
      {props.recentAuthRequired ? (
        <Notice tone="waiting" title="Confirm it's you">
          <p>
            Sign in again before changing your sign-in methods. Return here to review and retry your
            change.
          </p>
          <Button
            className="mt-3 min-h-11"
            variant="secondary"
            disabled={props.busy}
            onClick={() => {
              setPassword("");
              setCurrentPassword("");
              setConfirmation("");
              setPasswordOpen(false);
              setDisconnect(null);
              props.onReauthenticate();
            }}
          >
            Sign in again
          </Button>
        </Notice>
      ) : null}
      <section aria-labelledby="signin-methods-heading" className="min-w-0">
        <h2 id="signin-methods-heading" className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheckIcon className="size-4 text-fg-subtle" aria-hidden="true" /> Sign-in methods
        </h2>
        <p className="mt-1 text-sm leading-6 text-fg-muted">
          Keep at least one usable sign-in method connected so you can access your account.
        </p>
        <ul className="mt-3 divide-y divide-border border-y border-border">
          {props.methods.map((method) => (
            <li
              key={method.provider}
              className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-4"
            >
              <div className="min-w-0 flex-1 basis-48">
                <h3 className="text-sm font-medium">{providerLabel(method.provider)}</h3>
                <p className="mt-1 break-words text-sm text-fg-muted">
                  {method.connected
                    ? method.email
                      ? `${method.emailLabel ?? ""}${method.email}`
                      : (method.handle ?? "Connected")
                    : "Not connected"}
                  {method.connected && method.email && method.handle ? ` · ${method.handle}` : ""}
                </p>
                {method.connected && !method.canDisconnect ? (
                  <p className="mt-1 text-xs text-fg-subtle">
                    Your last usable sign-in method. Connect another method or set a password first.
                  </p>
                ) : null}
                {!method.available ? (
                  <p className="mt-1 text-xs text-fg-subtle">
                    Sign-in with this provider is unavailable on this deployment.
                  </p>
                ) : null}
                {method.reconnectRequired && !method.connected ? (
                  <p className="mt-1 text-xs text-fg-subtle">
                    Previously disconnected. Reconnect here to use it for sign-in again.
                  </p>
                ) : null}
              </div>
              {method.connected ? (
                <Button
                  className="min-h-11"
                  variant="outline"
                  disabled={locked || !method.canDisconnect}
                  aria-label={`Disconnect ${providerLabel(method.provider)}`}
                  onClick={(event) => {
                    disconnectTrigger.current = event.currentTarget;
                    setDisconnect(method.provider);
                  }}
                >
                  Disconnect
                </Button>
              ) : (
                <Button
                  className="min-h-11"
                  variant="outline"
                  disabled={locked || !method.available}
                  aria-label={`${method.reconnectRequired ? "Reconnect" : "Connect"} ${providerLabel(method.provider)}`}
                  onClick={() => props.onConnect(method.provider)}
                >
                  {method.reconnectRequired ? "Reconnect" : "Connect"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="signin-password-heading" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2
              id="signin-password-heading"
              className="flex items-center gap-2 text-sm font-semibold"
            >
              <KeyRoundIcon className="size-4 text-fg-subtle" aria-hidden="true" /> Password
            </h2>
            <p className="mt-1 text-sm text-fg-muted">
              {props.hasPassword
                ? "A password is set for email sign-in."
                : "No password set. Add one to sign in with your email."}
            </p>
          </div>
          {!passwordOpen ? (
            <Button
              variant="outline"
              className="min-h-11"
              disabled={locked || !props.passwordAvailable}
              onClick={() => {
                setPasswordOpen(true);
                setValidation(null);
              }}
            >
              {props.hasPassword ? "Change password" : "Set password"}
            </Button>
          ) : null}
        </div>
        {!props.passwordAvailable ? (
          <p className="text-xs text-fg-subtle">
            Password sign-in is unavailable on this deployment.
          </p>
        ) : null}
        {passwordOpen ? (
          <form
            className="grid max-w-md gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!locked) void savePassword();
            }}
          >
            {props.hasPassword ? (
              <div className="grid gap-2">
                <Label htmlFor="signin-current-password">Current password</Label>
                <Input
                  id="signin-current-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  disabled={locked}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
            ) : null}
            <div className="grid gap-2">
              <Label htmlFor="signin-new-password">New password</Label>
              <Input
                id="signin-new-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required
                disabled={locked}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby="signin-password-hint"
              />
              <p id="signin-password-hint" className="text-xs text-fg-subtle">
                Use at least 8 characters. A unique password keeps your account safer.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="signin-confirm-password">Confirm new password</Label>
              <Input
                id="signin-confirm-password"
                type="password"
                autoComplete="new-password"
                required
                disabled={locked}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                aria-invalid={Boolean(validation)}
              />
            </div>
            {validation ? (
              <p role="alert" className="text-sm text-status-failed">
                {validation}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="min-h-11" disabled={locked}>
                {props.busy ? "Saving…" : "Save password"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="min-h-11"
                disabled={props.busy}
                onClick={() => {
                  setPasswordOpen(false);
                  setPassword("");
                  setCurrentPassword("");
                  setConfirmation("");
                  setValidation(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </section>
      <p className="border-t border-border pt-4 text-sm leading-6 text-fg-subtle">
        These methods only sign you in to OpenGeni. Repository access, Gmail, and Google Drive are
        separate connections managed in workspace Capabilities. Connecting or disconnecting a
        sign-in method does not grant or remove those integrations.
      </p>
      <ConfirmDialog
        open={disconnect !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnect(null);
        }}
        title={`Disconnect ${disconnect ? providerLabel(disconnect) : "this sign-in method"}?`}
        description="You won't be able to sign in with this provider until you explicitly reconnect it here. Your other sign-in methods and workspace integrations are unchanged."
        confirmLabel={`Disconnect ${disconnect ? providerLabel(disconnect) : "provider"}`}
        cancelAutoFocus
        restoreFocusRef={disconnectTrigger}
        restoreFocusFallbackRef={headingRef}
        onConfirm={async () => (disconnect && !locked ? props.onDisconnect(disconnect) : false)}
      >
        {props.error ? (
          <p role="alert" className="text-sm text-status-failed">
            {props.error}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
