import {
  CalendarDaysIcon,
  CheckIcon,
  CloudIcon,
  ContactRoundIcon,
  HardDriveIcon,
  Loader2Icon,
  LockKeyholeIcon,
  MailIcon,
  ShieldCheckIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  type ComponentType,
  type FormEvent,
  type RefObject,
} from "react";

import {
  initialIntegrationConnectFlow,
  INTEGRATION_ACCOUNT_LABEL_MAX_LENGTH,
  integrationConnectFlowReducer,
  integrationConnectStepNumber,
  integrationConnectValidationError,
  type IntegrationConnectStep,
} from "@/components/capabilities/integration-connect-flow";
import {
  integrationExperience,
  type IntegrationExperienceDescriptor,
  type IntegrationExperienceIcon as IntegrationExperienceIconName,
} from "@/components/capabilities/integration-experience";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ConnectionOwnership, IntegrationDefinitionSummary } from "@/types";

export type IntegrationConnectRequest = {
  accountLabel: string;
  ownership: ConnectionOwnership;
};

const SAFE_START_ERROR =
  "We couldn't start the secure connection. Check your network and try again. If it keeps failing, ask a workspace administrator for help.";

const STEPS: readonly { id: IntegrationConnectStep; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "access", label: "Access" },
  { id: "review", label: "Review" },
];

const ICONS: Record<
  IntegrationExperienceIconName,
  ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  calendar: CalendarDaysIcon,
  cloud: CloudIcon,
  contacts: ContactRoundIcon,
  files: HardDriveIcon,
  mail: MailIcon,
};

export function IntegrationExperienceIcon({
  icon,
  className,
}: {
  icon: IntegrationExperienceIconName;
  className?: string;
}) {
  const Icon = ICONS[icon];
  return <Icon className={className} aria-hidden />;
}

export function integrationConnectFocusTarget(
  trigger: HTMLElement | null,
  fallback: HTMLElement | null,
): HTMLElement | null {
  if (trigger?.isConnected) return trigger;
  return fallback?.isConnected ? fallback : null;
}

export function IntegrationConnectDialog({
  open,
  definition,
  initialAccountLabel,
  canConnectPersonal,
  canConnectWorkspace,
  restoreFocusRef,
  restoreFocusFallbackRef,
  onOpenChange,
  onConnect,
}: {
  open: boolean;
  definition: IntegrationDefinitionSummary | null;
  initialAccountLabel: string;
  canConnectPersonal: boolean;
  canConnectWorkspace: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onConnect: (request: IntegrationConnectRequest) => Promise<void>;
}) {
  const input = useMemo(
    () => ({
      accountLabel: initialAccountLabel,
      preferredOwnership: "personal" as const,
      availability: {
        personal: canConnectPersonal,
        workspace: canConnectWorkspace,
      },
    }),
    [canConnectPersonal, canConnectWorkspace, initialAccountLabel],
  );
  const [state, dispatch] = useReducer(
    integrationConnectFlowReducer,
    input,
    initialIntegrationConnectFlow,
  );
  const experience = useMemo(
    () => (definition ? integrationExperience(definition) : null),
    [definition],
  );
  const accountInputRef = useRef<HTMLInputElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const busy = state.status === "submitting" || state.status === "redirecting";

  useEffect(() => {
    if (open) dispatch({ type: "reset", input });
  }, [definition?.id, input, open]);

  useEffect(() => {
    if (!open) return;
    if (state.status === "submitting" || state.status === "redirecting") return;
    const frame = window.requestAnimationFrame(() => {
      if (state.status === "error") {
        errorRef.current?.focus();
      } else if (state.step === "account") {
        accountInputRef.current?.focus();
      } else {
        stepHeadingRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, state.status, state.step]);

  if (!experience) {
    return <Dialog open={false} onOpenChange={onOpenChange} />;
  }

  const validationError = integrationConnectValidationError(state);
  const stepNumber = integrationConnectStepNumber(state.step);
  const primaryLabel =
    state.status === "submitting"
      ? "Starting secure connection…"
      : state.status === "redirecting"
        ? `Opening ${experience.providerName}…`
        : state.status === "error"
          ? "Try again"
          : state.step === "review"
            ? `Continue to ${experience.providerName}`
            : "Continue";

  function changeOpen(next: boolean) {
    if (busy) return;
    onOpenChange(next);
  }

  function advance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.step === "review") {
      void submit();
      return;
    }
    dispatch({ type: "next" });
  }

  async function submit() {
    if (state.step !== "review" || validationError || busy) return;
    const submissionId = state.submissionSequence + 1;
    dispatch({ type: "submit", submissionId });
    try {
      await onConnect({
        accountLabel: state.accountLabel.trim(),
        ownership: state.ownership,
      });
      dispatch({ type: "redirecting", submissionId });
    } catch {
      dispatch({ type: "submit_failed", submissionId, message: SAFE_START_ERROR });
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        showCloseButton={false}
        className="grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 motion-reduce:animate-none motion-reduce:transition-none sm:max-w-2xl sm:p-0"
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onPointerDownOutside={(event) => busy && event.preventDefault()}
        onCloseAutoFocus={(event) => {
          const destination = integrationConnectFocusTarget(
            restoreFocusRef?.current ?? null,
            restoreFocusFallbackRef?.current ?? null,
          );
          if (!destination) return;
          event.preventDefault();
          destination.focus();
        }}
      >
        <div className="border-b border-border bg-brand/5 px-5 py-5 sm:px-6">
          <DialogHeader className="pr-0 text-left">
            <div className="flex items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-brand/20 bg-surface text-brand shadow-sm forced-colors:outline forced-colors:outline-2">
                <IntegrationExperienceIcon icon={experience.icon} className="size-5" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-lg">Connect {experience.serviceName}</DialogTitle>
                <DialogDescription className="mt-1 leading-5">
                  {experience.introduction}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <ol className="mt-5 grid grid-cols-3 gap-2" aria-label="Connection setup progress">
            {STEPS.map((step, index) => {
              const currentIndex = stepNumber - 1;
              const complete = index < currentIndex;
              const current = step.id === state.step;
              const content = (
                <>
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-full border text-2xs font-semibold",
                      current || complete
                        ? "border-brand bg-brand text-white forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
                        : "border-border bg-surface text-fg-subtle",
                    )}
                    aria-hidden
                  >
                    {complete ? <CheckIcon className="size-3.5" /> : index + 1}
                  </span>
                  <span aria-hidden className="hidden text-xs font-medium text-fg sm:inline">
                    {step.label}
                  </span>
                  <span className="sr-only">
                    {step.label}, step {index + 1} of {STEPS.length}
                    {complete ? ", completed" : ""}
                  </span>
                </>
              );
              return (
                <li key={step.id} className="min-w-0">
                  {complete && !busy ? (
                    <button
                      type="button"
                      className="flex min-h-9 w-full items-center justify-center gap-2 rounded-lg text-left hover:bg-surface/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:justify-start sm:px-2"
                      onClick={() => dispatch({ type: "go_to", step: step.id })}
                    >
                      {content}
                    </button>
                  ) : (
                    <span
                      className="flex min-h-9 items-center justify-center gap-2 rounded-lg sm:justify-start sm:px-2"
                      {...(current ? { "aria-current": "step" as const } : {})}
                    >
                      {content}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>

        <form
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden"
          onSubmit={advance}
        >
          <div
            role="region"
            tabIndex={0}
            aria-label={`${STEPS[stepNumber - 1]!.label} connection setup content`}
            className="max-h-[55dvh] overflow-y-auto px-5 py-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:max-h-[52vh] sm:px-6"
          >
            {state.step === "account" ? (
              <AccountStep
                id={id}
                inputRef={accountInputRef}
                accountLabel={state.accountLabel}
                ownership={state.ownership}
                canConnectPersonal={canConnectPersonal}
                canConnectWorkspace={canConnectWorkspace}
                onAccountLabelChange={(value) => dispatch({ type: "account_label_changed", value })}
                onOwnershipChange={(value) => dispatch({ type: "ownership_changed", value })}
              />
            ) : state.step === "access" ? (
              <AccessStep id={id} experience={experience} headingRef={stepHeadingRef} />
            ) : (
              <ReviewStep
                id={id}
                experience={experience}
                accountLabel={state.accountLabel.trim()}
                ownership={state.ownership}
                headingRef={stepHeadingRef}
              />
            )}

            {state.error ? (
              <div
                ref={errorRef}
                tabIndex={-1}
                className="mt-5 rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm leading-5 text-fg outline-none"
                role="alert"
              >
                <p className="font-medium">Connection could not start</p>
                <p className="mt-1 text-xs text-fg-muted">{state.error}</p>
              </div>
            ) : null}
          </div>

          <DialogFooter className="border-t border-border bg-surface/70 px-5 py-4 sm:px-6">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            {state.step !== "account" ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() => dispatch({ type: "back" })}
              >
                Back
              </Button>
            ) : null}
            <Button
              type="submit"
              className="min-h-11"
              disabled={Boolean(validationError) || busy}
              aria-busy={busy}
              aria-describedby={validationError ? `${id}-validation` : undefined}
            >
              {busy ? (
                <Loader2Icon className="animate-spin motion-reduce:animate-none" />
              ) : state.step === "review" ? (
                <ShieldCheckIcon />
              ) : null}
              <span aria-live="polite" aria-atomic="true">
                {primaryLabel}
              </span>
            </Button>
            {validationError ? (
              <span id={`${id}-validation`} className="sr-only">
                {validationError}
              </span>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AccountStep({
  id,
  inputRef,
  accountLabel,
  ownership,
  canConnectPersonal,
  canConnectWorkspace,
  onAccountLabelChange,
  onOwnershipChange,
}: {
  id: string;
  inputRef: RefObject<HTMLInputElement | null>;
  accountLabel: string;
  ownership: ConnectionOwnership;
  canConnectPersonal: boolean;
  canConnectWorkspace: boolean;
  onAccountLabelChange: (value: string) => void;
  onOwnershipChange: (value: ConnectionOwnership) => void;
}) {
  const unavailable = !canConnectPersonal && !canConnectWorkspace;
  return (
    <section aria-labelledby={`${id}-account-heading`}>
      <h2 id={`${id}-account-heading`} className="text-base font-semibold text-fg">
        Name the account and choose who can use it
      </h2>
      <p className="mt-1 text-sm leading-5 text-fg-muted">
        The label distinguishes this account from connected siblings. It never changes the provider
        identity or grants access.
      </p>

      <div className="mt-5 grid gap-1.5">
        <Label htmlFor={`${id}-account-label`}>Account label</Label>
        <Input
          ref={inputRef}
          id={`${id}-account-label`}
          value={accountLabel}
          onChange={(event) => onAccountLabelChange(event.target.value)}
          placeholder="e.g. Gmail — Finance"
          maxLength={INTEGRATION_ACCOUNT_LABEL_MAX_LENGTH}
          autoComplete="off"
        />
        <p className="text-2xs leading-4 text-fg-subtle">
          Use a team, purpose, or mailbox name—not a password or credential.
        </p>
      </div>

      <fieldset className="mt-5 grid gap-2">
        <legend className="text-xs font-medium text-fg-muted">Who can use this account?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <OwnershipOption
            id={`${id}-personal`}
            name={`${id}-ownership`}
            value="personal"
            checked={ownership === "personal"}
            disabled={!canConnectPersonal}
            icon={UserRoundIcon}
            title="Personal"
            description="Only your sessions and work explicitly delegated from you can use it. Teammates connect their own account."
            onChange={onOwnershipChange}
          />
          <OwnershipOption
            id={`${id}-workspace`}
            name={`${id}-ownership`}
            value="workspace"
            checked={ownership === "workspace"}
            disabled={!canConnectWorkspace}
            icon={UsersRoundIcon}
            title="Workspace"
            description="Authorized workspace members and workspace automations can use the shared account."
            onChange={onOwnershipChange}
          />
        </div>
      </fieldset>

      {unavailable ? (
        <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs leading-5 text-fg-muted">
          <p className="font-medium text-fg">Administrator setup is required</p>
          <p className="mt-1">
            Ask a workspace administrator to connect this account or grant you permission to manage
            integrations. You can close this guide without changing anything.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function OwnershipOption({
  id,
  name,
  value,
  checked,
  disabled,
  icon: Icon,
  title,
  description,
  onChange,
}: {
  id: string;
  name: string;
  value: ConnectionOwnership;
  checked: boolean;
  disabled: boolean;
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onChange: (value: ConnectionOwnership) => void;
}) {
  return (
    <div className="relative">
      <input
        className="peer sr-only"
        type="radio"
        id={id}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <label
        htmlFor={id}
        className={cn(
          "block min-h-32 rounded-xl border p-3 text-left transition-colors motion-reduce:transition-none",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand",
          checked
            ? "border-brand bg-brand/5 shadow-sm forced-colors:border-[Highlight]"
            : "border-border bg-surface/50",
          disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer hover:border-border-strong",
        )}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-fg">
          <Icon className={cn("size-4", checked ? "text-brand" : "text-fg-subtle")} />
          {title}
          {disabled ? <span className="sr-only">Unavailable</span> : null}
        </span>
        <span className="mt-1 block text-2xs leading-4 text-fg-muted">{description}</span>
      </label>
    </div>
  );
}

function AccessStep({
  id,
  experience,
  headingRef,
}: {
  id: string;
  experience: IntegrationExperienceDescriptor;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <section aria-labelledby={`${id}-access-heading`}>
      <h2
        ref={headingRef}
        id={`${id}-access-heading`}
        tabIndex={-1}
        className="text-base font-semibold text-fg outline-none"
      >
        What agents can do
      </h2>
      <p className="mt-1 text-sm leading-5 text-fg-muted">
        These descriptions explain the reviewed integration surface. Your provider account and
        workspace policies still decide what is actually allowed.
      </p>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {experience.capabilities.map((capability) => (
          <li key={capability.title} className="rounded-xl border border-border bg-surface p-3">
            <p className="text-sm font-medium text-fg">{capability.title}</p>
            <p className="mt-1 text-xs leading-5 text-fg-muted">{capability.description}</p>
          </li>
        ))}
      </ul>

      <div className="mt-5 rounded-xl border border-brand/20 bg-brand/5 p-4">
        <div className="flex items-start gap-3">
          <LockKeyholeIcon className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
          <div>
            <h3 className="text-sm font-medium text-fg">Permission explanation</h3>
            <p className="mt-1 text-xs leading-5 text-fg-muted">{experience.permissionSummary}</p>
          </div>
        </div>
        {experience.permissions.length > 0 ? (
          <ul className="mt-3 grid gap-2">
            {experience.permissions.map((permission) => (
              <li key={permission.label} className="flex gap-2 text-xs leading-5 text-fg-muted">
                <CheckIcon className="mt-1 size-3.5 shrink-0 text-success" aria-hidden />
                <span>
                  <strong className="font-medium text-fg">{permission.label}.</strong>{" "}
                  {permission.description}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <details className="group mt-4 rounded-xl border border-border bg-bg p-3">
        <summary className="cursor-pointer text-xs font-medium text-fg-muted">
          Technical details
        </summary>
        <div className="mt-3 grid gap-3 text-2xs leading-5 text-fg-subtle">
          <div>
            <p className="font-medium text-fg-muted">Provider domain</p>
            <code className="break-all">{experience.technicalDetails.providerDomain}</code>
          </div>
          <div>
            <p className="font-medium text-fg-muted">OAuth scopes requested</p>
            {experience.technicalDetails.oauthScopes.length > 0 ? (
              <ul className="mt-1 grid gap-1">
                {experience.technicalDetails.oauthScopes.map((scope) => (
                  <li key={scope}>
                    <code className="break-all">{scope}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>None published.</p>
            )}
          </div>
          <p>
            These values describe the provider request. They are not credentials and do not grant
            access by themselves.
          </p>
        </div>
      </details>
    </section>
  );
}

function ReviewStep({
  id,
  experience,
  accountLabel,
  ownership,
  headingRef,
}: {
  id: string;
  experience: IntegrationExperienceDescriptor;
  accountLabel: string;
  ownership: ConnectionOwnership;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <section aria-labelledby={`${id}-review-heading`}>
      <h2
        ref={headingRef}
        id={`${id}-review-heading`}
        tabIndex={-1}
        className="text-base font-semibold text-fg outline-none"
      >
        Review the connection
      </h2>
      <p className="mt-1 text-sm leading-5 text-fg-muted">
        Nothing has been connected yet. Check the details before continuing to the provider.
      </p>

      <dl className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        <ReviewRow
          term="Service"
          detail={`${experience.serviceName} by ${experience.providerName}`}
        />
        <ReviewRow term="Account label" detail={accountLabel} />
        <ReviewRow
          term="Ownership"
          detail={
            ownership === "personal"
              ? "Personal — usable only through your delegated account access"
              : "Workspace — shared with authorized workspace members and automations"
          }
        />
        <ReviewRow
          term="Capabilities"
          detail={experience.capabilities.map((capability) => capability.title).join(", ")}
        />
      </dl>

      <div className="mt-4 flex gap-3 rounded-xl border border-brand/20 bg-brand/5 p-4">
        <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
        <div>
          <p className="text-sm font-medium text-fg">Next, continue to {experience.providerName}</p>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            {experience.providerName} will show its consent screen. Review it there before
            approving. OpenGeni stores the resulting connection separately from this display label.
          </p>
        </div>
      </div>
    </section>
  );
}

function ReviewRow({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[8rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium text-fg-subtle">{term}</dt>
      <dd className="break-words text-sm text-fg">{detail}</dd>
    </div>
  );
}
