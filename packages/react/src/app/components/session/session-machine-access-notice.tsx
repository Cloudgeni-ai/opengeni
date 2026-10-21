import type { SessionMachineAccess } from "@opengeni/sdk";
import { useState, type ReactNode } from "react";
import { Button } from "../../../ui/button";
import { Notice } from "../../../ui/notice";

/** A machine-list response is useful only while it names the current pointer. */
export function currentSessionMachineAccess(
  access: SessionMachineAccess | null | undefined,
  activeSandboxId: string | null,
): SessionMachineAccess | null {
  return access?.sandboxId === activeSandboxId ? access : null;
}

export function PersonalMachineExplanation({
  access,
  queued = false,
  action,
}: {
  access: SessionMachineAccess;
  queued?: boolean | undefined;
  action?: ReactNode | undefined;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const owner = access.ownerName || "the machine owner";
  const request = `This chat runs on your personal machine “${access.machineName}”, so my message can't start there. Could you make the machine available to the workspace, or help me choose a shared machine?`;
  return (
    <>
      <p>
        This chat runs on {access.isOwner ? "your" : `${owner}’s`} personal machine{" "}
        <strong className="font-medium text-fg">“{access.machineName}”</strong>.
        {access.isOwner
          ? " Messages from other people cannot start work on it."
          : ` Only ${owner} can start new work there.`}
      </p>
      <p className="mt-1">
        {queued ? "The queued message is saved. " : "Your draft stays here. "}
        {access.isOwner
          ? "Choose a workspace or cloud machine, or ask a workspace admin to share this machine."
          : queued
            ? `Choose a workspace or cloud machine, or ask ${owner} about sharing this machine with the workspace.`
            : `Choose a machine you can use, or ask ${owner} about sharing this machine with the workspace.`}
        {queued ? " After changing machines or access, recheck to run the saved message." : ""}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {action}
        {!access.isOwner ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 max-w-full whitespace-normal"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(request);
                setCopyState("copied");
              } catch {
                setCopyState("failed");
              }
            }}
          >
            {copyState === "copied" ? "Request copied" : `Copy request to ${owner}`}
          </Button>
        ) : null}
      </div>
      {copyState !== "idle" ? (
        <p role="status" className="mt-1">
          {copyState === "copied"
            ? "Paste it into a message to the owner. Nothing has been sent."
            : request}
        </p>
      ) : null}
    </>
  );
}

export function SessionMachineAccessNotice({
  access,
  action,
}: {
  access: SessionMachineAccess | null;
  action?: ReactNode | undefined;
}) {
  if (!access || access.isOwner) return null;
  return (
    <Notice tone="waiting" title="Choose a machine before sending" live="polite">
      <PersonalMachineExplanation access={access} action={action} />
    </Notice>
  );
}
