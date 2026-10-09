import type { AuthNeededItem } from "@opengeni/react";
import { MACHINES_SESSION_POLL_MS, type MachineView } from "@opengeni/react/machines";
import { machineDisplayName } from "@opengeni/react/sandbox-label-model";
import { OPENGENI_BROWSER_EXTENSION_URL } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
import {
  ArrowUpRightIcon,
  CheckIcon,
  LaptopIcon,
  Loader2Icon,
  PlusIcon,
  PuzzleIcon,
  ServerIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiBaseUrl } from "@/api";
import { MachineConnectCommand } from "@/components/machines/machine-connect-command";
import { Button } from "@/components/ui/button";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { RowButton } from "@/components/ui/page-actions";
import { useAppContext } from "@/context";
import { userErrorText } from "@/lib/api-error";
import { isMachineComputeSelectable } from "@/lib/machine-selectability";
import { hasWorkspacePermission } from "@/lib/permissions";
import { useWorkspaceMachines } from "@/lib/use-workspace-machines";
import { SessionCapabilityFrame } from "./session-capability-frame";
import type { ChatSendContext } from "./session-github-repositories";

/** While a fresh command is out, look for the new machine every few seconds. */
const WATCH_POLL_MS = 3_000;
/** After "Add to Chrome", how often to check whether the extension linked up. */
const CHROME_POLL_MS = 5_000;
/** Stop checking for the extension after this long without a link. */
const CHROME_POLL_LIMIT_MS = 10 * 60_000;
/** Longest machine name repeated in the person's message. */
const MESSAGE_NAME_LIMIT = 60;

/** A neutral laptop mark for the card (the frame renders logos as images). */
export const CONNECTED_MACHINE_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 28 28" fill="none" stroke="#71717a" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z"/><path d="M20.054 15.987H3.946"/></svg>',
  );

/**
 * What the person's message says when they move the chat onto a machine. The
 * name comes from whoever enrolled the machine, so it is quoted, kept to one
 * line and shortened: it names a machine and can never read as an instruction.
 */
export function machineUseMessage(name: string): string {
  const line = name
    .replace(/[\s\u0000-\u001f\u007f]+/g, " ")
    .replaceAll("“", "")
    .replaceAll("”", "")
    .trim();
  const short =
    line.length > MESSAGE_NAME_LIMIT ? `${line.slice(0, MESSAGE_NAME_LIMIT - 1)}…` : line;
  return `Use the machine “${short || "unnamed"}” for this chat.`;
}

export type SessionMachineCapabilityCardProps = {
  item: AuthNeededItem;
  workspaceId: string;
  sessionId: string;
  /** What a composer Send would carry now, so this Send follows the same rules. */
  sendContext?: (() => ChatSendContext) | undefined;
  /** Re-read the session after the chat moves to a machine. */
  onConfigured?: (() => Promise<void>) | undefined;
};

function stateLabel(machine: MachineView): string {
  switch (machine.state) {
    case "online":
    case "consent_required":
      return "Online";
    case "display_unavailable":
      return "Online · no display";
    case "reconnecting":
      return "Reconnecting";
    case "enrolling":
      return "Connecting";
    default:
      return "Offline";
  }
}

/** Focus moves only when the person is not working somewhere else. */
function focusIfIdle(card: HTMLElement | null, target: HTMLElement | null = card) {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    const idle = !active || active === document.body || (card?.contains(active) ?? false);
    if (idle && target?.isConnected) target.focus();
    else if (idle && card?.isConnected) card.focus();
  });
}

/**
 * The Connected Machine card in a conversation. The agent can post it, but only
 * the person can connect a machine (the command is minted in their browser and
 * never enters the transcript) or move this chat onto one. Once a machine with a
 * screen is reachable, the card offers the OpenGeni Browser extension for it.
 */
export function SessionMachineCapabilityCard({
  item,
  workspaceId,
  sessionId,
  sendContext,
  onConfigured,
}: SessionMachineCapabilityCardProps) {
  const context = useAppContext();
  const recommendation = item.capability!;
  const accessKnown = context.accessContext !== null && context.accessContext !== undefined;
  const canMessage =
    !accessKnown || hasWorkspacePermission(context.accessContext, workspaceId, "sessions:control");

  const [setupOpen, setSetupOpen] = useState(false);
  const [hasCommand, setHasCommand] = useState(false);
  // Each machine's reachability when the person asked for a command. A machine
  // that is new, or was unreachable and is now reachable, is the one they connected.
  const [watchRequested, setWatchRequested] = useState(false);
  const [known, setKnown] = useState<ReadonlyMap<string, boolean> | null>(null);
  const [justConnected, setJustConnected] = useState<string | null>(null);
  const [using, setUsing] = useState<string | null>(null);
  const [useError, setUseError] = useState<{ name: string; reason: string | null } | null>(null);
  const [outcome, setOutcome] = useState<{ sandboxId: string; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const cardRef = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const setupOpener = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const watching = known !== null && justConnected === null;
  const fleet = useWorkspaceMachines({
    workspaceId,
    sessionId,
    pollIntervalMs: watching ? WATCH_POLL_MS : MACHINES_SESSION_POLL_MS,
  });
  const unavailableOnDeployment =
    fleet.error instanceof OpenGeniApiError && fleet.error.status === 404;
  const machines = useMemo(
    () => fleet.machines.filter((machine) => !machine.isSessionGroup && machine.enrollmentId),
    [fleet.machines],
  );
  const activeMachine = machines.find((machine) => machine.active) ?? null;
  const reachable = machines.filter((machine) => isMachineComputeSelectable(machine.state));

  // Snapshot the machines once the list has loaded.
  useEffect(() => {
    if (!watchRequested || known !== null || fleet.loading) return;
    setKnown(
      new Map(
        machines.map((machine) => [machine.sandboxId, isMachineComputeSelectable(machine.state)]),
      ),
    );
  }, [fleet.loading, known, machines, watchRequested]);

  useEffect(() => {
    if (!watching || !known) return;
    const fresh = machines.find(
      (machine) =>
        isMachineComputeSelectable(machine.state) && known.get(machine.sandboxId) !== true,
    );
    if (!fresh) return;
    setJustConnected(fresh.sandboxId);
    setSetupOpen(false);
    setHasCommand(false);
    setAnnouncement(`${machineDisplayName(fresh)} connected.`);
    focusIfIdle(cardRef.current);
  }, [known, machines, watching]);

  const openSetup = () => {
    const active = document.activeElement;
    setupOpener.current = active instanceof HTMLElement ? active : null;
    setKnown(null);
    setJustConnected(null);
    setHasCommand(false);
    setWatchRequested(true);
    setSetupOpen(true);
  };
  const cancelSetup = () => {
    // Stop watching entirely: fast polling ends and nothing can steal focus later.
    setSetupOpen(false);
    setWatchRequested(false);
    setKnown(null);
    setHasCommand(false);
    const back = setupOpener.current?.isConnected ? setupOpener.current : opener.current;
    focusIfIdle(cardRef.current, back);
  };

  const ordered = useMemo(() => {
    const rank = (machine: MachineView) =>
      machine.sandboxId === justConnected
        ? 0
        : machine.active
          ? 1
          : isMachineComputeSelectable(machine.state)
            ? 2
            : 3;
    return [...machines].sort(
      (left, right) =>
        rank(left) - rank(right) ||
        machineDisplayName(left).localeCompare(machineDisplayName(right)),
    );
  }, [justConnected, machines]);

  const use = useCallback(
    async (machine: MachineView) => {
      if (using !== null) return;
      const name = machineDisplayName(machine);
      setUseError(null);
      setOutcome(null);
      // Like a composer Send: a chat that can't take input isn't moved either.
      const chat = sendContext?.() ?? { blocked: null, awaitingHuman: false, extras: {} };
      if (chat.blocked) {
        setUseError({ name, reason: chat.blocked });
        return;
      }
      setUsing(machine.sandboxId);
      const moved = await fleet.attach(machine.sandboxId);
      if (!alive.current) return;
      if (!moved) {
        setUsing(null);
        setUseError({ name, reason: null });
        return;
      }
      // Tell the agent where it now runs. A chat waiting on a question keeps
      // that question; the person's answer continues it on the new machine.
      let told = false;
      let routing: unknown = null;
      if (canMessage && !chat.awaitingHuman) {
        try {
          const accepted = await context.client.sendMessage(workspaceId, sessionId, {
            text: machineUseMessage(name),
            ...chat.extras,
            clientEventId: crypto.randomUUID(),
          });
          routing = (accepted.payload as { routing?: unknown } | null)?.routing ?? null;
          told = true;
        } catch {
          told = false;
        }
      }
      if (!alive.current) return;
      const text = chat.awaitingHuman
        ? `This chat now runs on ${name}. Answer the question above to continue.`
        : !told
          ? `This chat now runs on ${name}. Send a message to continue.`
          : routing === "queued_for_execution"
            ? `This chat now runs on ${name}. The agent continues there after its current step.`
            : `This chat now runs on ${name}.`;
      setUsing(null);
      setOutcome({ sandboxId: machine.sandboxId, text });
      setAnnouncement(text);
      focusIfIdle(cardRef.current);
      await onConfigured?.().catch(() => {});
    },
    [canMessage, context.client, fleet, onConfigured, sendContext, sessionId, using, workspaceId],
  );

  // Chrome belongs to a machine with a screen: the one this chat runs on if it
  // has one, otherwise the first reachable one.
  const chromeMachine =
    (activeMachine?.hasDisplay && isMachineComputeSelectable(activeMachine.state)
      ? activeMachine
      : null) ??
    reachable.find((machine) => machine.hasDisplay) ??
    null;
  const chrome = useAttachedChrome(
    workspaceId,
    fleet.canRead ? (chromeMachine?.enrollmentId ?? null) : null,
  );
  const fresh = justConnected
    ? (machines.find((machine) => machine.sandboxId === justConnected) ?? null)
    : null;
  const origin = apiBaseUrl || (typeof window !== "undefined" ? window.location.origin : "");

  // One clear action per state. With a reachable machine, the list's "Use in
  // this chat" is primary and connecting another is a quiet secondary action.
  const actionUnavailable = unavailableOnDeployment
    ? "Connected Machines aren't available on this deployment."
    : !fleet.canRead
      ? "You don't have access to this workspace's machines."
      : setupOpen
        ? "Run the command below. This card updates when the machine connects."
        : fresh && fleet.canAttach
          ? `${machineDisplayName(fresh)} connected. Choose it below to use it here.`
          : reachable.length > 0 && fleet.canAttach
            ? "Choose where this chat runs."
            : reachable.length > 0
              ? "You can't change where this chat runs."
              : fleet.canManage
                ? null
                : machines.length > 0
                  ? "Turn on one of the machines below to use it here."
                  : "Ask a workspace admin to connect a machine.";
  const connectAnother =
    fleet.canManage && !setupOpen && (reachable.length > 0 || activeMachine !== null);
  const visibleDetails =
    (setupOpen && fleet.canManage) ||
    useError !== null ||
    ordered.length > 0 ||
    chromeMachine !== null ||
    connectAnother;

  return (
    <SessionCapabilityFrame
      name={recommendation.name || "Connected Machine"}
      subtitle="Your computer or server"
      logo={CONNECTED_MACHINE_LOGO}
      typeLabel="Machine"
      description={recommendation.rationale}
      skill={false}
      expanded={false}
      complete={activeMachine !== null}
      completeLabel={
        activeMachine
          ? outcome?.sandboxId === activeMachine.sandboxId
            ? outcome.text
            : `This chat runs on ${machineDisplayName(activeMachine)}`
          : undefined
      }
      actionLabel="Connect a machine"
      actionUnavailable={actionUnavailable}
      opensDialog={false}
      note={fleet.canManage ? "You can remove a connected machine anytime from Machines." : ""}
      onOpen={openSetup}
      onClose={cancelSetup}
      opener={opener}
      cardRef={cardRef}
      details={
        unavailableOnDeployment || !fleet.canRead ? null : (
          <>
            {/* Always mounted, so moves and new machines are announced. */}
            <span className="sr-only" role="status" aria-live="polite">
              {announcement}
            </span>
            {visibleDetails ? (
              <div
                data-slot="connected-machines"
                className="space-y-3 border-t border-border px-[19px] pt-3 pb-4 max-[480px]:px-3.5"
              >
                {setupOpen && fleet.canManage ? (
                  <div className="space-y-2">
                    <MachineConnectCommand
                      workspaceId={workspaceId}
                      origin={origin}
                      onMinted={() => setHasCommand(true)}
                    />
                    <div className="flex items-center justify-between gap-3 text-2xs text-fg-muted">
                      {hasCommand ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Loader2Icon aria-hidden className="size-3 animate-spin" />
                          Waiting for the machine…
                        </span>
                      ) : (
                        <span />
                      )}
                      <Button type="button" variant="ghost" size="xs" onClick={cancelSetup}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
                {useError ? (
                  <Notice tone="failed" live="assertive" className="text-xs">
                    {`Couldn't move this chat to ${useError.name}. ${
                      useError.reason ??
                      (fleet.mutationError
                        ? userErrorText(fleet.mutationError, "Try again.")
                        : "Try again.")
                    }`}
                  </Notice>
                ) : null}
                {ordered.length > 0 ? (
                  <RowList label="Connected machines" flush>
                    {ordered.map((machine) => (
                      <MachineRow
                        key={machine.sandboxId}
                        machine={machine}
                        primary={machine.sandboxId === justConnected || reachable.length === 1}
                        canUse={fleet.canAttach}
                        busy={using === machine.sandboxId}
                        locked={using !== null || fleet.attaching}
                        onUse={() => void use(machine)}
                      />
                    ))}
                  </RowList>
                ) : null}
                {chromeMachine ? (
                  <ChromeStep chrome={chrome} machineName={machineDisplayName(chromeMachine)} />
                ) : null}
                {connectAnother ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-ml-2 text-fg-muted"
                    onClick={openSetup}
                  >
                    <PlusIcon aria-hidden />
                    Connect another machine
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )
      }
    />
  );
}

function MachineRow({
  machine,
  primary,
  canUse,
  busy,
  locked,
  onUse,
}: {
  machine: MachineView;
  primary: boolean;
  canUse: boolean;
  busy: boolean;
  locked: boolean;
  onUse: () => void;
}) {
  const name = machineDisplayName(machine);
  const selectable = isMachineComputeSelectable(machine.state);
  const Icon = machine.os === "linux" && !machine.hasDisplay ? ServerIcon : LaptopIcon;
  const common = {
    leading: <LogoTile icon={<Icon />} />,
    title: name,
    meta: [stateLabel(machine)],
  };
  if (machine.active) {
    return (
      <ListRow
        {...common}
        control={
          <span className="inline-flex items-center gap-1 text-xs font-medium text-status-idle">
            <CheckIcon aria-hidden className="size-3.5" />
            In this chat
          </span>
        }
      />
    );
  }
  // The meta line already says why ("Offline", "Reconnecting").
  if (!selectable) return <ListRow {...common} disabled />;
  if (!canUse) return <ListRow {...common} />;
  const label = busy ? `Moving this chat to ${name}` : `Use ${name} in this chat`;
  return (
    <ListRow
      {...common}
      control={
        primary ? (
          <Button
            type="button"
            size="sm"
            aria-label={label}
            aria-disabled={locked || undefined}
            className="rounded-[10px] pointer-coarse:h-11"
            onClick={() => {
              if (!locked) onUse();
            }}
          >
            {busy ? <Loader2Icon aria-hidden className="animate-spin" /> : null}
            {busy ? "Moving…" : "Use in this chat"}
          </Button>
        ) : (
          <RowButton
            aria-label={label}
            aria-disabled={locked || undefined}
            onClick={() => {
              if (!locked) onUse();
            }}
          >
            {busy ? <Loader2Icon aria-hidden className="animate-spin" /> : null}
            {busy ? "Moving…" : "Use"}
          </RowButton>
        )
      }
    />
  );
}

type ChromeState = {
  connected: { name: string } | null;
  /** Start checking for the extension (after the person opens the store). */
  watch: () => void;
};

/**
 * Whether the OpenGeni Browser extension linked a Chrome profile on this exact
 * machine. Reads once; polls only after the person opens the store, stops once
 * linked, after a bounded time, or when the inventory is not available to them.
 */
function useAttachedChrome(workspaceId: string, enrollmentId: string | null): ChromeState {
  const { client } = useAppContext();
  // Poll on its own timer; a new client identity on re-render must not refetch.
  const clientRef = useRef(client);
  clientRef.current = client;
  const [connected, setConnected] = useState<{ name: string } | null>(null);
  const [watchSince, setWatchSince] = useState<number | null>(null);
  const [denied, setDenied] = useState(false);
  const linked = connected !== null;

  useEffect(() => {
    setConnected(null);
    setDenied(false);
  }, [enrollmentId]);

  useEffect(() => {
    if (!enrollmentId || denied) return;
    let cancelled = false;
    const read = async () => {
      try {
        const result = await clientRef.current.listAttachedBrowsers(workspaceId);
        if (cancelled) return;
        const device = result.devices.find(
          (candidate) => candidate.state === "connected" && candidate.enrollmentId === enrollmentId,
        );
        setConnected(device ? { name: device.profileLabel ?? device.browserName } : null);
      } catch (failure) {
        // Without inventory access the step still offers the install link.
        if (
          !cancelled &&
          failure instanceof OpenGeniApiError &&
          failure.status >= 400 &&
          failure.status < 500
        ) {
          setDenied(true);
        }
      }
    };
    void read();
    if (linked || watchSince === null) return () => void (cancelled = true);
    const timer = window.setInterval(() => {
      if (Date.now() - watchSince > CHROME_POLL_LIMIT_MS) {
        window.clearInterval(timer);
        return;
      }
      if (document.visibilityState !== "hidden") void read();
    }, CHROME_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [denied, enrollmentId, linked, watchSince, workspaceId]);

  const watch = useCallback(() => setWatchSince(Date.now()), []);
  return { connected, watch };
}

function ChromeStep({ chrome, machineName }: { chrome: ChromeState; machineName: string }) {
  return (
    <div data-slot="chrome-extension">
      <RowList label="Chrome" flush>
        <ListRow
          leading={<LogoTile icon={<PuzzleIcon />} />}
          title="Chrome"
          description={
            chrome.connected
              ? `${chrome.connected.name} on ${machineName}`
              : `Add OpenGeni Browser on ${machineName}`
          }
          control={
            chrome.connected ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-status-idle">
                <CheckIcon aria-hidden className="size-3.5" />
                Connected
              </span>
            ) : (
              <Button asChild size="sm" variant="outline" className="rounded-[10px]">
                <a
                  href={OPENGENI_BROWSER_EXTENSION_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={chrome.watch}
                >
                  Add to Chrome
                  <ArrowUpRightIcon aria-hidden />
                  <span className="sr-only"> (opens the Chrome Web Store in a new tab)</span>
                </a>
              </Button>
            )
          }
        />
      </RowList>
    </div>
  );
}
