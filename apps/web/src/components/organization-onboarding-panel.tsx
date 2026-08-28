import { Building2Icon, CheckIcon, LockKeyholeIcon, Loader2Icon, MailIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import {
  completeSelfServiceOrganizationSetup,
  getSelfServiceOrganizationOnboardingStatus,
  type SelfServiceOrganizationOnboardingState,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OrganizationInvitation } from "@/types";

export function OrganizationOnboardingPanel({
  onComplete,
  client,
  previewState,
}: {
  onComplete: () => void;
  client?: OpenGeniBrowserClient;
  previewState?: SelfServiceOrganizationOnboardingState;
}) {
  const [state, setState] = useState<SelfServiceOrganizationOnboardingState | null>(
    previewState ?? null,
  );
  const [organizationName, setOrganizationName] = useState("");
  const [busy, setBusy] = useState(false);
  const [invitations, setInvitations] = useState<OrganizationInvitation[]>([]);
  const [invitationLoading, setInvitationLoading] = useState(false);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [acceptingInvitationId, setAcceptingInvitationId] = useState<string | null>(null);
  const operationId = useRef(crypto.randomUUID());
  const invitationOperationIds = useRef(new Map<string, string>());

  useEffect(() => {
    if (previewState) return;
    let active = true;
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
        toast.error("Could not check organization setup", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      active = false;
    };
  }, [previewState, onComplete]);

  useEffect(() => {
    if (state !== "invitation_pending" || !client) return;
    let active = true;
    setInvitationLoading(true);
    setInvitationError(null);
    void client
      .listOrganizationInvitations({ limit: 100 })
      .then((result) => {
        if (!active) return;
        setInvitations(result.invitations.filter((invitation) => invitation.status === "pending"));
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
  }, [client, state]);

  async function acceptInvitation(invitation: OrganizationInvitation) {
    if (!client || acceptingInvitationId) return;
    const acceptedOperationId =
      invitationOperationIds.current.get(invitation.id) ?? crypto.randomUUID();
    invitationOperationIds.current.set(invitation.id, acceptedOperationId);
    setAcceptingInvitationId(invitation.id);
    setInvitationError(null);
    try {
      await client.acceptOrganizationInvitation(invitation.id, {
        expectedRevision: invitation.revision,
        operationId: acceptedOperationId,
      });
      invitationOperationIds.current.delete(invitation.id);
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
        await completeSelfServiceOrganizationSetup({
          organizationName: normalizedName,
          operationId: operationId.current,
        });
        onComplete();
      }
    } catch (error) {
      toast.error("Organization setup failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  if (state === null) {
    return (
      <section className="flex flex-1 items-center justify-center">
        <Loader2Icon className="size-5 animate-spin text-fg-subtle" />
      </section>
    );
  }

  if (state === "invitation_pending") {
    return (
      <section className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-5 shadow-sm">
          <span className="mb-4 flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <MailIcon className="size-4" />
          </span>
          <h1 className="text-base font-semibold">Invitation pending</h1>
          <p className="mt-2 text-sm leading-5 text-fg-subtle">
            Choose the organization you want to join. Accepting creates your own Personal workspace
            there and never grants access to another person's personal content.
          </p>
          {invitationLoading ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
              <Loader2Icon className="size-4 animate-spin" /> Loading invitations
            </p>
          ) : invitationError ? (
            <p role="alert" className="mt-4 text-sm text-danger">
              We couldn't update your invitations. {invitationError}
            </p>
          ) : invitations.length === 0 ? (
            <p className="mt-4 text-sm text-fg-muted">
              No pending invitation is available. Refresh the page or ask your administrator for a
              new invitation.
            </p>
          ) : (
            <div className="mt-4 grid gap-2">
              {invitations.map((invitation) => (
                <article
                  key={invitation.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {invitation.organizationName ?? "Inviting organization"}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {invitation.targetEmail} · {invitation.role}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={acceptingInvitationId !== null}
                    onClick={() => void acceptInvitation(invitation)}
                  >
                    {acceptingInvitationId === invitation.id ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : null}
                    Join organization
                  </Button>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    );
  }

  if (state === "unavailable") {
    return (
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
      </section>
    );
  }

  return (
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
    </section>
  );
}
