import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OrganizationInvitation } from "@/types";

function mutationOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { outcomeUnknown?: unknown }).outcomeUnknown === true
  );
}

export function ManagedWorkspaceOnboardingPanel(props: {
  client: OpenGeniCoreClient;
  onAccessChanged: () => void;
  onOpenWorkspace: (workspaceId: string) => Promise<void>;
}) {
  const [invitations, setInvitations] = useState<OrganizationInvitation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState("");
  const [creating, setCreating] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const createAttemptRef = useRef<{ name: string; operationId: string } | null>(null);
  const acceptAttemptsRef = useRef(new Map<string, string>());

  const loadInvitations = useCallback(async () => {
    setLoadError(null);
    try {
      const page = await props.client.listOrganizationInvitations({ limit: 50 });
      setInvitations(page.invitations.filter((invitation) => invitation.status === "pending"));
    } catch (error) {
      setInvitations([]);
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [props.client]);

  useEffect(() => {
    void loadInvitations();
  }, [loadInvitations]);

  async function createOrganization() {
    const name = organizationName.trim();
    if (!name || creating) return;
    const current = createAttemptRef.current;
    const attempt = current?.name === name ? current : { name, operationId: crypto.randomUUID() };
    createAttemptRef.current = attempt;
    setCreating(true);
    try {
      const created = await props.client.createOrganization({
        name: attempt.name,
        operationId: attempt.operationId,
      });
      createAttemptRef.current = null;
      props.onAccessChanged();
      toast.success(`${created.organization.name} created`);
      await props.onOpenWorkspace(created.workspaceId);
    } catch (error) {
      const outcomeUnknown = mutationOutcomeUnknown(error);
      if (!outcomeUnknown) createAttemptRef.current = null;
      toast.error("Couldn't create organization", {
        description: outcomeUnknown
          ? "The result is not known yet. Retry to safely reconcile the same request."
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      setCreating(false);
    }
  }

  async function acceptInvitation(invitation: OrganizationInvitation) {
    if (acceptingId) return;
    const operationId = acceptAttemptsRef.current.get(invitation.id) ?? crypto.randomUUID();
    acceptAttemptsRef.current.set(invitation.id, operationId);
    setAcceptingId(invitation.id);
    try {
      const accepted = await props.client.acceptOrganizationInvitation(invitation.id, {
        expectedRevision: invitation.revision,
        operationId,
      });
      acceptAttemptsRef.current.delete(invitation.id);
      setInvitations((current) => current?.filter((item) => item.id !== invitation.id) ?? []);
      props.onAccessChanged();
      toast.success("Organization invitation accepted");
      if (accepted.membership.personalWorkspaceId) {
        await props.onOpenWorkspace(accepted.membership.personalWorkspaceId);
      }
    } catch (error) {
      if (!mutationOutcomeUnknown(error)) acceptAttemptsRef.current.delete(invitation.id);
      toast.error("Couldn't accept invitation", {
        description: mutationOutcomeUnknown(error)
          ? "The result is not known yet. Retry to safely reconcile the same request."
          : error instanceof Error
            ? error.message
            : String(error),
      });
      if (!mutationOutcomeUnknown(error)) await loadInvitations();
    } finally {
      setAcceptingId(null);
    }
  }

  return (
    <section className="flex flex-1 items-center justify-center overflow-auto px-4 py-8">
      <div className="grid w-full max-w-2xl gap-4">
        <div>
          <h1 className="text-xl font-semibold">Set up your OpenGeni workspace</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Join a team that invited you, or create a new organization for your own team.
          </p>
        </div>

        <section className="grid gap-3 rounded-lg border border-border bg-surface p-4">
          <div>
            <h2 className="text-sm font-medium">Your invitations</h2>
            <p className="mt-1 text-xs text-fg-muted">
              Accepting an invitation adds your personal workspace in that organization. Shared
              workspace access is assigned separately by an administrator.
            </p>
          </div>
          {invitations === null ? (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2Icon className="size-4 animate-spin" /> Checking invitations…
            </div>
          ) : loadError ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-status-failed/30 bg-status-failed/[0.06] p-3">
              <div>
                <p className="text-sm font-medium">Couldn't load invitations</p>
                <p className="mt-0.5 text-sm text-fg-muted">{loadError}</p>
              </div>
              <Button type="button" variant="secondary" size="sm" onClick={loadInvitations}>
                <RefreshCwIcon className="size-3.5" /> Retry
              </Button>
            </div>
          ) : invitations.length === 0 ? (
            <p className="text-sm text-fg-muted">You have no pending invitations.</p>
          ) : (
            <div className="grid gap-2">
              {invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div>
                    <p className="text-sm font-medium">Organization invitation</p>
                    <p className="text-xs text-fg-muted">
                      {invitation.role} · {invitation.organizationId.slice(0, 8)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={acceptingId !== null}
                    onClick={() => void acceptInvitation(invitation)}
                  >
                    {acceptingId === invitation.id ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : null}
                    Accept
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="grid gap-3 rounded-lg border border-border bg-surface p-4">
          <div>
            <h2 className="text-sm font-medium">Create an organization</h2>
            <p className="mt-1 text-xs text-fg-muted">
              You'll be the owner and can invite people, create shared workspaces, and manage
              access.
            </p>
          </div>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void createOrganization();
            }}
          >
            <Input
              aria-label="Organization name"
              placeholder="Organization name"
              value={organizationName}
              onChange={(event) => setOrganizationName(event.target.value)}
              maxLength={120}
              autoFocus
            />
            <Button type="submit" disabled={!organizationName.trim() || creating}>
              {creating ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Create organization
            </Button>
          </form>
        </section>
      </div>
    </section>
  );
}
