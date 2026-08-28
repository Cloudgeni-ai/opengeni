import { CheckIcon, Loader2Icon, RefreshCwIcon, UserIcon } from "lucide-react";
import { useState } from "react";

import { sendVerificationEmail } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
  ManagedAuthDivider,
  ManagedSocialAuthButtons,
  type ManagedSocialProvider,
} from "@/components/managed-social-auth-buttons";
import {
  managedAuthFailure,
  validateManagedAuthInput,
  type ManagedAuthField,
  type ManagedAuthFormErrors,
  type ManagedAuthMode,
} from "@/lib/managed-auth-form";

export function ManagedAuthPanel(props: {
  initialMode?: ManagedAuthMode;
  allowedModes?: readonly ManagedAuthMode[];
  emailVerificationRequired?: boolean;
  presentation?: "card" | "embedded";
  socialProviders?: readonly ManagedSocialProvider[];
  onSocialSubmit?: (provider: ManagedSocialProvider) => Promise<void>;
  onSubmit: (
    mode: "signin" | "signup",
    input: { name: string; email: string; password: string },
  ) => Promise<void>;
}) {
  const allowedModes = props.allowedModes ?? (["signin", "signup"] as const);
  const requestedInitialMode = props.initialMode ?? "signin";
  const [mode, setMode] = useState<ManagedAuthMode>(
    allowedModes.includes(requestedInitialMode)
      ? requestedInitialMode
      : (allowedModes[0] ?? "signin"),
  );
  const emailVerificationRequired = props.emailVerificationRequired ?? true;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [socialBusy, setSocialBusy] = useState<ManagedSocialProvider | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ManagedAuthFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formActionMode, setFormActionMode] = useState<ManagedAuthMode | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function selectMode(nextMode: ManagedAuthMode) {
    setMode(nextMode);
    setFieldErrors({});
    setFormError(null);
    setFormActionMode(null);
    setSuccessMessage(null);
  }

  function updateField(field: ManagedAuthField, value: string) {
    if (field === "name") setName(value);
    if (field === "email") setEmail(value);
    if (field === "password") setPassword(value);
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setFormError(null);
    setFormActionMode(null);
    setSuccessMessage(null);
  }

  async function submit() {
    const input = { name: name.trim(), email: email.trim(), password };
    const validationErrors = validateManagedAuthInput(mode, input);
    setFieldErrors(validationErrors);
    setFormError(null);
    setFormActionMode(null);
    setSuccessMessage(null);
    if (Object.keys(validationErrors).length > 0) return;
    setBusy(true);
    try {
      await props.onSubmit(mode, { ...input, name: input.name || input.email });
      if (mode === "signup") {
        setSuccessMessage(
          emailVerificationRequired
            ? `We sent a verification link to ${input.email}.`
            : "Account created. You can sign in now.",
        );
      }
    } catch (error) {
      const failure = managedAuthFailure(mode, error);
      setFieldErrors(failure.fields);
      setFormError(failure.message);
      setFormActionMode(failure.switchTo);
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    const normalizedEmail = email.trim();
    const validationErrors = validateManagedAuthInput("signin", {
      name: "",
      email: normalizedEmail,
      password: "verification-placeholder",
    });
    if (validationErrors.email) {
      setFieldErrors({ email: validationErrors.email });
      return;
    }
    setFieldErrors({});
    setFormError(null);
    setFormActionMode(null);
    setSuccessMessage(null);
    setResendBusy(true);
    try {
      await sendVerificationEmail({ email: normalizedEmail });
      setSuccessMessage(`We sent a new verification link to ${normalizedEmail}.`);
    } catch {
      setFormError("We couldn't send a verification email. Please try again.");
      setFormActionMode(null);
    } finally {
      setResendBusy(false);
    }
  }

  async function submitSocial(provider: ManagedSocialProvider) {
    if (!props.onSocialSubmit) return;
    setSocialBusy(provider);
    setFieldErrors({});
    setFormError(null);
    setSuccessMessage(null);
    try {
      await props.onSocialSubmit(provider);
    } catch {
      setFormError(
        `Couldn't continue with ${provider === "google" ? "Google" : "GitHub"}. Try again.`,
      );
      setFormActionMode(null);
      setSocialBusy(null);
    }
  }

  return (
    <section
      className={
        props.presentation === "embedded"
          ? "w-full"
          : "flex flex-1 items-center justify-center px-4"
      }
    >
      <form
        noValidate
        className={
          props.presentation === "embedded"
            ? "w-full"
            : "w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-sm"
        }
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <UserIcon className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">
              {mode === "signup" ? "Create account" : "Sign in"}
            </h1>
            <p className="text-sm text-fg-subtle">
              Use your preferred account to access the managed console.
            </p>
          </div>
        </div>
        {allowedModes.length > 1 ? (
          <div className="mb-4 grid grid-cols-2 rounded-md border border-border bg-bg p-1">
            <Button
              type="button"
              size="sm"
              variant={mode === "signin" ? "secondary" : "ghost"}
              onClick={() => selectMode("signin")}
            >
              Sign in
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "signup" ? "secondary" : "ghost"}
              onClick={() => selectMode("signup")}
            >
              Sign up
            </Button>
          </div>
        ) : null}
        {props.socialProviders?.length && props.onSocialSubmit ? (
          <>
            <ManagedSocialAuthButtons
              providers={props.socialProviders}
              busyProvider={socialBusy}
              disabled={busy || resendBusy}
              onSelect={(provider) => void submitSocial(provider)}
            />
            <ManagedAuthDivider />
          </>
        ) : null}
        {mode === "signup" ? (
          <div className="mb-3">
            <Label htmlFor="managed-auth-name">Name</Label>
            <Input
              id="managed-auth-name"
              value={name}
              onChange={(event) => updateField("name", event.target.value)}
              autoComplete="name"
              className="mt-2"
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? "managed-auth-name-error" : undefined}
            />
            {fieldErrors.name ? (
              <p
                id="managed-auth-name-error"
                role="alert"
                className="mt-1.5 text-xs text-status-failed"
              >
                {fieldErrors.name}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="mb-3">
          <Label htmlFor="managed-auth-email">Email</Label>
          <Input
            id="managed-auth-email"
            type="email"
            value={email}
            onChange={(event) => updateField("email", event.target.value)}
            autoComplete="email"
            className="mt-2"
            autoFocus
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? "managed-auth-email-error" : undefined}
          />
          {fieldErrors.email ? (
            <p
              id="managed-auth-email-error"
              role="alert"
              className="mt-1.5 text-xs text-status-failed"
            >
              {fieldErrors.email}
            </p>
          ) : null}
        </div>
        <div>
          <Label htmlFor="managed-auth-password">Password</Label>
          <Input
            id="managed-auth-password"
            type="password"
            value={password}
            onChange={(event) => updateField("password", event.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            className="mt-2"
            aria-invalid={Boolean(fieldErrors.password)}
            aria-describedby={fieldErrors.password ? "managed-auth-password-error" : undefined}
          />
          {fieldErrors.password ? (
            <p
              id="managed-auth-password-error"
              role="alert"
              className="mt-1.5 text-xs text-status-failed"
            >
              {fieldErrors.password}
            </p>
          ) : mode === "signup" ? (
            <p className="mt-1.5 text-xs text-fg-subtle">Use at least 8 characters.</p>
          ) : null}
        </div>
        {formError ? (
          <Notice
            tone="failed"
            title={mode === "signup" ? "Couldn't create account" : "Couldn't sign in"}
            className="mt-4"
            action={
              formActionMode && formActionMode !== mode && allowedModes.includes(formActionMode) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => selectMode(formActionMode)}
                >
                  {formActionMode === "signin" ? "Sign in" : "Sign up"}
                </Button>
              ) : undefined
            }
          >
            {formError}
          </Notice>
        ) : null}
        {successMessage ? (
          <Notice
            tone="success"
            title={emailVerificationRequired ? "Check your email" : "Account created"}
            className="mt-4"
          >
            {successMessage}
          </Notice>
        ) : null}
        <Button type="submit" className="mt-4 w-full" disabled={busy || socialBusy !== null}>
          {busy ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <CheckIcon className="size-4" />
          )}
          {mode === "signup" ? "Create account" : "Sign in"}
        </Button>
        {mode === "signup" ? (
          <p className="mt-2 text-center text-xs text-fg-subtle">
            {emailVerificationRequired
              ? "We'll email you a link before you can sign in."
              : "This local stack signs you in immediately; no verification email is sent."}
          </p>
        ) : null}
        {emailVerificationRequired ? (
          <Button
            type="button"
            variant="ghost"
            className="mt-2 w-full"
            disabled={resendBusy || busy || socialBusy !== null}
            onClick={() => void resendVerification()}
          >
            {resendBusy ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-4" />
            )}
            Resend verification email
          </Button>
        ) : null}
      </form>
    </section>
  );
}
