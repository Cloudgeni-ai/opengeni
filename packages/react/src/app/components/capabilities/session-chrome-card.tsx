import { t } from "../../lib/console-text";
import type { AuthNeededItem } from "../../../timeline";
import { MACHINES_SESSION_POLL_MS } from "../../../machines";
import { machineDisplayName } from "../../../sandbox-label-model";
import { OPENGENI_BROWSER_EXTENSION_URL } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useEffect, useRef, useState } from "react";
import chromeLogo from "../../../assets/google-chrome.svg";

import { useAppApi } from "../../lib/app-api";
import { ConnectMachineDialog } from "../machines/connect-machine-dialog";
import { Button } from "../../../ui/button";
import { Notice } from "../../../ui/notice";
import { useAppContext } from "../../app-context";
import { userErrorText } from "../../../ui/api-error";
import { isMachineComputeSelectable } from "../../lib/machine-selectability";
import { useDesktopThisComputer } from "../desktop/this-computer";
import { hasWorkspacePermission } from "../../lib/permissions";
import { useWorkspaceMachines } from "../../lib/use-workspace-machines";
import { thisComputerReady, thisComputerNeedsPermissions } from "../../../this-computer";
import { SessionCapabilityFrame } from "../../../components/session-capability-frame";
import type { ChatSendContext } from "./session-github-repositories";
import { useAttachedChrome } from "./session-machine-card";

/** While the connect dialog is open, look for the new machine every few seconds. */
const WATCH_POLL_MS = 3_000;

/** The computer last seen for Chrome per workspace, so a card shown again starts there. */
const lastComputers = new Map<string, { sandboxId: string; name: string }>();

/** Chats whose stale Chrome wait this page already cleared. */
const clearedWaits = new Set<string>();

/** Forget the remembered computers and cleared chats (tests). */
export function resetChromeCardCache(): void {
  lastComputers.clear();
  clearedWaits.clear();
}

/**
 * The completed line: the profile is named only when it says something, when
 * more than one Chrome is linked or it has its own name.
 */
export function chromeConnectedLabel(
  connected: { name: string; multiple: boolean },
  sent: boolean,
): string {
  const name = connected.name.trim();
  const named = name && (connected.multiple || name.toLowerCase() !== "chrome");
  return `${named ? `Connected (${name}).` : "Connected."}${sent ? " The agent continues." : ""}`;
}

/** What the person's message says when they continue after connecting Chrome. */
export const CHROME_CONNECTED_MESSAGE = "Chrome is connected. Continue.";

export type SessionChromeCapabilityCardProps = {
  item: AuthNeededItem;
  workspaceId: string;
  sessionId: string;
  /** What a composer Send would carry now, so Continue follows the same rules. */
  sendContext?: (() => ChatSendContext) | undefined;
};

/**
 * The card a browser tool posts when the agent needs the person's own Chrome and
 * none is connected. It shows one next step at a time: connect a computer, then
 * add the Opengeni Browser extension there. Once Chrome links up, Continue tells
 * the agent to go on.
 */
export function SessionChromeCapabilityCard({
  item,
  workspaceId,
  sessionId,
  sendContext,
}: SessionChromeCapabilityCardProps) {
  const context = useAppContext();
  const { apiBaseUrl } = useAppApi();
  const accessKnown = context.accessContext !== null && context.accessContext !== undefined;
  const canMessage =
    !accessKnown || hasWorkspacePermission(context.accessContext, workspaceId, "sessions:control");
  const [setupOpen, setSetupOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const fleet = useWorkspaceMachines({
    workspaceId,
    sessionId,
    pollIntervalMs: setupOpen ? WATCH_POLL_MS : MACHINES_SESSION_POLL_MS,
  });
  const unavailableOnDeployment =
    fleet.error instanceof OpenGeniApiError && fleet.error.status === 404;
  // Chrome runs on a computer with a screen that is online now.
  const computer =
    fleet.machines.find(
      (machine) =>
        !machine.isSessionGroup &&
        machine.enrollmentId &&
        machine.hasDisplay &&
        isMachineComputeSelectable(machine.state),
    ) ?? null;
  // The machines are known once a read finished (or failed); until then the
  // last computer seen in this workspace stands in.
  const machinesKnown = !(fleet.loading && fleet.machines.length === 0 && !fleet.error);
  const subjectId = context.accessContext?.subjectId ?? "";
  const computerKey = `${subjectId}\u0000${workspaceId}`;
  const remembered = machinesKnown ? null : (lastComputers.get(computerKey) ?? null);
  useEffect(() => {
    if (!machinesKnown) return;
    if (computer?.sandboxId)
      lastComputers.set(computerKey, {
        sandboxId: computer.sandboxId,
        name: machineDisplayName(t, computer),
      });
    else lastComputers.delete(computerKey);
  }, [computer, computerKey, machinesKnown]);
  // Read again when a computer comes online: its Chrome may already have the
  // extension, so the card can skip straight to Continue.
  const chrome = useAttachedChrome(
    workspaceId,
    "any",
    computer?.sandboxId ?? remembered?.sandboxId ?? null,
  );
  // Never offer a step before knowing it is needed: until Chrome and the
  // machines were read once (here or by an earlier card), say so quietly.
  const ready =
    chrome.connected !== null || (chrome.checked && (machinesKnown || remembered !== null));
  // A card that sees Chrome linked no longer waits on the person, in this chat
  // or in the sub-session bar above it, whatever the agent does next. Only a
  // live reading counts, and only a finished request is remembered, so a
  // failed one is tried again.
  const linked = chrome.fresh && chrome.connected !== null;
  useEffect(() => {
    const key = `${subjectId}\u0000${workspaceId}\u0000${sessionId}`;
    if (!linked || clearedWaits.has(key)) return;
    if (typeof context.client.continueAfterCapabilitySetup !== "function") return;
    clearedWaits.add(key);
    void context.client
      .continueAfterCapabilitySetup(workspaceId, sessionId, {
        capabilityId: item.capability?.id ?? "api:connected-machine",
      })
      .catch(() => clearedWaits.delete(key));
  }, [context.client, item.capability?.id, linked, sessionId, subjectId, workspaceId]);
  // Continue is offered only after this card itself saw Chrome missing, so an
  // old card, or one reloaded after Chrome connected, never sends a stray
  // message, even when an earlier card remembered Chrome as missing.
  const [sawMissing, setSawMissing] = useState(false);
  useEffect(() => {
    if (chrome.fresh && chrome.checked && chrome.connected === null) setSawMissing(true);
  }, [chrome.checked, chrome.connected, chrome.fresh]);
  const desktop = useDesktopThisComputer();
  const offerThisComputer =
    computer === null &&
    desktop !== null &&
    desktop.computer.status !== null &&
    desktop.computer.status.state !== "unavailable" &&
    !thisComputerReady(desktop.computer.status) &&
    !unavailableOnDeployment;
  const origin = apiBaseUrl || (typeof window !== "undefined" ? window.location.origin : "");
  const computerName = computer ? machineDisplayName(t, computer) : (remembered?.name ?? "");

  const chat = sendContext?.() ?? { blocked: null, awaitingHuman: false, extras: {} };
  const canContinue = canMessage && sawMissing && !chat.awaitingHuman && !sent;
  const sendContinue = async () => {
    if (sending || !canContinue) return;
    const current = sendContext?.() ?? chat;
    if (current.blocked) {
      setSendError(current.blocked);
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      await context.client.sendMessage(workspaceId, sessionId, {
        text: CHROME_CONNECTED_MESSAGE,
        ...current.extras,
        clientEventId: crypto.randomUUID(),
      });
      setSent(true);
    } catch (failure) {
      setSendError(userErrorText(failure, "Try again."));
    } finally {
      setSending(false);
    }
  };

  // One clear next step: connect a computer, then add the extension there.
  const step: "computer" | "extension" = computer || remembered ? "extension" : "computer";
  const actionUnavailable = unavailableOnDeployment
    ? "Connected Machines aren't available on this deployment."
    : step === "computer" && !offerThisComputer && !fleet.canRead
      ? "You don't have access to this workspace's machines."
      : step === "computer" && !offerThisComputer && !fleet.canConnect
        ? "Ask a workspace admin to connect a computer."
        : null;

  return (
    <>
      <SessionCapabilityFrame
        name="Chrome"
        subtitle="Opengeni Browser extension"
        logo={chromeLogo}
        typeLabel="Browser"
        pending={!ready}
        description={
          !ready
            ? "Checking for Chrome…"
            : step === "extension"
              ? `Add the extension to Chrome on ${computerName}.`
              : `${item.capability?.rationale ?? "Connect your Chrome so the agent can use it."} First connect a computer, then add the extension.`
        }
        skill={false}
        expanded={false}
        complete={chrome.connected !== null}
        completeLabel={chrome.connected ? chromeConnectedLabel(chrome.connected, sent) : undefined}
        actionLabel={
          step === "extension"
            ? "Add to Chrome"
            : offerThisComputer
              ? desktop.computer.acting
                ? "Connecting…"
                : "Use this computer"
              : "Connect a computer"
        }
        busy={step === "computer" && offerThisComputer && desktop.computer.acting}
        actionUnavailable={actionUnavailable}
        opensDialog={step === "computer" && !offerThisComputer}
        note={step === "extension" && chrome.watching ? "Waiting for Chrome to connect…" : ""}
        onOpen={() => {
          if (step === "extension") {
            window.open(OPENGENI_BROWSER_EXTENSION_URL, "_blank", "noopener,noreferrer");
            chrome.watch();
            return;
          }
          if (!offerThisComputer) return setSetupOpen(true);
          if (desktop.computer.acting) return;
          if (thisComputerNeedsPermissions(desktop.computer.status))
            return desktop.allowPermissions();
          // Paused is Off: turning on resumes it and asks for anything missing.
          if (desktop.computer.status?.state === "paused") {
            void desktop.computer.turnOn().then(() => void fleet.refresh());
            return;
          }
          void desktop.computer.connect({ screenControl: false }).then((next) => {
            if (thisComputerNeedsPermissions(next)) desktop.allowPermissions(next);
            void fleet.refresh();
          });
        }}
        onClose={() => setSetupOpen(false)}
        opener={opener}
        cardRef={cardRef}
        details={
          chrome.connected && (canContinue || sendError) ? (
            <div
              data-slot="chrome-continue"
              className="space-y-2 border-t border-border px-[19px] pt-3 pb-4 max-[480px]:px-3.5"
            >
              {sendError ? (
                <Notice tone="failed" live="assertive" className="text-xs">
                  {`Couldn't send. ${sendError}`}
                </Notice>
              ) : null}
              {canContinue ? (
                <Button
                  type="button"
                  size="sm"
                  className="rounded-[10px] pointer-coarse:h-11"
                  aria-disabled={sending || undefined}
                  onClick={() => void sendContinue()}
                >
                  {sending ? "Sending…" : "Continue"}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
      {fleet.canConnect && !unavailableOnDeployment ? (
        <ConnectMachineDialog
          open={setupOpen}
          onOpenChange={(open) => {
            if (!open) setSetupOpen(false);
          }}
          workspaceId={workspaceId}
          sessionId={sessionId}
          origin={origin}
          machines={fleet.machines}
          machinesLoading={fleet.loading}
          machinesError={fleet.error}
          personalWorkspace={
            context.workspaces?.find((workspace) => workspace.id === workspaceId)?.kind ===
            "personal"
          }
          canShareWithWorkspace={fleet.canManage}
          canConnectOwnMachine={fleet.canConnectOwnMachine}
          defaultScope="user"
        />
      ) : null}
    </>
  );
}
