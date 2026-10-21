// The rail's desktop app pieces: switching between the app's accounts and
// telling the app which workspace is open. Each renders nothing outside the
// desktop app. Offering this computer to agents lives in ./this-computer.
import type { DesktopAccountsSnapshot } from "@opengeni/desktop/contract";
import { CheckIcon, LogOutIcon, PlusIcon, UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@opengeni/react/ui/dropdown-menu";
import { desktopCapability } from "@/lib/desktop";

/** Keep the desktop app's links, notifications and computer on the open workspace. */
export function useDesktopWorkspace(workspaceId: string): void {
  useEffect(() => {
    desktopCapability("accounts")?.accounts.setWorkspace(workspaceId);
  }, [workspaceId]);
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
