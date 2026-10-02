import { Loader2Icon, LogOutIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import {
  completeSelfServiceOrganizationSetup,
  getSelfServiceOrganizationOnboardingStatus,
  type SelfServiceOrganizationOnboardingState,
} from "@/api";
import { OnboardingFrame, OnboardingStep } from "@/components/onboarding/onboarding-frame";
import { UseQuestion } from "@/components/onboarding/use-question";
import { Button } from "@/components/ui/button";
import { TechnicalDetails } from "@/components/ui/error-message";
import {
  apiErrorTechnicalFacts,
  userErrorText,
  userErrorTextWithoutReference,
} from "@/lib/api-error";
import { captureAnalyticsEvent } from "@/lib/analytics-observer";
import { intentsForUse, type FirstAgentUse } from "@/lib/first-agent";
import { onboardingJourney, useOnboardingStep } from "@/lib/onboarding-analytics";
import {
  intentAnalyticsProperties,
  newOnboardingJourney,
  onboardingJourneyStorageKey,
  updateOnboardingJourney,
  writeOnboardingJourney,
} from "@/lib/onboarding-journey";
import {
  defaultOrganizationName,
  onboardingDestination,
  onboardingIntentFromAttribution,
  type OnboardingCompletion,
} from "@/lib/onboarding-paths";
import { signupAttribution } from "@/lib/signup-attribution";
import {
  clearOrganizationInvitationContinuation,
  storeOrganizationInvitationContinuation,
  type OrganizationInvitationContinuation,
} from "@/lib/organization-invitation-continuation";
import type { OrganizationInvitation } from "@/types";

/**
 * The signed-in gate before an organization exists: an invitation to accept,
 * or the first real question ("What do you want to use Opengeni for?") with
 * the organization's suggested name folded into it. Answering (or Skip)
 * creates the organization and opens the app on first run's next page.
 */
export function OrganizationOnboardingPanel({
  onComplete,
  client,
  previewState,
  activeEmail = null,
  activeName = null,
  subjectId = null,
  preselectedUse,
  invitation = null,
  onUseInvitedAccount,
  onSignOut,
  onUseAnotherAccount,
}: {
  /** Opens the app; `next` names the page the chosen path continues on. */
  onComplete: (next?: OnboardingCompletion) => void;
  client?: OpenGeniBrowserClient;
  previewState?: SelfServiceOrganizationOnboardingState;
  activeEmail?: string | null;
  /** The signed-in person's name, for the suggested organization name. */
  activeName?: string | null;
  /** The signed-in subject: keys the Get started checklist this browser keeps. */
  subjectId?: string | null;
  /** The answer to preselect; defaults to the sign-up attribution (Product Hunt: a product). */
  preselectedUse?: FirstAgentUse | null;
  invitation?: OrganizationInvitationContinuation | null;
  onUseInvitedAccount?: (targetEmail: string) => void;
  /** Leaves onboarding for the signed-out page, so the person can pick another account. */
  onSignOut?: () => Promise<void> | void;
  /** Adds or selects a different browser account without signing this one out. */
  onUseAnotherAccount?: () => void;
}) {
  const [state, setState] = useState<SelfServiceOrganizationOnboardingState | null>(
    previewState ?? null,
  );
  const [statusError, setStatusError] = useState<{ error: unknown } | null>(null);
  const [statusRequest, setStatusRequest] = useState(0);
  const [organizationName, setOrganizationName] = useState(
    () => defaultOrganizationName(activeName, activeEmail) || "My organization",
  );
  const [use, setUse] = useState<FirstAgentUse | null>(() =>
    preselectedUse !== undefined
      ? preselectedUse
      : onboardingIntentFromAttribution(signupAttribution()) === "build"
        ? "product"
        : null,
  );
  const [busy, setBusy] = useState(false);
  const [invitations, setInvitations] = useState<OrganizationInvitation[]>([]);
  const [invitationLoading, setInvitationLoading] = useState(false);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [invitationResolution, setInvitationResolution] = useState<
    "matched" | "wrong_account" | "unavailable" | null
  >(null);
  const [acceptingInvitationId, setAcceptingInvitationId] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const operationId = useRef(crypto.randomUUID());
  const invitationOperationIds = useRef(new Map<string, string>());
  // Consent-gated onboarding journey.
  useOnboardingStep(
    state === null || state === "unavailable" || created
      ? null
      : state === "invitation_pending" || invitation
        ? "invitation"
        : "organization_name",
    undefined,
    !previewState,
  );
  useEffect(() => {
    if (previewState) return;
    if (created) return;
    let active = true;
    setStatusError(null);
    void getSelfServiceOrganizationOnboardingStatus()
      .then((result) => {
        if (!active) return;
        if (result.state === "complete") {
          onComplete();
          return;
        }
        setState(result.state);
      })
      .catch((error) => {
        if (!active) return;
        setStatusError({ error });
      });
    return () => {
      active = false;
    };
  }, [created, previewState, onComplete, statusRequest]);

  useEffect(() => {
    if ((state !== "invitation_pending" && !invitation) || !client) return;
    let active = true;
    setInvitationLoading(true);
    setInvitationError(null);
    setInvitationResolution(null);
    void listAllOrganizationInvitations(client)
      .then((listedInvitations) => {
        if (!active) return;
        const pendingInvitations = listedInvitations.filter(
          (listedInvitation) => listedInvitation.status === "pending",
        );
        if (!invitation) {
          setInvitations(pendingInvitations);
          return;
        }
        const matchingInvitation = pendingInvitations.find(
          (listedInvitation) =>
            listedInvitation.organizationId === invitation.organizationId &&
            normalizeEmail(listedInvitation.targetEmail) === normalizeEmail(invitation.targetEmail),
        );
        const resolution = matchingInvitation
          ? "matched"
          : activeEmail && normalizeEmail(activeEmail) !== normalizeEmail(invitation.targetEmail)
            ? "wrong_account"
            : "unavailable";
        setInvitations(matchingInvitation ? [matchingInvitation] : []);
        setInvitationResolution(resolution);
        if (resolution !== "wrong_account") clearOrganizationInvitationContinuation();
      })
      .catch((error) => {
        if (!active) return;
        setInvitationError(userErrorText(error));
      })
      .finally(() => {
        if (active) setInvitationLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeEmail, client, invitation, state]);

  async function acceptInvitation(selectedInvitation: OrganizationInvitation) {
    if (!client || acceptingInvitationId) return;
    const acceptedOperationId =
      invitationOperationIds.current.get(selectedInvitation.id) ?? crypto.randomUUID();
    invitationOperationIds.current.set(selectedInvitation.id, acceptedOperationId);
    setAcceptingInvitationId(selectedInvitation.id);
    setInvitationError(null);
    try {
      const accepted = await client.acceptOrganizationInvitation(selectedInvitation.id, {
        expectedRevision: selectedInvitation.revision,
        operationId: acceptedOperationId,
      });
      invitationOperationIds.current.delete(selectedInvitation.id);
      clearOrganizationInvitationContinuation();
      onboardingJourney().completed("invitation", "joined");
      // A lighter welcome for someone joining a team: no path question, just
      // the Get started checklist, limited to what their role can do.
      if (subjectId)
        writeOnboardingJourney(
          onboardingJourneyStorageKey(subjectId, selectedInvitation.organizationId),
          newOnboardingJourney({ invited: true }),
        );
      const personalWorkspaceId = accepted?.membership?.personalWorkspaceId ?? null;
      onComplete(
        personalWorkspaceId ? { to: `/workspaces/${personalWorkspaceId}/sessions` } : undefined,
      );
    } catch (error) {
      setInvitationError(userErrorText(error));
    } finally {
      setAcceptingInvitationId(null);
    }
  }

  /**
   * Creates the organization (and its Personal workspace) with the suggested
   * or edited name, remembers the answer for first run, and opens the app on
   * first run's next page: a product's questions, or the ready moment.
   */
  async function createOrganization(chosen: FirstAgentUse | null) {
    const normalizedName = organizationName.trim();
    if (!normalizedName || busy) return;
    setBusy(true);
    try {
      const setup = previewState
        ? { organizationId: "preview-organization", personalWorkspaceId: "preview-workspace" }
        : await completeSelfServiceOrganizationSetup({
            organizationName: normalizedName,
            operationId: operationId.current,
          });
      if (!previewState) onboardingJourney().completed("organization_name", "created");
      const intents = intentsForUse(chosen);
      if (subjectId)
        updateOnboardingJourney(
          onboardingJourneyStorageKey(subjectId, setup.organizationId),
          (current) => ({
            ...current,
            intents,
            firstAgent: {
              ...current.firstAgent,
              use: chosen,
              outcome: chosen ? current.firstAgent.outcome : "skipped",
            },
          }),
        );
      if (chosen)
        captureAnalyticsEvent("onboarding_intent_selected", {
          ...intentAnalyticsProperties(intents),
          source: "setup",
          changed: false,
        });
      setCreated(true);
      onComplete(onboardingDestination(setup.personalWorkspaceId, chosen));
    } catch (error) {
      toast.error("Couldn't set up the organization", {
        description: userErrorText(error),
      });
    } finally {
      setBusy(false);
    }
  }

  const account = (
    <OnboardingAccountHeader
      email={activeEmail}
      onSignOut={onSignOut}
      onUseAnotherAccount={onUseAnotherAccount}
    />
  );
  const frame = (content: ReactNode) => (
    <OnboardingFrame account={account}>{content}</OnboardingFrame>
  );

  if (state === null && statusError) {
    return frame(
      <div role="alert" className="contents">
        <OnboardingStep
          stepKey="status-error"
          width="sm"
          title="We couldn't load your account setup"
          description={
            <>
              Your account is signed in, but checking its organization setup failed. This is usually
              temporary. {userErrorTextWithoutReference(statusError.error)}
            </>
          }
        >
          {apiErrorTechnicalFacts(statusError.error).length > 0 ? (
            <div className="-mt-3 mb-4">
              <TechnicalDetails facts={apiErrorTechnicalFacts(statusError.error)} />
            </div>
          ) : null}
          <Button
            type="button"
            className="h-10 w-full"
            onClick={() => setStatusRequest((request) => request + 1)}
          >
            <RefreshCwIcon className="size-4" />
            Retry
          </Button>
        </OnboardingStep>
      </div>,
    );
  }

  if (state === null) {
    return frame(
      <section className="flex flex-1 items-center justify-center" role="status">
        <Loader2Icon className="size-5 animate-spin text-fg-subtle" />
        <span className="sr-only">Checking your account setup</span>
      </section>,
    );
  }

  if (state === "invitation_pending" || invitation) {
    const wrongAccount = invitationResolution === "wrong_account";
    const unavailable = invitationResolution === "unavailable";
    const focusedInvitation = invitationResolution === "matched" ? invitations[0] : null;
    return frame(
      <OnboardingStep
        stepKey="invitation"
        title={
          focusedInvitation
            ? `Join ${focusedInvitation.organizationName ?? "organization"}`
            : wrongAccount
              ? `This invitation is for ${invitation?.targetEmail}`
              : unavailable
                ? "This invitation is no longer available"
                : "Invitation pending"
        }
        description={
          focusedInvitation
            ? "Accept this invitation to create your own Personal workspace in the organization."
            : wrongAccount
              ? `You're signed in as ${activeEmail}. Switch accounts to join ${invitation?.organizationName}.`
              : unavailable
                ? `The invitation to ${invitation?.organizationName} may already have been accepted, expired, or revoked.`
                : "Choose the organization you want to join. Accepting creates your own Personal workspace there and never grants access to another person's personal content."
        }
      >
        {invitationLoading ? (
          <p className="flex items-center gap-2 text-sm text-fg-muted" role="status">
            <Loader2Icon className="size-4 animate-spin" /> Loading invitations
          </p>
        ) : invitationError ? (
          <p role="alert" className="text-sm text-danger">
            We couldn't update your invitations. {invitationError}
          </p>
        ) : wrongAccount ? (
          <div className="grid gap-3">
            <p className="text-sm text-fg-muted">
              Use the account for {invitation?.targetEmail}. The invitation remains available while
              you switch.
            </p>
            {onUseInvitedAccount ? (
              <Button
                type="button"
                className="h-10 w-full"
                onClick={() => {
                  if (!invitation) return;
                  storeContinuation(invitation);
                  onUseInvitedAccount(invitation.targetEmail);
                }}
              >
                Switch account
              </Button>
            ) : null}
          </div>
        ) : unavailable ? (
          <p className="text-sm text-fg-muted">
            Ask the organization administrator for a new invitation if you still need access.
          </p>
        ) : invitations.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No pending invitation is available. Refresh the page or ask your administrator for a new
            invitation.
          </p>
        ) : (
          <ul className="-my-1 divide-y divide-border">
            {invitations.map((listedInvitation) => (
              <li
                key={listedInvitation.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">
                    {listedInvitation.organizationName ?? "Inviting organization"}
                  </p>
                  <p className="truncate text-xs text-fg-muted">
                    {listedInvitation.targetEmail} · {listedInvitation.role}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={invitations.length === 1 ? "default" : "outline"}
                  disabled={acceptingInvitationId !== null}
                  onClick={() => void acceptInvitation(listedInvitation)}
                >
                  {acceptingInvitationId === listedInvitation.id ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : null}
                  Join organization
                </Button>
              </li>
            ))}
          </ul>
        )}
      </OnboardingStep>,
    );
  }

  if (state === "unavailable") {
    return frame(
      <OnboardingStep
        stepKey="unavailable"
        width="sm"
        title="Organization access unavailable"
        description="Your previous organization access is no longer active. Ask an organization administrator for a new invitation before continuing."
      >
        {null}
      </OnboardingStep>,
    );
  }

  if (created)
    return frame(
      <section className="flex flex-1 items-center justify-center" role="status">
        <Loader2Icon className="size-5 animate-spin text-fg-subtle" />
        <span className="sr-only">Opening Opengeni</span>
      </section>,
    );

  return frame(
    <OnboardingStep
      stepKey="organization"
      title="What do you want to use Opengeni for?"
      description="We'll set up the rest around your answer. You can do both later."
    >
      <UseQuestion
        initialUse={use}
        organizationName={organizationName}
        onOrganizationNameChange={setOrganizationName}
        busy={busy}
        onChoose={(chosen, { submit }) => {
          setUse(chosen);
          if (submit) void createOrganization(chosen);
        }}
        onSkip={() => void createOrganization(null)}
      />
    </OnboardingStep>,
  );
}

/** Who is signed in during onboarding, with a way out to another account. */
export function OnboardingAccountHeader({
  email,
  onSignOut,
  onUseAnotherAccount,
}: {
  email: string | null;
  onSignOut?: (() => Promise<void> | void) | undefined;
  onUseAnotherAccount?: (() => void) | undefined;
}) {
  const [signingOut, setSigningOut] = useState(false);
  if (!email && !onSignOut && !onUseAnotherAccount) return null;
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-x-1 text-xs text-fg-muted">
      {email ? (
        <span className="min-w-0 truncate">
          <span className="max-[480px]:sr-only">Signed in as </span>
          <span className="font-medium text-fg">{email}</span>
        </span>
      ) : null}
      {onUseAnotherAccount ? (
        <Button type="button" variant="ghost" size="xs" onClick={onUseAnotherAccount}>
          Use another account
        </Button>
      ) : null}
      {onSignOut ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-fg-muted pointer-coarse:h-11"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void Promise.resolve()
              .then(onSignOut)
              .catch((error) =>
                toast.error("Couldn't sign out", {
                  description: userErrorText(error),
                }),
              )
              .finally(() => setSigningOut(false));
          }}
        >
          {signingOut ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <LogOutIcon className="size-3.5" />
          )}
          <span className="max-[480px]:sr-only">
            {onUseAnotherAccount ? "Sign out" : "Sign out or use another account"}
          </span>
        </Button>
      ) : null}
    </div>
  );
}

async function listAllOrganizationInvitations(
  client: OpenGeniBrowserClient,
): Promise<OrganizationInvitation[]> {
  const invitations: OrganizationInvitation[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await client.listOrganizationInvitations({
      ...(cursor === undefined ? {} : { cursor }),
      limit: 100,
    });
    invitations.push(...result.invitations);
    const nextCursor = result.nextCursor ?? undefined;
    if (nextCursor !== undefined && seenCursors.has(nextCursor)) {
      throw new Error("Organization invitation pagination did not advance");
    }
    if (nextCursor !== undefined) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== undefined);
  return invitations;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function storeContinuation(invitation: OrganizationInvitationContinuation): void {
  storeOrganizationInvitationContinuation({
    organizationId: invitation.organizationId,
    organizationName: invitation.organizationName,
    targetEmail: invitation.targetEmail,
    expiresAt: invitation.expiresAt,
  });
}
