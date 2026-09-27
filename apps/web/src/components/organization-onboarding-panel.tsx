import {
  Building2Icon,
  CheckIcon,
  CircleAlertIcon,
  LockKeyholeIcon,
  Loader2Icon,
  LogOutIcon,
  MailIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { ClientModel } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import {
  completeSelfServiceOrganizationSetup,
  getSelfServiceOrganizationOnboardingStatus,
  type SelfServiceOrganizationOnboardingState,
} from "@/api";
import {
  ModelAccessOnboardingPanel,
  type IncludedOnboardingModel,
} from "@/components/model-access-onboarding";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { includedDefaultModel } from "@/lib/model-access-onboarding";
import {
  loadModelAccessOnboarding,
  type StartingCreditsOnboarding,
} from "@/lib/onboarding-starting-credits";
import {
  clearOrganizationInvitationContinuation,
  storeOrganizationInvitationContinuation,
  type OrganizationInvitationContinuation,
} from "@/lib/organization-invitation-continuation";
import type { OrganizationInvitation } from "@/types";

export function OrganizationOnboardingPanel({
  onComplete,
  client,
  billingMode = "disabled",
  codexEnabled = false,
  supergrokEnabled = false,
  includedModel,
  startingCredits,
  modelDefaults = null,
  previewState,
  activeEmail = null,
  invitation = null,
  onUseInvitedAccount,
  onSignOut,
  onUseAnotherAccount,
}: {
  onComplete: () => void;
  client?: OpenGeniBrowserClient;
  billingMode?: "disabled" | "stripe";
  codexEnabled?: boolean;
  supergrokEnabled?: boolean;
  includedModel?: IncludedOnboardingModel | null;
  /**
   * Credits the organization already holds; read from the new workspace's
   * catalog and balance when not given.
   */
  startingCredits?: StartingCreditsOnboarding | null;
  /** Client-config model defaults; the included model is derived from them when not given. */
  modelDefaults?: { defaultModel: string; models: readonly ClientModel[] } | null;
  previewState?: SelfServiceOrganizationOnboardingState;
  activeEmail?: string | null;
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
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusRequest, setStatusRequest] = useState(0);
  const [organizationName, setOrganizationName] = useState("");
  const [busy, setBusy] = useState(false);
  const [invitations, setInvitations] = useState<OrganizationInvitation[]>([]);
  const [invitationLoading, setInvitationLoading] = useState(false);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [invitationResolution, setInvitationResolution] = useState<
    "matched" | "wrong_account" | "unavailable" | null
  >(null);
  const [acceptingInvitationId, setAcceptingInvitationId] = useState<string | null>(null);
  const [createdSetup, setCreatedSetup] = useState<{
    organizationId: string;
    personalWorkspaceId: string;
  } | null>(null);
  const operationId = useRef(crypto.randomUUID());
  const invitationOperationIds = useRef(new Map<string, string>());
  // An explicit `includedModel` or `startingCredits` (previews, embedders) is
  // authoritative. The client-config candidate is only a hint until the new
  // Personal workspace's catalog confirms that model is selectable there, and
  // on a deployment that bills credits the same catalog read tells whether new
  // chats already default to a credits model the organization can pay for.
  const includedCandidate =
    includedModel !== undefined
      ? null
      : modelDefaults
        ? includedDefaultModel({ ...modelDefaults, billingMode })
        : null;
  const checkStartingCredits = billingMode === "stripe" && startingCredits === undefined;
  const liveCheckKey =
    includedCandidate || checkStartingCredits
      ? JSON.stringify({ includedCandidate, checkStartingCredits })
      : null;
  const [liveModelAccess, setLiveModelAccess] = useState<{
    key: string;
    workspaceId: string;
    includedModel: IncludedOnboardingModel | null;
    startingCredits: StartingCreditsOnboarding | null;
  } | null>(null);
  const confirmingOrganizationId = createdSetup?.organizationId ?? null;
  const confirmingWorkspaceId = createdSetup?.personalWorkspaceId ?? null;

  useEffect(() => {
    if (previewState) return;
    if (createdSetup) return;
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
        setStatusError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [createdSetup, previewState, onComplete, statusRequest]);

  useEffect(() => {
    if (!liveCheckKey || !confirmingOrganizationId || !confirmingWorkspaceId) return;
    const unconfirmed = { includedModel: null, startingCredits: null };
    if (!client) {
      setLiveModelAccess({ key: liveCheckKey, workspaceId: confirmingWorkspaceId, ...unconfirmed });
      return;
    }
    let active = true;
    const check = JSON.parse(liveCheckKey) as {
      includedCandidate: IncludedOnboardingModel | null;
      checkStartingCredits: boolean;
    };
    void loadModelAccessOnboarding(client, {
      organizationId: confirmingOrganizationId,
      workspaceId: confirmingWorkspaceId,
      billingMode: check.checkStartingCredits ? "stripe" : "disabled",
      includedCandidate: check.includedCandidate,
    })
      // Unverifiable is not included: fall back to the ordinary choice screen.
      .catch(() => unconfirmed)
      .then((result) => {
        if (active)
          setLiveModelAccess({ key: liveCheckKey, workspaceId: confirmingWorkspaceId, ...result });
      });
    return () => {
      active = false;
    };
  }, [client, confirmingOrganizationId, confirmingWorkspaceId, liveCheckKey]);

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
        setInvitationError(error instanceof Error ? error.message : String(error));
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
      await client.acceptOrganizationInvitation(selectedInvitation.id, {
        expectedRevision: selectedInvitation.revision,
        operationId: acceptedOperationId,
      });
      invitationOperationIds.current.delete(selectedInvitation.id);
      clearOrganizationInvitationContinuation();
      onComplete();
    } catch (error) {
      setInvitationError(error instanceof Error ? error.message : String(error));
    } finally {
      setAcceptingInvitationId(null);
    }
  }

  async function submit() {
    const normalizedName = organizationName.trim();
    if (!normalizedName) {
      toast.error("Enter your organization name");
      return;
    }
    setBusy(true);
    try {
      if (!previewState) {
        const created = await completeSelfServiceOrganizationSetup({
          organizationName: normalizedName,
          operationId: operationId.current,
        });
        setCreatedSetup({
          organizationId: created.organizationId,
          personalWorkspaceId: created.personalWorkspaceId,
        });
        return;
      }
      setCreatedSetup({
        organizationId: "preview-organization",
        personalWorkspaceId: "preview-workspace",
      });
    } catch (error) {
      toast.error("Organization setup failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  const frame = (content: ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <OnboardingAccountHeader
        email={activeEmail}
        onSignOut={onSignOut}
        onUseAnotherAccount={onUseAnotherAccount}
      />
      {content}
    </div>
  );

  if (state === null && statusError) {
    return frame(
      <section className="flex flex-1 items-center justify-center px-4">
        <div
          role="alert"
          className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-sm"
        >
          <span className="mb-4 flex size-9 items-center justify-center rounded-md bg-status-failed/15 text-status-failed">
            <CircleAlertIcon className="size-4" />
          </span>
          <h1 className="text-base font-semibold">We couldn't load your account setup</h1>
          <p className="mt-2 text-sm leading-5 text-fg-subtle">
            Your account is signed in, but checking its organization setup failed. This is usually
            temporary. {statusError}
          </p>
          <Button
            type="button"
            className="mt-4 w-full"
            onClick={() => setStatusRequest((request) => request + 1)}
          >
            <RefreshCwIcon className="size-4" />
            Retry
          </Button>
        </div>
      </section>,
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
      <section className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-5 shadow-sm">
          <span className="mb-4 flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <MailIcon className="size-4" />
          </span>
          <h1 className="text-base font-semibold">
            {focusedInvitation
              ? `Join ${focusedInvitation.organizationName ?? "organization"}`
              : wrongAccount
                ? `This invitation is for ${invitation?.targetEmail}`
                : unavailable
                  ? "This invitation is no longer available"
                  : "Invitation pending"}
          </h1>
          <p className="mt-2 text-sm leading-5 text-fg-subtle">
            {focusedInvitation
              ? "Accept this invitation to create your own Personal workspace in the organization."
              : wrongAccount
                ? `You're signed in as ${activeEmail}. Switch accounts to join ${invitation?.organizationName}.`
                : unavailable
                  ? `The invitation to ${invitation?.organizationName} may already have been accepted, expired, or revoked.`
                  : "Choose the organization you want to join. Accepting creates your own Personal workspace there and never grants access to another person's personal content."}
          </p>
          {invitationLoading ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
              <Loader2Icon className="size-4 animate-spin" /> Loading invitations
            </p>
          ) : invitationError ? (
            <p role="alert" className="mt-4 text-sm text-danger">
              We couldn't update your invitations. {invitationError}
            </p>
          ) : wrongAccount ? (
            <div className="mt-4 rounded-md border border-border bg-surface-subtle p-3">
              <p className="text-sm text-fg-subtle">
                Use the account for {invitation?.targetEmail}. The invitation remains available
                while you switch.
              </p>
              {onUseInvitedAccount ? (
                <Button
                  type="button"
                  size="sm"
                  className="mt-3"
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
            <p className="mt-4 text-sm text-fg-muted">
              Ask the organization administrator for a new invitation if you still need access.
            </p>
          ) : invitations.length === 0 ? (
            <p className="mt-4 text-sm text-fg-muted">
              No pending invitation is available. Refresh the page or ask your administrator for a
              new invitation.
            </p>
          ) : (
            <div className="mt-4 grid gap-2">
              {invitations.map((listedInvitation) => (
                <article
                  key={listedInvitation.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {listedInvitation.organizationName ?? "Inviting organization"}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {listedInvitation.targetEmail} · {listedInvitation.role}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={acceptingInvitationId !== null}
                    onClick={() => void acceptInvitation(listedInvitation)}
                  >
                    {acceptingInvitationId === listedInvitation.id ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : null}
                    Join organization
                  </Button>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>,
    );
  }

  if (createdSetup) {
    const live =
      liveModelAccess?.key === liveCheckKey &&
      liveModelAccess.workspaceId === createdSetup.personalWorkspaceId
        ? liveModelAccess
        : null;
    if (liveCheckKey && !live)
      return frame(
        <section className="flex flex-1 items-center justify-center" role="status">
          <Loader2Icon className="size-5 animate-spin text-fg-subtle" />
          <span className="sr-only">Checking your models</span>
        </section>,
      );
    const effectiveIncludedModel =
      includedModel !== undefined ? includedModel : (live?.includedModel ?? null);
    const effectiveStartingCredits =
      startingCredits !== undefined ? startingCredits : (live?.startingCredits ?? null);
    return frame(
      <ModelAccessOnboardingPanel
        client={client}
        organizationId={createdSetup.organizationId}
        workspaceId={createdSetup.personalWorkspaceId}
        billingMode={billingMode}
        codexEnabled={codexEnabled}
        supergrokEnabled={supergrokEnabled}
        includedModel={effectiveIncludedModel}
        startingCredits={effectiveStartingCredits}
        onComplete={onComplete}
      />,
    );
  }

  if (state === "unavailable") {
    return frame(
      <section className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-sm">
          <span className="mb-4 flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <LockKeyholeIcon className="size-4" />
          </span>
          <h1 className="text-base font-semibold">Organization access unavailable</h1>
          <p className="mt-2 text-sm leading-5 text-fg-subtle">
            Your previous organization access is no longer active. Ask an organization administrator
            for a new invitation before continuing.
          </p>
        </div>
      </section>,
    );
  }

  return frame(
    <section className="flex flex-1 items-center justify-center px-4">
      <form
        className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <Building2Icon className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">Create your organization</h1>
            <p className="text-sm text-fg-subtle">This is the company or team you work with.</p>
          </div>
        </div>
        <Label htmlFor="organization-onboarding-name">Organization name</Label>
        <Input
          id="organization-onboarding-name"
          value={organizationName}
          onChange={(event) => setOrganizationName(event.target.value)}
          autoComplete="organization"
          className="mt-2"
          autoFocus
        />
        <p className="mt-2 text-xs leading-4 text-fg-muted">
          You can create shared workspaces later from Organization settings.
        </p>
        <Button type="submit" className="mt-4 w-full" disabled={busy}>
          {busy ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <CheckIcon className="size-4" />
          )}
          Create organization
        </Button>
      </form>
    </section>,
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
    <header className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 px-4 pt-3 text-xs text-fg-muted">
      {email ? (
        <span className="min-w-0 truncate">
          Signed in as <span className="font-medium text-fg">{email}</span>
        </span>
      ) : null}
      {onUseAnotherAccount ? (
        <Button type="button" variant="ghost" size="sm" onClick={onUseAnotherAccount}>
          Use another account
        </Button>
      ) : null}
      {onSignOut ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void Promise.resolve()
              .then(onSignOut)
              .catch((error) =>
                toast.error("Sign out failed", {
                  description: error instanceof Error ? error.message : String(error),
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
          {onUseAnotherAccount ? "Sign out" : "Sign out or use another account"}
        </Button>
      ) : null}
    </header>
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
