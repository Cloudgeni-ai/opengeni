import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Loader2Icon, MailIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Notice } from "@/components/ui/notice";
import { isOrganizationConflict } from "@/lib/organization-admin";
import {
  clearOrganizationInvitationContinuation,
  readOrganizationInvitationContinuation,
  type OrganizationInvitationContinuation,
} from "@/lib/organization-invitation-continuation";
import { cn } from "@/lib/utils";
import type { OrganizationInvitation } from "@/types";

export type OrganizationInvitationsController = {
  open: boolean;
  invitations: OrganizationInvitation[];
  pendingCount: number;
  loaded: boolean;
  loading: boolean;
  error: Error | null;
  acceptingInvitationId: string | null;
  announcement: string;
  continuation: (OrganizationInvitationContinuation & { invitationId: string | null }) | null;
  openDialog: () => void;
  setOpen: (open: boolean) => void;
  reload: () => Promise<void>;
  accept: (invitation: OrganizationInvitation) => Promise<void>;
};

export function useOrganizationInvitations(input: {
  client: OpenGeniBrowserClient;
  enabled: boolean;
  onAccepted: () => void;
}): OrganizationInvitationsController {
  const { client, enabled, onAccepted } = input;
  const [open, setOpen] = useState(false);
  const [invitations, setInvitations] = useState<OrganizationInvitation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [acceptingInvitationId, setAcceptingInvitationId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [continuation, setContinuation] = useState<
    (OrganizationInvitationContinuation & { invitationId: string | null }) | null
  >(null);
  const readSequence = useRef(0);
  const activeClient = useRef(client);
  const operationIds = useRef(new Map<string, string>());
  const pendingContinuation = useRef<OrganizationInvitationContinuation | null>(null);
  activeClient.current = client;

  const reload = useCallback(async () => {
    if (!enabled) return;
    const acceptedClient = client;
    const sequence = ++readSequence.current;
    setLoading(true);
    setError(null);
    try {
      const listedInvitations: OrganizationInvitation[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await acceptedClient.listOrganizationInvitations({
          ...(cursor === undefined ? {} : { cursor }),
          limit: 100,
        });
        if (activeClient.current !== acceptedClient || readSequence.current !== sequence) return;
        listedInvitations.push(...result.invitations);
        const nextCursor = result.nextCursor ?? undefined;
        if (nextCursor !== undefined && seenCursors.has(nextCursor)) {
          throw new Error("Organization invitation pagination did not advance");
        }
        if (nextCursor !== undefined) seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor !== undefined);
      const pendingInvitations = listedInvitations.filter(
        (invitation) => invitation.status === "pending",
      );
      setInvitations(pendingInvitations);
      const requestedContinuation = pendingContinuation.current;
      if (requestedContinuation) {
        pendingContinuation.current = null;
        const matchingInvitation = pendingInvitations.find(
          (invitation) =>
            invitation.organizationId === requestedContinuation.organizationId &&
            normalizeInvitationEmail(invitation.targetEmail) ===
              normalizeInvitationEmail(requestedContinuation.targetEmail),
        );
        setContinuation({
          ...requestedContinuation,
          invitationId: matchingInvitation?.id ?? null,
        });
        clearOrganizationInvitationContinuation();
        setOpen(true);
      }
      setLoaded(true);
    } catch (caught) {
      if (activeClient.current !== acceptedClient || readSequence.current !== sequence) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
      setLoaded(true);
    } finally {
      if (activeClient.current === acceptedClient && readSequence.current === sequence) {
        setLoading(false);
      }
    }
  }, [client, enabled]);

  useEffect(() => {
    operationIds.current.clear();
    setOpen(false);
    setInvitations([]);
    setLoaded(false);
    setLoading(false);
    setError(null);
    setAcceptingInvitationId(null);
    setAnnouncement("");
    setContinuation(null);
    pendingContinuation.current = enabled ? readOrganizationInvitationContinuation() : null;
    if (enabled) void reload();
    return () => {
      readSequence.current += 1;
    };
  }, [client, enabled, reload]);

  const openDialog = useCallback(() => {
    pendingContinuation.current = null;
    clearOrganizationInvitationContinuation();
    setContinuation(null);
    setOpen(true);
    void reload();
  }, [reload]);

  const changeOpen = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setContinuation(null);
  }, []);

  const accept = useCallback(
    async (invitation: OrganizationInvitation) => {
      if (!enabled || acceptingInvitationId !== null) return;
      const acceptedClient = client;
      const operationId = operationIds.current.get(invitation.id) ?? crypto.randomUUID();
      operationIds.current.set(invitation.id, operationId);
      setAcceptingInvitationId(invitation.id);
      setError(null);
      try {
        await acceptedClient.acceptOrganizationInvitation(invitation.id, {
          expectedRevision: invitation.revision,
          operationId,
        });
        if (activeClient.current !== acceptedClient) return;
        operationIds.current.delete(invitation.id);
        setInvitations((current) => current.filter((candidate) => candidate.id !== invitation.id));
        const organizationName = invitation.organizationName ?? "the organization";
        setAnnouncement(`Joined ${organizationName}.`);
        toast.success(`Joined ${organizationName}`);
        if (continuation?.invitationId === invitation.id) {
          setContinuation(null);
          setOpen(false);
        }
        onAccepted();
      } catch (caught) {
        if (activeClient.current !== acceptedClient) return;
        if (isOrganizationConflict(caught)) {
          operationIds.current.delete(invitation.id);
          toast.error("Invitation state changed", {
            description: "Your invitations were refreshed. Review them before trying again.",
          });
          await reload();
          return;
        }
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        if (activeClient.current === acceptedClient) setAcceptingInvitationId(null);
      }
    },
    [acceptingInvitationId, client, continuation?.invitationId, enabled, onAccepted, reload],
  );

  return {
    open,
    invitations,
    pendingCount: invitations.length,
    loaded,
    loading,
    error,
    acceptingInvitationId,
    announcement,
    continuation,
    openDialog,
    setOpen: changeOpen,
    reload,
    accept,
  };
}

export function OrganizationInvitationsMenuItem(props: {
  controller: OrganizationInvitationsController;
  className?: string;
  disabled?: boolean;
}) {
  const { controller } = props;
  const accessibleLabel =
    controller.pendingCount > 0
      ? `Organization invitations, ${controller.pendingCount} pending`
      : "Organization invitations";
  return (
    <DropdownMenuItem
      className={props.className}
      aria-label={accessibleLabel}
      disabled={props.disabled}
      onSelect={controller.openDialog}
    >
      <MailIcon
        className={cn("size-4", controller.pendingCount > 0 && "text-brand!")}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">Organization invitations</span>
      {controller.loading && !controller.loaded ? (
        <Loader2Icon
          className="size-3.5 animate-spin text-fg-subtle motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : controller.pendingCount > 0 ? (
        <Badge variant="secondary" className="min-w-5 px-1.5 py-0 text-2xs tabular-nums">
          {controller.pendingCount}
        </Badge>
      ) : null}
    </DropdownMenuItem>
  );
}

export function OrganizationInvitationsDialog(props: {
  controller: OrganizationInvitationsController;
}) {
  const { controller } = props;
  const focusedInvitation = controller.continuation?.invitationId
    ? (controller.invitations.find(
        (invitation) => invitation.id === controller.continuation?.invitationId,
      ) ?? null)
    : null;
  const displayedInvitations = controller.continuation
    ? focusedInvitation
      ? [focusedInvitation]
      : []
    : controller.invitations;
  return (
    <Dialog open={controller.open} onOpenChange={controller.setOpen}>
      <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {focusedInvitation
              ? `Join ${focusedInvitation.organizationName ?? "organization"}`
              : controller.continuation
                ? `Invitation to ${controller.continuation.organizationName}`
                : "Organization invitations"}
          </DialogTitle>
          <DialogDescription>
            {focusedInvitation
              ? "You're signed in. Accept the invitation below to finish joining."
              : controller.continuation
                ? "You're signed in, but this invitation isn't available for this account."
                : "Review invitations for this signed-in account. Joining adds the listed organization and shared workspace access; it never shares anyone's Personal workspace."}
          </DialogDescription>
        </DialogHeader>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {controller.announcement}
        </span>
        <div className="min-h-0 overflow-y-auto pr-1">
          {controller.error ? (
            <Notice
              tone="failed"
              title="Could not update invitations"
              action={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={controller.loading || controller.acceptingInvitationId !== null}
                  onClick={() => void controller.reload()}
                >
                  <RefreshCwIcon className="size-4" />
                  Try again
                </Button>
              }
            >
              No invitation was accepted. Check your connection and try again.
            </Notice>
          ) : null}

          {controller.continuation && !focusedInvitation && controller.loaded ? (
            <Notice tone="info" title="This invitation is no longer pending" className="mb-3">
              The invitation to {controller.continuation.organizationName} may already have been
              accepted, revoked, or opened with a different account.
            </Notice>
          ) : null}

          {controller.loading && !controller.loaded ? (
            <p role="status" className="flex items-center gap-2 py-6 text-sm text-fg-muted">
              <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
              Loading invitations…
            </p>
          ) : controller.continuation && !focusedInvitation ? null : controller.loaded &&
            displayedInvitations.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
              <p className="text-sm font-medium text-fg">No pending invitations</p>
              <p className="mt-1 text-xs text-fg-muted">
                New organization invitations will appear here for the selected account.
              </p>
            </div>
          ) : (
            <div className="grid gap-2">
              {displayedInvitations.map((invitation) => {
                const organizationName = invitation.organizationName ?? "Inviting organization";
                const sharedWorkspaceCount = invitation.initialWorkspaceIds.length;
                return (
                  <article
                    key={invitation.id}
                    className="grid gap-3 rounded-lg border border-border bg-surface/40 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">{organizationName}</p>
                      <p className="mt-1 text-xs text-fg-muted">
                        {invitation.targetEmail} · {titleCase(invitation.role)}
                      </p>
                      <p className="mt-1 text-xs text-fg-subtle">
                        {sharedWorkspaceCount === 0
                          ? "No shared workspaces assigned yet"
                          : `${sharedWorkspaceCount} shared workspace${sharedWorkspaceCount === 1 ? "" : "s"} included`}
                        {" · Expires "}
                        <time dateTime={invitation.expiresAt}>
                          {formatInvitationDate(invitation.expiresAt)}
                        </time>
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="w-full sm:w-auto"
                      aria-label={`Accept invitation to ${organizationName}`}
                      disabled={controller.acceptingInvitationId !== null || controller.loading}
                      onClick={() => void controller.accept(invitation)}
                    >
                      {controller.acceptingInvitationId === invitation.id ? (
                        <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
                      ) : null}
                      Accept invitation
                    </Button>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function normalizeInvitationEmail(value: string): string {
  return value.trim().toLowerCase();
}

function formatInvitationDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
