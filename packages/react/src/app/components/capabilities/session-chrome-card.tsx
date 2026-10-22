import { t } from "../../lib/console-text";
import type { AuthNeededItem } from "../../../timeline";
import { MACHINES_SESSION_POLL_MS } from "../../../machines";
import { machineDisplayName } from "../../../sandbox-label-model";
import { OPENGENI_BROWSER_EXTENSION_URL } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useRef, useState } from "react";

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

/** What the person's message says when they continue after connecting Chrome. */
export const CHROME_CONNECTED_MESSAGE = "Chrome is connected. Continue.";

/** A neutral browser mark for the card (the frame renders logos as images). */
const CHROME_CARD_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 28 28" fill="none" stroke="#71717a" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M 12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
  );

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
  const chrome = useAttachedChrome(workspaceId, "any");
  const desktop = useDesktopThisComputer();
  const offerThisComputer =
    computer === null &&
    desktop !== null &&
    desktop.computer.status !== null &&
    desktop.computer.status.state !== "unavailable" &&
    !thisComputerReady(desktop.computer.status) &&
    !unavailableOnDeployment;
  const origin = apiBaseUrl || (typeof window !== "undefined" ? window.location.origin : "");
  const computerName = computer ? machineDisplayName(t, computer) : "";

  const chat = sendContext?.() ?? { blocked: null, awaitingHuman: false, extras: {} };
  const canContinue = canMessage && !chat.awaitingHuman && !sent;
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
  const step: "computer" | "extension" = computer ? "extension" : "computer";
  const actionUnavailable = unavailableOnDeployment
    ? "Connected Machines aren't available on this deployment."
    : step === "computer" && !offerThisComputer && !fleet.canRead
      ? "You don't have access to this workspace's machines."
      : step === "computer" && !offerThisComputer && !fleet.canManage
        ? "Ask a workspace admin to connect a computer."
        : null;

  return (
    <>
      <SessionCapabilityFrame
        name="Chrome"
        subtitle="Opengeni Browser extension"
        logo={CHROME_CARD_LOGO}
        typeLabel="Browser"
        description={
          step === "extension"
            ? `Add the Opengeni Browser extension to Chrome on ${computerName}.`
            : `${item.capability?.rationale ?? "Connect your Chrome so the agent can use it."} First connect this computer, then add the Opengeni Browser extension.`
        }
        skill={false}
        expanded={false}
        complete={chrome.connected !== null}
        completeLabel={
          chrome.connected
            ? sent
              ? `Chrome is connected (${chrome.connected.name}). The agent continues.`
              : `Chrome is connected (${chrome.connected.name}).`
            : undefined
        }
        actionLabel={
          step === "extension"
            ? "Add to Chrome"
            : offerThisComputer
              ? desktop.computer.acting
                ? "Connecting…"
                : "Use this computer"
              : "Connect this computer"
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
          if (thisComputerNeedsPermissions(desktop.computer.status)) return desktop.openSetup();
          void (
            desktop.computer.status?.state === "paused"
              ? desktop.computer.resume().then(() => desktop.computer.status)
              : desktop.computer.connect({ screenControl: false })
          ).then((next) => {
            if (thisComputerNeedsPermissions(next)) desktop.openSetup();
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
      {fleet.canManage && !unavailableOnDeployment ? (
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
          defaultScope="user"
        />
      ) : null}
    </>
  );
}
