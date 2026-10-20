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

export type Audience = "private" | "workspace";

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

/** The words an audience control uses for one kind of thing. */
type AudienceCopy = {
  /** "Site" or "file", as it reads mid-sentence. */
  noun: string;
  /** Capitalized noun for toast titles: "Site", "File". */
  Noun: string;
  onlyMeDescription: string;
  workspaceDescription: (workspaceName: string) => string;
  shareConfirm: (workspaceName: string) => string;
  limitConfirm: string;
  /** "Who can see this Site", "Who can open this file". */
  whoCan: string;
  changeLabel: string;
  limitedToast: string;
};

const SITE_COPY: AudienceCopy = {
  noun: "Site",
  Noun: "Site",
  onlyMeDescription: "Only you can see and open this Site.",
  workspaceDescription: (workspaceName) =>
    `Everyone in ${workspaceName} can see and open this Site.`,
  shareConfirm: (workspaceName) =>
    `Everyone in ${workspaceName} will be able to open this Site and see its versions. The chat it was made in keeps its own audience.`,
  limitConfirm:
    "Only you will be able to see or open this Site. Other people in the workspace lose access to it.",
  whoCan: "Who can see this Site",
  changeLabel: "Change who can see it",
  limitedToast: "Only you can see it now.",
};

export const FILE_AUDIENCE_COPY: AudienceCopy = {
  noun: "file",
  Noun: "File",
  onlyMeDescription: "Only you can open this file.",
  workspaceDescription: (workspaceName) => `Everyone in ${workspaceName} can open this file.`,
  shareConfirm: (workspaceName) =>
    `Everyone in ${workspaceName} will be able to open this file from its link. The chat it came from keeps its own audience.`,
  limitConfirm:
    "Only you will be able to open this file. Other people in the workspace lose access to it, and its link stops working for them.",
  whoCan: "Who can open this file",
  changeLabel: "Change who can open it",
  limitedToast: "Only you can open it now.",
};

export type AudienceControls = {
  chip: ReactNode;
  shareButton: ReactNode;
  dialog: ReactNode;
  /** Opens the Share with workspace confirmation, while the owner's item is Only me. */
  share: (() => void) | undefined;
  /** Opens the Limit to me confirmation, while the owner's item is shared and Only me is allowed. */
  limit: (() => void) | undefined;
};

/**
 * An item's audience on its page, in the same words and shape as a chat's:
 * a chip saying who can see it ("Only me" or "Workspace") that opens the
 * owner's choices, and, while it is Only me, a clear "Share with workspace"
 * button. Every change is confirmed first. Only the owner can change it;
 * everyone else just sees the chip.
 */
export function useArtifactAudience({
  client,
  workspaceId,
  workspaceName,
  title,
  visibility,
  ownedByCurrentUser,
  copy,
  update,
  canLimitToMe: knownCanLimitToMe,
}: {
  client: OpenGeniBrowserClient;
  workspaceId: string;
  workspaceName: string;
  title: string;
  visibility: Audience;
  /** The viewer owns the item and may change it in this workspace. */
  ownedByCurrentUser: boolean;
  copy: AudienceCopy;
  /** Applies the change; throws when the server refuses it. */
  update: (visibility: Audience) => Promise<void>;
  /**
   * Skip asking whether Only me is allowed (lists, where every row would
   * ask) and offer Limit to me; the server still refuses it when it is off.
   */
  canLimitToMe?: boolean;
}): AudienceControls {
  const onlyMe = visibility === "private";
  const fetchedCanLimitToMe = useCanLimitToMe(
    client,
    workspaceId,
    knownCanLimitToMe === undefined && ownedByCurrentUser && !onlyMe,
  );
  const canLimitToMe = knownCanLimitToMe ?? fetchedCanLimitToMe;
  const [confirming, setConfirming] = useState<Audience | null>(null);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const label = onlyMe ? "Only me" : "Workspace";
  const description = onlyMe ? copy.onlyMeDescription : copy.workspaceDescription(workspaceName);

  const change = async (next: Audience): Promise<boolean> => {
    setBusy(true);
    try {
      await update(next);
      toast.success(
        next === "workspace" ? `${copy.Noun} shared with workspace` : `${copy.Noun} limited to you`,
        {
          description:
            next === "workspace"
              ? `Everyone in ${workspaceName} can now open it.`
              : copy.limitedToast,
        },
      );
      return true;
    } catch (error) {
      toast.error(
        next === "workspace" ? `Couldn't share ${copy.noun}` : `Couldn't limit ${copy.noun} to you`,
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
          aria-label={`${copy.whoCan}: ${label}. ${copy.changeLabel}`}
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
          <span tabIndex={0} aria-label={`${copy.whoCan}: ${label}. ${description}`}>
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
        // Beside the other actions on a phone, only the icon fits; the name stays.
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
          ? `Share “${title}” with ${workspaceName}?`
          : `Limit “${title}” to you?`
      }
      description={
        confirming === "workspace" ? copy.shareConfirm(workspaceName) : copy.limitConfirm
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
    limit:
      ownedByCurrentUser && !onlyMe && canLimitToMe ? () => setConfirming("private") : undefined,
  };
}

/**
 * A Site's audience on its page, in the same words and shape as a chat's.
 * Only the owner can change it; everyone else just sees the chip.
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
}): AudienceControls {
  return useArtifactAudience({
    client,
    workspaceId,
    workspaceName,
    title: artifact.title,
    visibility: artifact.visibility === "private" ? "private" : "workspace",
    ownedByCurrentUser,
    copy: SITE_COPY,
    update: async (visibility) => {
      const response = await client.updateWorkspaceArtifactVisibility(workspaceId, artifact.id, {
        visibility,
      });
      onChanged(response.artifact);
    },
  });
}
