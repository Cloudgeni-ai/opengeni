// The rail's desktop app pieces: offering this computer to agents, switching
// between the app's accounts, and telling the app which workspace is open.
// Each renders nothing outside the desktop app.
import type {
  DesktopAccountsSnapshot,
  ThisComputerPermissionId,
  ThisComputerStatus,
} from "@opengeni/desktop/contract";
import {
  CheckIcon,
  KeyboardIcon,
  LaptopIcon,
  Loader2Icon,
  LogOutIcon,
  MonitorIcon,
  MousePointerClickIcon,
  PlusIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/context";
import { desktopBridge, desktopCapability } from "@/lib/desktop";

/** Keep the desktop app's links, notifications and computer on the open workspace. */
export function useDesktopWorkspace(workspaceId: string): void {
  useEffect(() => {
    desktopCapability("accounts")?.accounts.setWorkspace(workspaceId);
  }, [workspaceId]);
}

function dismissedKey(workspaceId: string, offer: "connect" | "permissions") {
  return offer === "connect"
    ? `opengeni.desktop.thisComputer.dismissed.${workspaceId}`
    : `opengeni.desktop.thisComputer.permissionsDismissed.${workspaceId}`;
}

function readDismissed(workspaceId: string, offer: "connect" | "permissions"): boolean {
  try {
    return window.localStorage.getItem(dismissedKey(workspaceId, offer)) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(workspaceId: string, offer: "connect" | "permissions"): void {
  try {
    window.localStorage.setItem(dismissedKey(workspaceId, offer), "1");
  } catch {
    // Hides for this page only.
  }
}

/** Screen control still waits on a system permission. */
function needsPermissions(status: ThisComputerStatus): boolean {
  return (
    status.state === "connected" &&
    Boolean(status.permissions?.some((permission) => !permission.granted))
  );
}

/** The bridge's error text without Electron's IPC prefix. */
function bridgeErrorText(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error) || !caught.message) return fallback;
  return caught.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "");
}

/** Where the app's menu bar item lives on this platform. */
function trayName(): string {
  return desktopBridge?.platform === "macos" ? "menu bar" : "tray";
}

function useThisComputer(workspaceId: string) {
  // Only where the deployment lets people connect their own computers.
  const { clientConfig } = useAppContext();
  const offered = clientConfig.connectedMachines !== false;
  const bridge = offered ? desktopCapability("thisComputer") : null;
  const [status, setStatus] = useState<ThisComputerStatus | null>(null);
  const refresh = useCallback(() => {
    if (!bridge) return;
    void bridge.thisComputer
      .status(workspaceId)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [bridge, workspaceId]);
  useEffect(() => {
    refresh();
    if (!bridge) return;
    const unsubscribe = bridge.thisComputer.onChange(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [bridge, refresh]);
  return { bridge, status, setStatus };
}

/**
 * Above the account row: until this computer serves the open workspace, a
 * quiet offer to let agents use it; while it is paused, a way to resume.
 */
export function DesktopThisComputerCard({ workspaceId }: { workspaceId: string }) {
  const { bridge, status, setStatus } = useThisComputer(workspaceId);
  const [dialog, setDialog] = useState<"connect" | "permissions" | null>(null);
  const [dismissed, setDismissed] = useState(() => readDismissed(workspaceId, "connect"));
  const [permissionsDismissed, setPermissionsDismissed] = useState(() =>
    readDismissed(workspaceId, "permissions"),
  );
  useEffect(() => {
    setDismissed(readDismissed(workspaceId, "connect"));
    setPermissionsDismissed(readDismissed(workspaceId, "permissions"));
  }, [workspaceId]);
  if (!bridge || !status) return null;

  const dialogElement = (
    <ThisComputerDialog
      step={dialog}
      onStepChange={setDialog}
      workspaceId={workspaceId}
      status={status}
      onStatus={setStatus}
    />
  );

  const offer = status.state === "not_installed" || status.state === "not_connected";
  // Taking over an agent installed earlier downloads the app's own copy first.
  if (offer && status.busy && !dialog) {
    return (
      <div
        role="status"
        className="mx-2 mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface/70 px-2.5 py-2 text-xs"
      >
        <Loader2Icon className="size-4 shrink-0 animate-spin text-fg-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate leading-6 text-fg-label">
          Setting up this computer…{setupPercent(status)}
        </span>
      </div>
    );
  }

  if (status.state === "paused") {
    // Resuming can take a moment, so the row says what is happening instead of
    // squeezing a busy button in.
    if (status.busy) {
      return (
        <div
          role="status"
          className="mx-2 mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface/70 px-2.5 py-2 text-xs"
        >
          <Loader2Icon className="size-4 shrink-0 animate-spin text-fg-muted" aria-hidden />
          {/* leading-6 matches the Resume button's height, so the row does not jump. */}
          <span className="min-w-0 flex-1 truncate leading-6 text-fg-label">
            Resuming this computer…
          </span>
        </div>
      );
    }
    return (
      <div className="mx-2 mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface/70 px-2.5 py-2 text-xs">
        <LaptopIcon className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-fg-label">This computer is paused</span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => {
            void bridge.thisComputer.resume().catch((caught: unknown) =>
              toast.error("Couldn't resume this computer", {
                description: bridgeErrorText(caught, `Try again from the ${trayName()}.`),
              }),
            );
          }}
        >
          Resume
        </Button>
      </div>
    );
  }

  if (needsPermissions(status) && (!permissionsDismissed || dialog)) {
    return (
      <>
        <OfferCard
          title="Finish setting up"
          body="Agents can't see or control the screen yet."
          action="Continue"
          onAction={() => setDialog("permissions")}
          onDismiss={() => {
            writeDismissed(workspaceId, "permissions");
            setPermissionsDismissed(true);
          }}
        />
        {dialogElement}
      </>
    );
  }

  // The dialog stays up from connecting through the permissions step.
  if (!dialog && (!offer || dismissed)) return null;

  return (
    <>
      {offer ? (
        <OfferCard
          title="Use this computer"
          body={`Let agents work on ${status.machineName}.`}
          action="Set up"
          onAction={() => setDialog("connect")}
          onDismiss={() => {
            writeDismissed(workspaceId, "connect");
            setDismissed(true);
          }}
        />
      ) : null}
      {dialogElement}
    </>
  );
}

/** " 42%" while the agent downloads. */
function setupPercent(status: ThisComputerStatus): string {
  return status.setupProgress === undefined ? "" : ` ${Math.round(status.setupProgress * 100)}%`;
}

function OfferCard({
  title,
  body,
  action,
  onAction,
  onDismiss,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mx-2 mt-2 rounded-lg border border-border bg-surface/70 p-3">
      <div className="flex items-start gap-2.5">
        <LaptopIcon className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">{title}</p>
          {/* Short windows keep room for the sessions list. */}
          <p className="mt-0.5 text-xs leading-snug text-fg-muted [@media(max-height:640px)]:hidden">
            {body}
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 pl-[26px]">
        <Button type="button" size="xs" onClick={onAction}>
          {action}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onDismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}

const PERMISSION_COPY: Record<
  ThisComputerPermissionId,
  { name: string; why: string; icon: typeof MonitorIcon }
> = {
  screenRecording: {
    name: "Screen Recording",
    why: "So agents can see the screen.",
    icon: MonitorIcon,
  },
  accessibility: {
    name: "Accessibility",
    why: "So agents can click and type.",
    icon: MousePointerClickIcon,
  },
  inputMonitoring: {
    name: "Input Monitoring",
    why: "So agents stop when you use the mouse or keyboard.",
    icon: KeyboardIcon,
  },
};

function ThisComputerDialog({
  step,
  onStepChange,
  workspaceId,
  status,
  onStatus,
}: {
  step: "connect" | "permissions" | null;
  onStepChange: (step: "connect" | "permissions" | null) => void;
  workspaceId: string;
  status: ThisComputerStatus;
  onStatus: (status: ThisComputerStatus) => void;
}) {
  const bridge = desktopCapability("thisComputer");
  const [screenControl, setScreenControl] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow System Settings while the person turns permissions on there.
  useEffect(() => {
    if (step !== "permissions" || !bridge) return;
    const timer = window.setInterval(() => {
      void bridge.thisComputer
        .status(workspaceId)
        .then(onStatus)
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [step, bridge, workspaceId, onStatus]);

  const finished =
    step === "permissions" && status.state === "connected" && !needsPermissions(status);
  useEffect(() => {
    if (!finished) return;
    onStepChange(null);
    toast.success("This computer is ready", {
      description: "Agents can now see and use the screen.",
    });
  }, [finished, onStepChange]);

  async function connect() {
    if (!bridge) return;
    setConnecting(true);
    setError(null);
    try {
      const next = await bridge.thisComputer.connect(workspaceId, { screenControl });
      onStatus(next);
      if (next.state !== "connected") {
        setError(next.error ?? "This computer didn't come online. Try again.");
      } else if (needsPermissions(next)) {
        onStepChange("permissions");
      } else {
        onStepChange(null);
        toast.success("This computer is connected", {
          description: `Pause it any time from the ${trayName()}.`,
        });
      }
    } catch (caught) {
      setError(bridgeErrorText(caught, "Couldn't connect this computer."));
    } finally {
      setConnecting(false);
    }
  }

  const open = step !== null;
  const onOpenChange = (next: boolean) => {
    if (!next && !connecting) onStepChange(null);
  };

  if (step === "permissions") {
    const permissions = status.permissions ?? [];
    const nextMissing = permissions.find((permission) => !permission.granted)?.id;
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Allow screen control</DialogTitle>
            <DialogDescription>
              macOS asks you to allow these for {desktopBridge?.productName ?? "the app"}. Turn each
              one on in System Settings; this updates as you go.
            </DialogDescription>
          </DialogHeader>
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {permissions.map((permission) => {
              const copy = PERMISSION_COPY[permission.id];
              const Icon = copy.icon;
              return (
                <li key={permission.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="text-sm font-medium text-fg">{copy.name}</span>
                    <span className="text-xs leading-snug text-fg-muted">{copy.why}</span>
                  </span>
                  {permission.granted ? (
                    <span className="flex h-7 items-center gap-1 text-xs font-medium text-success">
                      <CheckIcon className="size-3.5" aria-hidden />
                      Allowed
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="xs"
                      variant={permission.id === nextMissing ? "default" : "outline"}
                      onClick={() => {
                        void bridge?.thisComputer.requestPermission?.(permission.id);
                      }}
                    >
                      Allow
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          <DialogFooter className="mt-5 items-center">
            <span className="mr-auto text-xs text-fg-muted">
              If macOS offers to quit {desktopBridge?.productName ?? "the app"}, choose Later.
            </span>
            <Button type="button" variant="ghost" onClick={() => onStepChange(null)}>
              Not now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Use this computer</DialogTitle>
          <DialogDescription>
            Your agents can work on {status.machineName}: run commands, edit files and use your
            browser. No one else can use it, and you can pause it any time from the {trayName()}.
          </DialogDescription>
        </DialogHeader>
        <label className="mt-4 flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-border p-3">
          <span className="grid gap-0.5">
            <span className="text-sm font-medium text-fg">See and control the screen</span>
            <span className="text-xs leading-snug text-fg-muted">
              {desktopBridge?.platform === "macos"
                ? "Lets agents use apps. You'll allow it in System Settings next."
                : "Lets agents use apps, not only the command line."}
            </span>
          </span>
          <Switch
            checked={screenControl}
            onCheckedChange={setScreenControl}
            disabled={connecting}
            aria-label="See and control the screen"
          />
        </label>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter className="mt-5 items-center">
          {connecting && status.setupProgress !== undefined ? (
            <span className="mr-auto text-xs text-fg-muted">Downloading the agent, once.</span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={connecting}
            onClick={() => onStepChange(null)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={connecting} onClick={() => void connect()}>
            {connecting
              ? status.setupProgress !== undefined
                ? `Setting up…${setupPercent(status)}`
                : "Connecting…"
              : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useDesktopAccounts(): DesktopAccountsSnapshot | null {
  const bridge = desktopCapability("accounts");
  const [snapshot, setSnapshot] = useState<DesktopAccountsSnapshot | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.accounts.list().then((next) => {
      if (live) setSnapshot(next);
    });
    const unsubscribe = bridge.accounts.onChange(setSnapshot);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);
  return snapshot;
}

/** Whether the account menu should show the desktop app's accounts instead of the web's sign-out. */
export function hasDesktopAccounts(): boolean {
  return Boolean(desktopCapability("accounts"));
}

/**
 * The account menu inside the desktop app: switch between the app's accounts,
 * add one, and sign this one out of the app (which also ends its web session).
 */
export function DesktopAccountMenuItems() {
  const bridge = desktopCapability("accounts");
  const snapshot = useDesktopAccounts();
  if (!bridge) return null;
  const accounts = snapshot?.accounts ?? [];
  const activeId = snapshot?.activeId ?? null;
  const others = accounts.filter((account) => account.id !== activeId);
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <UsersIcon />
          Accounts
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-[min(18rem,calc(100vw-1rem))]">
          {accounts.map((account) => (
            <DropdownMenuItem
              key={account.id}
              onSelect={() => {
                if (account.id !== activeId) void bridge.accounts.switchTo(account.id);
              }}
              className="items-start"
            >
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-sm text-fg">{account.email}</span>
                <span className="truncate text-xs text-fg-muted">
                  {account.signedOut ? `${account.serverLabel} · Signed out` : account.serverLabel}
                </span>
              </span>
              {account.id === activeId ? (
                <CheckIcon className="mt-0.5 size-4 shrink-0" aria-label="Current account" />
              ) : null}
            </DropdownMenuItem>
          ))}
          {accounts.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => void bridge.accounts.add()}>
            <PlusIcon />
            Add account…
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        disabled={!activeId}
        onSelect={() => {
          if (activeId) void bridge.accounts.signOut(activeId);
        }}
      >
        <LogOutIcon />
        {others.length > 0 ? "Sign out of this account" : "Sign out"}
      </DropdownMenuItem>
    </>
  );
}
