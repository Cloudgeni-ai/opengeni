import { Link } from "@tanstack/react-router";
import { UserIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type {
  ChangeMachineAudienceRequest,
  ChangeMachineAudienceResponse,
  MachineAudience,
  MachineAudienceItem,
  MachineAudiencePreview,
  MachineAudiencePreviewRequest,
  MachineAudienceSummary,
  MachineView,
  WorkspaceMember,
} from "@opengeni/sdk";

import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, FieldStack } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { Notice } from "@/components/ui/notice";
import { SelectMenu } from "@/components/ui/select-menu";
import { isPermissionDenied, userErrorText } from "@/lib/api-error";

/** The slice of the SDK client this dialog uses. */
export type MachineAudienceClient = {
  previewMachineAudience: (
    workspaceId: string,
    enrollmentId: string,
    input: MachineAudiencePreviewRequest,
  ) => Promise<MachineAudiencePreview>;
  changeMachineAudience: (
    workspaceId: string,
    enrollmentId: string,
    input: ChangeMachineAudienceRequest,
  ) => Promise<ChangeMachineAudienceResponse>;
  listWorkspaceMembers: (workspaceId: string) => Promise<WorkspaceMember[]>;
};

export interface MachineAudienceDialogProps {
  client: MachineAudienceClient;
  workspaceId: string;
  machine: MachineView & { enrollmentId: string };
  /** The signed-in person. */
  subjectId: string;
  /** Workspace admins can share a machine and pick another owner. */
  workspaceAdmin: boolean;
  /** A personal workspace has nobody else to share with. */
  personalWorkspace?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the change is applied. */
  onChanged?: (result: ChangeMachineAudienceResponse) => void;
}

function currentAudience(machine: MachineView): MachineAudience {
  return machine.scope === "user" ? "only_me" : "workspace";
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Plain sentences for what one confirmation does. `who` is "you" or the new
 * owner's name.
 */
export function machineAudienceSummaryLines(
  summary: MachineAudienceSummary,
  target: MachineAudience,
  who: { you: boolean; name: string },
): string[] {
  const owner = who.you ? "Your" : `${who.name}'s`;
  const runner = who.you ? "only you" : `only ${who.name}`;
  const lines: string[] = [];
  const kept = summary.keptChats + summary.keptSharedChats;
  const shared = summary.keptSharedChats;
  if (target === "only_me") {
    if (kept > 0) {
      const sharedLine =
        shared === 0
          ? ""
          : shared === kept
            ? ` ${kept === 1 ? "It stays" : "They stay"} shared; ${runner} can run ${kept === 1 ? "it" : "them"} on this machine.`
            : ` ${shared === 1 ? "The shared one stays" : `The ${shared} shared ones stay`} shared; ${runner} can run ${shared === 1 ? "it" : "them"} on this machine.`;
      lines.push(
        (kept === 1
          ? `${owner} chat on it keeps working.`
          : `${owner} ${kept} chats on it keep working.`) + sharedLine,
      );
    }
    if (summary.movedOffChats > 0) {
      lines.push(
        summary.movedOffChats === 1
          ? "1 chat from someone else moves off it. Its history stays; its next turn needs another machine."
          : `${summary.movedOffChats} chats from other people move off it. Their history stays; their next turns need another machine.`,
      );
    }
  } else if (summary.movedOffChats > 0) {
    lines.push(
      `${count(summary.movedOffChats, "chat", "chats")} in other workspaces ${summary.movedOffChats === 1 ? "moves" : "move"} off it. A workspace machine only serves this workspace.`,
    );
  }
  if (summary.stoppedTurns > 0) {
    lines.push(
      target === "only_me"
        ? summary.stoppedTurns === 1
          ? "1 running turn someone else started stops now."
          : `${summary.stoppedTurns} running turns other people started stop now.`
        : `${count(summary.stoppedTurns, "running turn stops", "running turns stop")} now.`,
    );
  }
  if (summary.stoppedCommands > 0) {
    lines.push(
      `${count(summary.stoppedCommands, "agent command", "agent commands")} running in those chats ${summary.stoppedCommands === 1 ? "stops" : "stop"}.`,
    );
  }
  if (summary.schedulesMadeOnlyMe > 0) {
    lines.push(
      summary.schedulesMadeOnlyMe === 1
        ? `${owner} Workspace schedule on it becomes Only me.`
        : `${owner} ${summary.schedulesMadeOnlyMe} Workspace schedules on it become Only me.`,
    );
  }
  if (summary.schedulesPaused > 0) {
    lines.push(
      `${count(summary.schedulesPaused, "schedule pauses", "schedules pause")}. Resume ${summary.schedulesPaused === 1 ? "it" : "them"} after choosing another machine.`,
    );
  }
  if (summary.notifiedPeople > 0) {
    lines.push(
      `${count(summary.notifiedPeople, "person gets", "people get")} a notice in their inbox saying what changed.`,
    );
  }
  return lines;
}

function itemOutcome(item: MachineAudienceItem): string {
  const parts: string[] = [];
  switch (item.action) {
    case "move_off":
      parts.push("Moves off this machine");
      break;
    case "keep":
      parts.push(
        item.visibility === "workspace_shared" ? "Stays here, still shared" : "Stays here",
      );
      break;
    case "make_only_me":
      parts.push("Becomes Only me");
      break;
    case "pause":
      parts.push("Pauses");
      break;
    case "remove_first":
      parts.push("Remove this copy first");
      break;
  }
  if (item.stopsTurn) parts.push("its running turn stops");
  if (item.stopsCommands > 0) {
    parts.push(count(item.stopsCommands, "command stops", "commands stop"));
  }
  if (item.relation === "other_workspace") parts.push("in another workspace");
  return parts.join(" · ");
}

function itemTitle(item: MachineAudienceItem): string {
  const title = item.title?.trim();
  if (title) return title;
  return item.kind === "schedule" ? "Someone's private schedule" : "Someone's private chat";
}

function ItemRow({ item, workspaceId }: { item: MachineAudienceItem; workspaceId: string }) {
  const title = itemTitle(item);
  const params = { workspaceId: item.workspaceId ?? workspaceId };
  const link =
    item.title && item.kind === "chat" && item.sessionId ? (
      <Link
        to="/workspaces/$workspaceId/sessions/$sessionId"
        params={{ ...params, sessionId: item.sessionId }}
        className="block truncate text-sm font-medium text-fg underline decoration-border-strong underline-offset-2 hover:text-brand"
      >
        {title}
      </Link>
    ) : item.title && item.kind === "schedule" && item.scheduledTaskId ? (
      <Link
        to="/workspaces/$workspaceId/schedules/$scheduleId"
        params={{ ...params, scheduleId: item.scheduledTaskId }}
        className="block truncate text-sm font-medium text-fg underline decoration-border-strong underline-offset-2 hover:text-brand"
      >
        {title}
      </Link>
    ) : (
      <span className="block truncate text-sm font-medium text-fg">{title}</span>
    );
  return (
    <li className="flex min-w-0 flex-col gap-0.5 py-2.5">
      {link}
      <span className="text-xs leading-4.5 text-fg-muted">
        {item.kind === "schedule" ? "Schedule · " : "Chat · "}
        {itemOutcome(item)}
      </span>
    </li>
  );
}

/**
 * "Who can use it?" for one connected machine: pick Workspace or Only me, read
 * what the change does, and confirm once. The machine keeps its ID and
 * connection; the owner's running work carries on.
 */
export function MachineAudienceDialog({
  client,
  workspaceId,
  machine,
  subjectId,
  workspaceAdmin,
  personalWorkspace = false,
  open,
  onOpenChange,
  onChanged,
}: MachineAudienceDialogProps) {
  const current = currentAudience(machine);
  const [target, setTarget] = useState<MachineAudience>(
    current === "workspace" ? "only_me" : "workspace",
  );
  const [ownerSubjectId, setOwnerSubjectId] = useState(subjectId);
  const [refreshTick, setRefreshTick] = useState(0);
  const [preview, setPreview] = useState<MachineAudiencePreview | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);

  const changing = target !== current;
  const sharingNeedsAdmin = changing && target === "workspace" && !workspaceAdmin;
  const pickOwner = changing && target === "only_me" && workspaceAdmin && !personalWorkspace;

  // Admins can make the machine someone else's: list the workspace's people.
  useEffect(() => {
    if (!open || !workspaceAdmin || personalWorkspace) return;
    let active = true;
    client
      .listWorkspaceMembers(workspaceId)
      .then((list) => {
        if (active) setMembers(list);
      })
      .catch(() => {
        if (active) setMembers([]);
      });
    return () => {
      active = false;
    };
  }, [client, open, personalWorkspace, workspaceAdmin, workspaceId]);

  // The summary follows the choices, so it always shows what will happen.
  useEffect(() => {
    if (!open || !changing || sharingNeedsAdmin) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let active = true;
    setPreviewLoading(true);
    client
      .previewMachineAudience(workspaceId, machine.enrollmentId, {
        audience: target,
        ...(target === "only_me" && ownerSubjectId !== subjectId ? { ownerSubjectId } : {}),
      })
      .then((next) => {
        if (!active) return;
        setPreview(next);
        setPreviewError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPreview(null);
        setPreviewError(error);
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    changing,
    client,
    machine.enrollmentId,
    open,
    ownerSubjectId,
    refreshTick,
    sharingNeedsAdmin,
    subjectId,
    target,
    workspaceId,
  ]);

  const ownerOptions = useMemo(() => {
    const others = (members ?? [])
      .filter((member) => member.subjectId !== subjectId)
      .map((member) => ({
        value: member.subjectId,
        label: member.subjectLabel?.trim() || "Workspace member",
      }));
    return [{ value: subjectId, label: "You" }, ...others];
  }, [members, subjectId]);
  const ownerName =
    ownerOptions.find((option) => option.value === ownerSubjectId)?.label ?? "the new owner";

  const items = preview?.items ?? [];
  const duplicates = items.filter((item) => item.kind === "duplicate_connection");
  const listed = items.filter((item) => item.kind !== "duplicate_connection");
  const lines = preview
    ? machineAudienceSummaryLines(preview.summary, target, {
        you: ownerSubjectId === subjectId,
        name: ownerName,
      })
    : [];
  const ready = changing && preview?.ready === true && !previewLoading;
  const breaksWork = (preview?.summary.stoppedTurns ?? 0) > 0;

  const submit = async () => {
    if (!preview || !ready) return false;
    setSubmitError(null);
    try {
      const result = await client.changeMachineAudience(workspaceId, machine.enrollmentId, {
        audience: target,
        ...(target === "only_me" && ownerSubjectId !== subjectId ? { ownerSubjectId } : {}),
        expectedGeneration: preview.generation,
      });
      toast.success(
        result.audience === "only_me"
          ? `${machine.name} is now Only me`
          : `${machine.name} is now shared with the workspace`,
        {
          description:
            result.detachedSessionIds.length > 0
              ? `${count(result.detachedSessionIds.length, "chat", "chats")} moved off it. It kept its connection.`
              : "It kept its connection and running work.",
        },
      );
      onChanged?.(result);
      return true;
    } catch (error) {
      setSubmitError(error);
      // Something changed underneath: show the current summary again.
      setRefreshTick((tick) => tick + 1);
      return false;
    }
  };

  const disabledReason = !changing
    ? "This is how it's set now."
    : duplicates.length > 0
      ? "Remove the second connection first."
      : null;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`Who can use ${machine.name}?`}
      description="It stays connected with the same ID, so nothing needs to be set up again."
      submitLabel={target === "only_me" ? "Switch to Only me" : "Share with workspace"}
      pendingLabel="Switching…"
      tone={breaksWork ? "destructive" : "default"}
      submitDisabled={!ready || sharingNeedsAdmin}
      {...(disabledReason ? { disabledReason } : {})}
      onSubmit={submit}
      error={submitError ? userErrorText(submitError) : undefined}
    >
      <FieldStack>
        <ChoiceCards
          label="Who can use it?"
          value={target}
          onValueChange={(value) => {
            setTarget(value as MachineAudience);
            setSubmitError(null);
          }}
        >
          <ChoiceCard
            value="only_me"
            icon={<UserIcon />}
            title="Only me"
            description={
              current === "only_me"
                ? "How it's set now. Only its owner can run chats on it."
                : "Only its owner can run chats on it, in any workspace they use."
            }
          />
          <ChoiceCard
            value="workspace"
            icon={<UsersIcon />}
            title="This workspace"
            description={
              current === "workspace"
                ? "How it's set now. Everyone in this workspace can run chats on it."
                : "Everyone in this workspace can run chats on it."
            }
          />
        </ChoiceCards>

        {pickOwner ? (
          <Field label="Owner" hint="As an admin you can make it someone else's.">
            <SelectMenu
              size="md"
              variant={ownerOptions.length > 8 ? "combobox" : "menu"}
              options={ownerOptions}
              value={ownerSubjectId}
              loading={members === null}
              loadingLabel="Loading people…"
              searchPlaceholder="Search people"
              onValueChange={(value) => {
                setOwnerSubjectId(value);
                setSubmitError(null);
              }}
            />
          </Field>
        ) : null}

        {sharingNeedsAdmin ? (
          <Notice tone="muted">
            Only a workspace admin can share a machine with the workspace. Ask a workspace admin for
            access.
          </Notice>
        ) : null}

        {changing && previewError && !sharingNeedsAdmin ? (
          <Notice
            tone={isPermissionDenied(previewError) ? "muted" : "failed"}
            title={isPermissionDenied(previewError) ? undefined : "Couldn't check this machine"}
            action={
              isPermissionDenied(previewError) ? undefined : (
                <Button size="sm" variant="outline" onClick={() => setRefreshTick((t) => t + 1)}>
                  Try again
                </Button>
              )
            }
          >
            {userErrorText(previewError)}
          </Notice>
        ) : null}

        {changing && preview ? (
          <section
            aria-label="What happens"
            aria-busy={previewLoading || undefined}
            className="flex min-w-0 flex-col gap-3"
          >
            <h3 className="text-sm font-medium text-fg">What happens</h3>
            {lines.length === 0 ? (
              <p className="text-sm text-fg-muted">
                Nothing else uses this machine. It switches right away.
              </p>
            ) : (
              <ul className="flex min-w-0 list-disc flex-col gap-1.5 pl-5 text-sm text-fg marker:text-fg-subtle">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {listed.length > 0 ? (
              <Disclosure
                title="Chats and schedules affected"
                summary={count(listed.length, "item", "items")}
              >
                <ul className="flex min-w-0 flex-col divide-y divide-border">
                  {listed.map((item) => (
                    <ItemRow
                      key={`${item.kind}-${item.sessionId ?? item.scheduledTaskId}`}
                      item={item}
                      workspaceId={workspaceId}
                    />
                  ))}
                </ul>
              </Disclosure>
            ) : null}
            {duplicates.length > 0 ? (
              <Notice tone="waiting" title="This computer is connected twice">
                It is also connected as a separate machine. Remove that copy from the Machines page,
                then try again.
              </Notice>
            ) : null}
            {target === "only_me" && lines.length > 0 ? (
              <p className="text-xs leading-4.5 text-fg-muted">
                To undo, share it with the workspace again. Moved chats and paused schedules stay
                where they are; people choose another machine or resume them.
              </p>
            ) : null}
          </section>
        ) : changing && previewLoading && !preview ? (
          <p className="text-sm text-fg-muted" role="status">
            Checking what uses this machine…
          </p>
        ) : null}
      </FieldStack>
    </FormDialog>
  );
}
