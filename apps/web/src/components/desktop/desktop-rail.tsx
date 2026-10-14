// The rail's desktop app pieces: offering this computer to agents, switching
// between the app's accounts, and telling the app which workspace is open.
// Each renders nothing outside the desktop app.
import type { DesktopAccountsSnapshot, ThisComputerStatus } from "@opengeni/desktop/contract";
import { CheckIcon, LaptopIcon, LogOutIcon, PlusIcon, UsersIcon } from "lucide-react";
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

function dismissedKey(workspaceId: string) {
  return `opengeni.desktop.thisComputer.dismissed.${workspaceId}`;
}

function readDismissed(workspaceId: string): boolean {
  try {
    return window.localStorage.getItem(dismissedKey(workspaceId)) === "1";
  } catch {
    return false;
  }
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => readDismissed(workspaceId));
  useEffect(() => setDismissed(readDismissed(workspaceId)), [workspaceId]);
  if (!bridge || !status) return null;

  if (status.state === "paused") {
    return (
      <div className="mx-2 mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface/70 px-2.5 py-2 text-xs">
        <LaptopIcon className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-fg-label">This computer is paused</span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={status.busy}
          onClick={() => {
            void bridge.thisComputer.resume().catch((caught: unknown) =>
              toast.error("Couldn't resume this computer", {
                description: bridgeErrorText(caught, `Try again from the ${trayName()}.`),
              }),
            );
          }}
        >
          {status.busy ? "Resuming…" : "Resume"}
        </Button>
      </div>
    );
  }

  const offer = status.state === "not_installed" || status.state === "not_connected";
  if (!offer || (dismissed && !dialogOpen)) return null;

  return (
    <>
      <div className="mx-2 mt-2 rounded-lg border border-border bg-surface/70 p-3">
        <div className="flex items-start gap-2.5">
          <LaptopIcon className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">Use this computer</p>
            {/* Short windows keep room for the sessions list. */}
            <p className="mt-0.5 text-xs leading-snug text-fg-muted [@media(max-height:640px)]:hidden">
              Let agents work on {status.machineName}.
            </p>
          </div>
        </div>
        <div className="mt-2.5 flex items-center gap-1.5 pl-[26px]">
          <Button type="button" size="xs" onClick={() => setDialogOpen(true)}>
            Set up
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              try {
                window.localStorage.setItem(dismissedKey(workspaceId), "1");
              } catch {
                // Hides for this page only.
              }
              setDismissed(true);
            }}
          >
            Not now
          </Button>
        </div>
      </div>
      <ThisComputerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspaceId={workspaceId}
        status={status}
        onConnected={(next) => {
          setStatus(next);
          setDialogOpen(false);
          toast.success("This computer is connected", {
            description: `Pause it any time from the ${trayName()}.`,
          });
        }}
      />
    </>
  );
}

function ThisComputerDialog({
  open,
  onOpenChange,
  workspaceId,
  status,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  status: ThisComputerStatus;
  onConnected: (status: ThisComputerStatus) => void;
}) {
  const bridge = desktopCapability("thisComputer");
  const [screenControl, setScreenControl] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installing = status.state === "not_installed";

  async function connect() {
    if (!bridge) return;
    setConnecting(true);
    setError(null);
    try {
      const next = await bridge.thisComputer.connect(workspaceId, { screenControl });
      if (next.state === "connected") onConnected(next);
      else setError(next.error ?? "This computer didn't come online. Try again.");
    } catch (caught) {
      setError(bridgeErrorText(caught, "Couldn't connect this computer."));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !connecting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Use this computer</DialogTitle>
          <DialogDescription>
            Agents in this workspace can work on {status.machineName}: run commands, edit files and
            use your browser. Only you can use it, and you can pause it any time from the{" "}
            {trayName()}.
          </DialogDescription>
        </DialogHeader>
        <label className="mt-4 flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-border p-3">
          <span className="grid gap-0.5">
            <span className="text-sm font-medium text-fg">See and control the screen</span>
            <span className="text-xs leading-snug text-fg-muted">
              {desktopBridge?.platform === "macos"
                ? "Lets agents use apps. macOS asks for Screen Recording and Accessibility the first time."
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
          {connecting && installing ? (
            <span className="mr-auto text-xs text-fg-muted">
              The first setup takes about a minute.
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={connecting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={connecting} onClick={() => void connect()}>
            {connecting ? (installing ? "Installing…" : "Connecting…") : "Connect"}
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
