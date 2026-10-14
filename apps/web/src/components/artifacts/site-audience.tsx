import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { WorkspaceArtifact } from "@opengeni/sdk";
import { ChevronDownIcon, Loader2Icon, LockKeyholeIcon, UsersIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { userErrorText } from "@/lib/api-error";

type Audience = "private" | "workspace";

/**
 * Whether this person may make something Only me here, from the same answer
 * the chat composer uses. Unknown fails closed: Limit to me is never offered
 * on a guess, because the server refuses it when Only me is off.
 */
function useCanLimitToMe(client: OpenGeniBrowserClient, workspaceId: string, enabled: boolean) {
  const [canLimit, setCanLimit] = useState(false);
  useEffect(() => {
    setCanLimit(false);
    if (!enabled) return;
    let current = true;
    void client
      .getSessionTenancyCreateCapabilities(workspaceId)
      .then((capabilities) => {
        if (current) setCanLimit(capabilities.canCreatePrivate === true);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, enabled, workspaceId]);
  return canLimit;
}

/**
 * A Site's audience on its page, in the same words and shape as a chat's:
 * a chip saying who can see it ("Only me" or "Workspace") that opens the
 * owner's choices, and, while the Site is Only me, a clear "Share with
 * workspace" button. Every change is confirmed first. Only the owner can
 * change it; everyone else just sees the chip.
 */
export function useSiteAudience({
  client,
  workspaceId,
  workspaceName,
  artifact,
  ownedByCurrentUser,
  onChanged,
}: {
  client: OpenGeniBrowserClient;
  workspaceId: string;
  workspaceName: string;
  artifact: WorkspaceArtifact;
  /** The viewer owns the Site and may publish in this workspace. */
  ownedByCurrentUser: boolean;
  onChanged: (artifact: WorkspaceArtifact) => void;
}): {
  chip: ReactNode;
  shareButton: ReactNode;
  dialog: ReactNode;
  /** Opens the Share with workspace confirmation, while the owner's Site is Only me. */
  share: (() => void) | undefined;
} {
  const audience: Audience = artifact.visibility === "private" ? "private" : "workspace";
  const onlyMe = audience === "private";
  const canLimitToMe = useCanLimitToMe(client, workspaceId, ownedByCurrentUser && !onlyMe);
  const [confirming, setConfirming] = useState<Audience | null>(null);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const label = onlyMe ? "Only me" : "Workspace";
  const description = onlyMe
    ? "Only you can see and open this Site."
    : `Everyone in ${workspaceName} can see and open this Site.`;

  const change = async (visibility: Audience): Promise<boolean> => {
    setBusy(true);
    try {
      const response = await client.updateWorkspaceArtifactVisibility(workspaceId, artifact.id, {
        visibility,
      });
      onChanged(response.artifact);
      toast.success(
        visibility === "workspace" ? "Site shared with workspace" : "Site limited to you",
        {
          description:
            visibility === "workspace"
              ? `Everyone in ${workspaceName} can now open it.`
              : "Only you can see it now.",
        },
      );
      return true;
    } catch (error) {
      toast.error(
        visibility === "workspace" ? "Couldn't share Site" : "Couldn't limit Site to you",
        { description: userErrorText(error) },
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const chipFace = (
    <span className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-border bg-surface/55 px-2.5 text-xs font-medium text-fg pointer-coarse:h-11">
      {busy ? (
        <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : onlyMe ? (
        <LockKeyholeIcon className="size-3.5 shrink-0 text-brand" aria-hidden />
      ) : (
        <UsersIcon className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
      )}
      {busy ? "Updating" : label}
      {ownedByCurrentUser && !busy ? (
        <ChevronDownIcon className="size-3.5 text-fg-muted" aria-hidden />
      ) : null}
    </span>
  );

  const chip = ownedByCurrentUser ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={busy}>
        <button
          ref={triggerRef}
          type="button"
          aria-label={`Who can see this Site: ${label}. Change who can see it`}
          aria-busy={busy}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {chipFace}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <div className="px-2.5 py-1.5">
          <p className="text-sm font-medium text-fg">{label}</p>
          <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">{description}</p>
        </div>
        <DropdownMenuSeparator />
        {onlyMe ? (
          <DropdownMenuItem onSelect={() => setConfirming("workspace")}>
            <UsersIcon />
            Share with workspace…
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={!canLimitToMe} onSelect={() => setConfirming("private")}>
            <LockKeyholeIcon />
            <span className="flex min-w-0 flex-col">
              Limit to me…
              {!canLimitToMe ? (
                <span className="text-xs text-fg-muted">
                  Only me is turned off for this organization.
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={`Who can see this Site: ${label}. ${description}`}>
            {chipFace}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  const shareButton =
    ownedByCurrentUser && onlyMe ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => setConfirming("workspace")}
        // Beside Edit and ⋯ on a phone, only the icon fits; the name stays.
        title="Share with workspace"
        className="rounded-[10px] pointer-coarse:h-11 max-sm:px-2.5 pointer-coarse:max-sm:w-11"
      >
        <UsersIcon aria-hidden="true" />
        <span className="max-sm:sr-only">Share with workspace</span>
      </Button>
    ) : null;

  const dialog = (
    <ConfirmDialog
      open={confirming !== null}
      onOpenChange={(open) => {
        if (!open) setConfirming(null);
      }}
      title={
        confirming === "workspace"
          ? `Share “${artifact.title}” with ${workspaceName}?`
          : `Limit “${artifact.title}” to you?`
      }
      description={
        confirming === "workspace"
          ? `Everyone in ${workspaceName} will be able to open this Site and see its versions. The chat it was made in keeps its own audience.`
          : "Only you will be able to see or open this Site. Other people in the workspace lose access to it."
      }
      confirmLabel={confirming === "workspace" ? "Share with workspace" : "Limit to me"}
      // Like a chat, sharing widens who can see it; limiting it does not.
      destructive={confirming === "workspace"}
      cancelAutoFocus
      restoreFocusRef={triggerRef}
      onConfirm={() => (confirming ? change(confirming) : true)}
    />
  );

  return {
    chip,
    shareButton,
    dialog,
    share: ownedByCurrentUser && onlyMe ? () => setConfirming("workspace") : undefined,
  };
}
