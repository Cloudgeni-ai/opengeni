import { CircleAlertIcon } from "lucide-react";
import { useRef, useState, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { RowButton } from "@/components/ui/page-actions";
import { Section, SectionStack } from "@/components/ui/section";
import { SettingRow } from "@/components/ui/setting-row";
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
  mutationLocked?: boolean;
  recentAuthRequired: boolean;
  error: string | null;
  success: string | null;
  /** The unblocking action for the error, for example "Retry same request". */
  errorAction?: ReactNode;
  /** One quiet action beside the "Sign-in methods" heading, for example Refresh. */
  sectionAction?: ReactNode;
  onReauthenticate: () => void;
  onConnect: (provider: ManagedSocialProvider) => void;
  onDisconnect: (provider: ManagedSocialProvider) => Promise<boolean>;
  onPassword: (password: string, currentPassword?: string) => Promise<boolean>;
};

export function providerLabel(provider: ManagedSocialProvider): string {
  return provider === "google" ? "Google" : "GitHub";
}

/**
 * The Security page header. The page draws its own (the settings shell passes
 * no header) because the title is the focus fallback after a dialog closes.
 */
export function SecurityPageHeader({ headingRef }: { headingRef?: Ref<HTMLHeadingElement> }) {
  return (
    <header data-slot="page-header" className="min-w-0 pb-4">
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-xl leading-7 font-semibold tracking-[-0.5px] break-words text-fg"
      >
        Security
      </h1>
      <p className="mt-1 text-sm leading-5 text-fg-muted">
        Manage how you sign in to your personal Opengeni account.
      </p>
    </header>
  );
}

const SIGN_IN_METHODS_TITLE = "Sign-in methods";
const SIGN_IN_METHODS_DESCRIPTION =
  "Keep at least one usable sign-in method connected so you can access your account.";

/**
 * The page body under the header: the settings rhythm puts the first section
 * 32px below it. Loading and error states use it too, so nothing jumps.
 */
export function SecurityPageBody({ children }: { children: ReactNode }) {
  return <div className="mt-8 min-w-0">{children}</div>;
}

/** The sign-in methods card while it loads or failed to load. */
export function SignInMethodsPlaceholder({ children }: { children: ReactNode }) {
  return (
    <Section title={SIGN_IN_METHODS_TITLE} description={SIGN_IN_METHODS_DESCRIPTION}>
      {children}
    </Section>
  );
}

function methodDescription(method: SignInMethodView): ReactNode {
  const status = method.connected
    ? method.email
      ? `${method.emailLabel ?? ""}${method.email}${method.handle ? ` · ${method.handle}` : ""}`
      : (method.handle ?? "Connected")
    : "Not connected";
  const notes = [
    method.connected && !method.canDisconnect
      ? "Your last usable sign-in method. Connect another method or set a password first."
      : null,
    method.available ? null : "Sign-in with this provider is unavailable on this deployment.",
    method.reconnectRequired && !method.connected
      ? "Previously disconnected. Reconnect here to use it for sign-in again."
      : null,
  ].filter((note): note is string => note !== null);
  return (
    <>
      <span className="block break-words">{status}</span>
      {notes.map((note) => (
        <span key={note} className="block">
          {note}
        </span>
      ))}
    </>
  );
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
  const locked = props.busy || props.recentAuthRequired || props.mutationLocked;

  async function savePassword() {
    setValidation(null);
    if (props.hasPassword && !currentPassword) {
      setValidation("Enter your current password before changing it.");
      return;
    }
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

  function closePassword() {
    setPasswordOpen(false);
    setPassword("");
    setCurrentPassword("");
    setConfirmation("");
    setValidation(null);
  }

  const feedback =
    props.error || props.success || props.recentAuthRequired ? (
      <div className="mb-8 grid min-w-0 gap-3">
        {props.error ? (
          <div role="alert">
            <Notice tone="failed" action={props.errorAction} actionLayout="responsive">
              {props.error}
            </Notice>
          </div>
        ) : null}
        {props.success ? (
          <div role="status">
            <Notice tone="success">{props.success}</Notice>
          </div>
        ) : null}
        {props.recentAuthRequired ? (
          <Notice
            tone="waiting"
            title="Confirm it's you"
            actionLayout="responsive"
            action={
              <Button
                size="sm"
                className="pointer-coarse:h-11"
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
            }
          >
            Sign in again before changing your sign-in methods. Return here to review and retry your
            change.
          </Notice>
        ) : null}
      </div>
    ) : null;

  return (
    <div className="min-w-0" aria-busy={props.busy}>
      <SecurityPageHeader headingRef={headingRef} />
      <SecurityPageBody>
        {feedback}
        <SectionStack>
          <Section
            title={SIGN_IN_METHODS_TITLE}
            description={SIGN_IN_METHODS_DESCRIPTION}
            action={props.sectionAction}
          >
            {props.methods.map((method) => (
              <SettingRow
                key={method.provider}
                label={providerLabel(method.provider)}
                description={methodDescription(method)}
                control={
                  method.connected ? (
                    <RowButton
                      disabled={locked || !method.canDisconnect}
                      aria-label={`Disconnect ${providerLabel(method.provider)}`}
                      onClick={(event) => {
                        disconnectTrigger.current = event.currentTarget;
                        setDisconnect(method.provider);
                      }}
                    >
                      Disconnect
                    </RowButton>
                  ) : (
                    <RowButton
                      disabled={locked || !method.available}
                      aria-label={`${method.reconnectRequired ? "Reconnect" : "Connect"} ${providerLabel(method.provider)}`}
                      onClick={() => props.onConnect(method.provider)}
                    >
                      {method.reconnectRequired ? "Reconnect" : "Connect"}
                    </RowButton>
                  )
                }
              />
            ))}
            <SettingRow
              label="Password"
              description={
                <>
                  <span className="block">
                    {props.hasPassword
                      ? "A password is set for email sign-in."
                      : "No password set. Add one to sign in with your email."}
                  </span>
                  {props.passwordAvailable ? null : (
                    <span className="block">
                      Password sign-in is unavailable on this deployment.
                    </span>
                  )}
                </>
              }
              control={
                passwordOpen ? undefined : (
                  <RowButton
                    disabled={locked || !props.passwordAvailable}
                    onClick={() => {
                      setPasswordOpen(true);
                      setValidation(null);
                    }}
                  >
                    {props.hasPassword ? "Change password" : "Set password"}
                  </RowButton>
                )
              }
            />
            {passwordOpen ? (
              <form
                aria-label={props.hasPassword ? "Change password" : "Set password"}
                className="py-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!locked) void savePassword();
                }}
              >
                <FieldStack className="max-w-md gap-5">
                  {props.hasPassword ? (
                    <Field label="Current password" id="signin-current-password" required>
                      <TextInput
                        type="password"
                        autoComplete="current-password"
                        required
                        disabled={locked}
                        value={currentPassword}
                        onChange={(event) => setCurrentPassword(event.target.value)}
                      />
                    </Field>
                  ) : null}
                  <Field
                    label="New password"
                    id="signin-new-password"
                    required
                    hint="Use at least 8 characters. A unique password keeps your account safer."
                  >
                    <TextInput
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      required
                      disabled={locked}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      aria-invalid={Boolean(validation) || undefined}
                    />
                  </Field>
                  <Field label="Confirm new password" id="signin-confirm-password" required>
                    <TextInput
                      type="password"
                      autoComplete="new-password"
                      required
                      disabled={locked}
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      aria-invalid={Boolean(validation) || undefined}
                      aria-describedby={validation ? "signin-password-validation" : undefined}
                    />
                  </Field>
                </FieldStack>
                {validation ? (
                  <p
                    id="signin-password-validation"
                    role="alert"
                    className="mt-3 flex items-start gap-1.5 text-xs leading-4.5 text-danger"
                  >
                    <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0">{validation}</span>
                  </p>
                ) : null}
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button type="submit" size="sm" className="pointer-coarse:h-11" disabled={locked}>
                    {props.busy ? "Saving…" : "Save password"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="pointer-coarse:h-11"
                    disabled={props.busy}
                    onClick={closePassword}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null}
          </Section>
        </SectionStack>
        <p className="mt-3 text-xs leading-4.5 text-fg-muted">
          These methods only sign you in to Opengeni. Repository access, Gmail, and Google Drive are
          separate connections managed in workspace Capabilities. Connecting or disconnecting a
          sign-in method does not grant or remove those integrations.
        </p>
      </SecurityPageBody>
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
