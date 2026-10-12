import { copyTextToClipboard } from "@opengeni/react/clipboard";
import type { MachineView } from "@opengeni/react/machines";
import { machineDisplayName, machineScopeLabel } from "@opengeni/react/sandbox-label-model";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LaptopIcon,
  Loader2Icon,
  ServerIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/context";
import { userErrorText } from "@/lib/api-error";
import {
  detectConnectOs,
  deviceVerificationUri,
  installCommandFor,
  type ConnectOs,
} from "@/lib/deployment";
import { isMachineComputeSelectable } from "@/lib/machine-selectability";

/** Who can use the machine: the person connecting it, or the whole workspace. */
export type ConnectMachineScope = "user" | "workspace";

/**
 * The choice that reconnects a machine without changing who can use it. A
 * command cannot carry organization access, so an organization machine maps to
 * This workspace (pairing with a code is the way to keep organization access).
 */
export function connectScopeFor(machine: Pick<MachineView, "scope">): ConnectMachineScope {
  return machine.scope === "user" ? "user" : "workspace";
}

/** The choices a connect command is minted for. Both are baked into the token. */
export type ConnectChoice = { scope: ConnectMachineScope; allowScreenControl: boolean };

export type MintedConnectToken = ConnectChoice & {
  /** The workspace it was minted for; a command is never shown for another. */
  workspaceId: string;
  value: string;
  expiresAt: string;
  expiresInSeconds: number;
};

const OS_OPTIONS = [
  { value: "macos", label: "Mac" },
  { value: "linux", label: "Linux" },
  { value: "windows", label: "Windows" },
] as const satisfies readonly { value: ConnectOs; label: string }[];

const PASTE_HINT: Record<ConnectOs, string> = {
  macos: "Paste this into Terminal on the Mac you want to connect.",
  linux: "Paste this into a terminal on the Linux machine you want to connect.",
  windows: "Paste this into PowerShell on the Windows PC you want to connect.",
};

function sameChoice(left: ConnectChoice, right: ConnectChoice): boolean {
  return left.scope === right.scope && left.allowScreenControl === right.allowScreenControl;
}

/**
 * Mints a single-use connect command in this browser for the current choices.
 * Every request remembers the choices it was made for and only the latest
 * request may settle, so a slow response for an earlier choice never shows.
 * The command is usable only while its token matches the current choices, and
 * the server's echo of what it granted is checked rather than trusted blindly.
 */
export function useConnectToken(workspaceId: string, choice: ConnectChoice) {
  const { client } = useAppContext();
  // Minting follows the choices; a new client identity on re-render never mints.
  const clientRef = useRef(client);
  clientRef.current = client;
  const [token, setToken] = useState<MintedConnectToken | null>(null);
  const [pending, setPending] = useState<ConnectChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { scope, allowScreenControl } = choice;

  useEffect(() => {
    const requested = { scope, allowScreenControl };
    let current = true;
    setPending(requested);
    setError(null);
    void (async () => {
      try {
        const result = await clientRef.current.mintEnrollToken(workspaceId, requested);
        if (!current) return;
        // A server that predates scoped commands omits the echo and always
        // mints a workspace-shared token.
        const granted: ConnectChoice = {
          scope: result.scope ?? "workspace",
          allowScreenControl: result.allowScreenControl ?? requested.allowScreenControl,
        };
        if (!sameChoice(granted, requested)) {
          setToken(null);
          setError(
            requested.scope === "user"
              ? "This server can't connect a machine for you only yet. Choose This workspace, or ask an admin to update OpenGeni."
              : "The command didn't match your choices. Try again.",
          );
          return;
        }
        setToken({
          ...granted,
          workspaceId,
          value: result.token,
          expiresAt: result.expiresAt,
          expiresInSeconds: result.expiresInSeconds,
        });
      } catch (failure) {
        if (!current) return;
        setToken(null);
        setError(userErrorText(failure, "Try again."));
      } finally {
        if (current) setPending(null);
      }
    })();
    return () => {
      current = false;
    };
  }, [workspaceId, scope, allowScreenControl, attempt]);

  const matching =
    token && token.workspaceId === workspaceId && sameChoice(token, choice) && pending === null
      ? token
      : null;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { token: matching, minting: pending !== null, error, retry };
}

/** "2:05 PM" for today, otherwise a date and time; relative when unparseable. */
export function formatConnectExpiry(expiresAt: string, expiresInSeconds: number): string {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) {
    return `about ${Math.max(1, Math.round(expiresInSeconds / 60))} min from now`;
  }
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function connectableMachines(machines: readonly MachineView[]): MachineView[] {
  return machines.filter((machine) => !machine.isSessionGroup && machine.enrollmentId);
}

/**
 * The machine that came online while the dialog was open: one that is new, or
 * was unreachable when the dialog opened. A machine with the chosen access wins
 * when several qualify. The first one found stays the answer. The baseline is
 * the first list that actually loaded: a failed load shows no machines, and
 * every existing machine would otherwise look new once a later load succeeds.
 */
function useNewlyConnectedMachine(
  machines: readonly MachineView[],
  loading: boolean,
  loadFailed: boolean,
  scope: ConnectMachineScope,
): MachineView | null {
  const fleet = useMemo(() => connectableMachines(machines), [machines]);
  const [known, setKnown] = useState<ReadonlyMap<string, boolean> | null>(null);
  const [connectedId, setConnectedId] = useState<string | null>(null);

  useEffect(() => {
    if (known !== null || loading || loadFailed) return;
    setKnown(
      new Map(
        fleet.map((machine) => [machine.sandboxId, isMachineComputeSelectable(machine.state)]),
      ),
    );
  }, [fleet, known, loading, loadFailed]);

  useEffect(() => {
    if (!known || connectedId !== null) return;
    const fresh = fleet.filter(
      (machine) =>
        isMachineComputeSelectable(machine.state) && known.get(machine.sandboxId) !== true,
    );
    const chosen = fresh.find((machine) => machine.scope === scope) ?? fresh[0];
    if (chosen) setConnectedId(chosen.sandboxId);
  }, [connectedId, fleet, known, scope]);

  return connectedId ? (fleet.find((machine) => machine.sandboxId === connectedId) ?? null) : null;
}

export type ConnectMachineDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The deployment origin the commands dial (the API origin, else this page). */
  origin: string;
  /** The workspace's machines, polled by the host while the dialog is open. */
  machines: readonly MachineView[];
  machinesLoading: boolean;
  /** The latest machines load failure, if any. Success waits for a good load. */
  machinesError?: unknown;
  /** A personal workspace: "This workspace" is still only its owner. */
  personalWorkspace?: boolean;
  /** Who can use it, to start with (a reconnect keeps the machine's access). */
  defaultScope?: ConnectMachineScope;
  /** Screen control's starting value (on when reconnecting to turn it on). */
  defaultAllowScreenControl?: boolean;
  /** Called once when a machine comes online while the dialog is open. */
  onConnected?: ((machine: MachineView) => void) | undefined;
  /**
   * From a chat: finish by moving the chat onto the new machine through the
   * existing attach flow. Without it, the dialog finishes with Done.
   */
  useInChat?: { canUse: boolean; onUse: (machine: MachineView) => void } | undefined;
};

/**
 * Connect a machine: choose who can use it and whether agents may control its
 * screen, copy one command for the machine's OS, and stay here until the
 * machine connects. Shared by the Machines page and the chat's machine card.
 */
export function ConnectMachineDialog({ open, onOpenChange, ...body }: ConnectMachineDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-connect-machine-dialog="">
        {/* Mounted only while open, so each opening mints a fresh command. Keyed
            by workspace: a switch (browser back or forward) starts over, so the
            other workspace's machines never look newly connected. */}
        {open ? (
          <ConnectMachineBody
            key={body.workspaceId}
            {...body}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ConnectMachineBody({
  workspaceId,
  origin,
  machines,
  machinesLoading,
  machinesError = null,
  personalWorkspace = false,
  defaultScope = "user",
  defaultAllowScreenControl = false,
  onConnected,
  useInChat,
  onClose,
}: Omit<ConnectMachineDialogProps, "open" | "onOpenChange"> & { onClose: () => void }) {
  const [scope, setScope] = useState<ConnectMachineScope>(defaultScope);
  const [allowScreenControl, setAllowScreenControl] = useState(defaultAllowScreenControl);
  const connected = useNewlyConnectedMachine(
    machines,
    machinesLoading,
    machinesError !== null && machinesError !== undefined,
    scope,
  );
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!connected || reported.current === connected.sandboxId) return;
    reported.current = connected.sandboxId;
    onConnectedRef.current?.(connected);
  }, [connected]);

  if (connected) {
    return <ConnectedStep machine={connected} useInChat={useInChat} onClose={onClose} />;
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect a machine</DialogTitle>
        <DialogDescription>
          Run one command on the computer you want to use. Existing OpenGeni connections on it stay
          as they are.
        </DialogDescription>
      </DialogHeader>
      <ConnectSetup
        workspaceId={workspaceId}
        origin={origin}
        personalWorkspace={personalWorkspace}
        scope={scope}
        onScopeChange={setScope}
        allowScreenControl={allowScreenControl}
        onAllowScreenControlChange={setAllowScreenControl}
      />
    </>
  );
}

function ConnectSetup({
  workspaceId,
  origin,
  personalWorkspace,
  scope,
  onScopeChange,
  allowScreenControl,
  onAllowScreenControlChange,
}: {
  workspaceId: string;
  origin: string;
  personalWorkspace: boolean;
  scope: ConnectMachineScope;
  onScopeChange: (scope: ConnectMachineScope) => void;
  allowScreenControl: boolean;
  onAllowScreenControlChange: (allow: boolean) => void;
}) {
  const [os, setOs] = useState<ConnectOs>(() =>
    detectConnectOs(typeof navigator === "undefined" ? undefined : navigator.userAgent),
  );
  const screenControlId = useId();
  const screenControlHintId = useId();
  const choice = useMemo(() => ({ scope, allowScreenControl }), [scope, allowScreenControl]);
  const { token, minting, error, retry } = useConnectToken(workspaceId, choice);
  const command = token ? installCommandFor(os, origin, { enrollToken: token.value }) : "";
  // A copy result belongs to the exact command copied. A later command (other
  // choices, OS or token) never shows as copied, even when the clipboard
  // answers after the change.
  const [copyResult, setCopyResult] = useState<{ command: string; ok: boolean } | null>(null);
  const shownCopy = command !== "" && copyResult?.command === command ? copyResult : null;
  const copied = shownCopy?.ok === true;
  const copyFailed = shownCopy?.ok === false;

  async function copy() {
    const copying = command;
    if (!copying) return;
    const ok = await copyTextToClipboard(copying);
    setCopyResult({ command: copying, ok });
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-connect-machine-setup="">
      <ChoiceCards
        label="Who can use it?"
        value={scope}
        onValueChange={(value) => onScopeChange(value as ConnectMachineScope)}
      >
        <ChoiceCard
          value="user"
          icon={<UserIcon />}
          title="Only me"
          description="Just you, in every workspace you can open. Nobody else can use it."
        />
        <ChoiceCard
          value="workspace"
          icon={<UsersIcon />}
          title="This workspace"
          description={
            personalWorkspace
              ? "Only in this personal workspace."
              : "Everyone in this workspace can run chats on it."
          }
        />
      </ChoiceCards>

      {/* Screen control is baked into the command, so it is chosen before copying. */}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <label htmlFor={screenControlId} className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-fg">Allow screen control</span>
          <span id={screenControlHintId} className="text-xs leading-4.5 text-fg-muted">
            Agents can see and use its screen. Leave off for terminal-only use.
          </span>
        </label>
        <Switch
          id={screenControlId}
          size="sm"
          aria-describedby={screenControlHintId}
          checked={allowScreenControl}
          onCheckedChange={(checked) => onAllowScreenControlChange(checked)}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <SegmentedControl
          aria-label="Operating system"
          size="sm"
          fullWidth
          options={OS_OPTIONS}
          value={os}
          onValueChange={setOs}
        />
        <p className="text-xs leading-4.5 text-fg-muted">{PASTE_HINT[os]}</p>
        {error ? (
          <Notice
            tone="failed"
            title="Couldn't create a connect command"
            action={
              <Button type="button" variant="outline" size="sm" onClick={retry}>
                Try again
              </Button>
            }
          >
            {error}
          </Notice>
        ) : (
          <div
            className="min-w-0 rounded-[10px] border border-border bg-bg px-3 py-2.5"
            aria-busy={minting || undefined}
          >
            {token ? (
              <pre
                className="max-h-28 min-w-0 overflow-y-auto font-mono text-2xs leading-4 break-all whitespace-pre-wrap text-fg"
                aria-label="Connect command"
                data-connect-command=""
              >
                {command}
              </pre>
            ) : (
              <p className="flex items-center gap-2 text-xs text-fg-muted" role="status">
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                Preparing your command…
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <Button
          type="button"
          className="w-full pointer-coarse:h-11 aria-disabled:cursor-default aria-disabled:opacity-50"
          aria-disabled={!command || undefined}
          onClick={() => {
            if (command) void copy();
          }}
        >
          {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {copied ? "Copied" : "Copy command"}
        </Button>
        {copyFailed ? (
          <p role="alert" className="text-xs text-danger">
            Couldn't copy automatically. Select the command and copy it.
          </p>
        ) : null}
        {/* Only with a command: while preparing or after a failure, Try again is the one action. */}
        {token ? (
          <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-fg-muted">
            {copied ? (
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5" role="status">
                <Loader2Icon aria-hidden className="size-3 shrink-0 animate-spin" />
                Waiting for the machine to connect…
              </span>
            ) : (
              <span className="min-w-0 flex-1">
                {`Works for one machine until ${formatConnectExpiry(token.expiresAt, token.expiresInSeconds)}. Keep it private.`}
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="-mr-2 shrink-0"
              onClick={retry}
            >
              New command
            </Button>
          </div>
        ) : null}
      </div>

      <ManualPairing workspaceId={workspaceId} origin={origin} os={os} />
    </div>
  );
}

/**
 * The device-code path for a terminal that cannot take a pasted command. The
 * installer prints a code; the approval page asks who can use the machine.
 */
function ManualPairing({
  workspaceId,
  origin,
  os,
}: {
  workspaceId: string;
  origin: string;
  os: ConnectOs;
}) {
  const command = installCommandFor(os, origin, { workspaceId });
  const verificationUri = deviceVerificationUri(origin);
  // Copied only while the copied command is the one shown (a late clipboard
  // answer for another OS never marks this one).
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const copied = copiedCommand === command;
  return (
    <Disclosure
      title="Pair with a code instead"
      summary="For a terminal you can't paste a command into."
      className="border-t border-border pt-1"
    >
      <ol className="flex min-w-0 list-decimal flex-col gap-3 pl-4 text-xs leading-4.5 text-fg-muted">
        <li className="min-w-0 pl-1">
          <span>Run this on the machine. It prints a short code.</span>
          <div className="mt-1.5 flex min-w-0 items-start gap-1 rounded-[10px] border border-border bg-bg py-1.5 pr-1 pl-3">
            <code
              className="min-w-0 flex-1 py-1 font-mono text-2xs leading-4 break-all whitespace-pre-wrap text-fg"
              data-manual-command=""
            >
              {command}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={copied ? "Copied" : "Copy pairing command"}
              onClick={() => {
                const copying = command;
                void copyTextToClipboard(copying).then((ok) =>
                  setCopiedCommand((previous) =>
                    ok ? copying : previous === copying ? null : previous,
                  ),
                );
              }}
            >
              {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            </Button>
          </div>
        </li>
        <li className="min-w-0 pl-1">
          <span>
            Enter the code on the approval page. You choose who can use the machine there.
          </span>
          <div className="mt-1.5">
            <Button asChild variant="outline" size="sm">
              <a href={verificationUri} target="_blank" rel="noreferrer">
                Open approval page
                <ExternalLinkIcon aria-hidden />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          </div>
        </li>
      </ol>
    </Disclosure>
  );
}

function ConnectedStep({
  machine,
  useInChat,
  onClose,
}: {
  machine: MachineView;
  useInChat: ConnectMachineDialogProps["useInChat"];
  onClose: () => void;
}) {
  const name = machineDisplayName(machine);
  const Icon = machine.os === "linux" && !machine.hasDisplay ? ServerIcon : LaptopIcon;
  const canUse = Boolean(useInChat?.canUse);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Machine connected</DialogTitle>
        <DialogDescription>
          {canUse
            ? "Use it for this chat now, or pick it later from the machine list."
            : "It's ready to run chats."}
        </DialogDescription>
      </DialogHeader>
      <div
        className="flex min-w-0 items-center gap-3"
        role="status"
        aria-live="polite"
        data-connected-machine={machine.sandboxId}
      >
        <LogoTile size="md" icon={<Icon />} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-fg">{name}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-fg-muted">
            <StatusBadge status="connected" variant="dot" />
            <span aria-hidden>·</span>
            <span data-connected-scope={machine.scope}>{machineScopeLabel(machine.scope)}</span>
          </span>
        </div>
      </div>
      <DialogFooter>
        {canUse ? (
          <>
            <Button type="button" variant="outline" onClick={onClose}>
              Done
            </Button>
            <Button
              type="button"
              onClick={() => {
                useInChat?.onUse(machine);
                onClose();
              }}
            >
              Use in this chat
            </Button>
          </>
        ) : (
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
