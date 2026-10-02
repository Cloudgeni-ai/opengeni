import { AppearanceSubmenu } from "@/components/appearance-menu";
import { HelpMenu } from "@/components/help-menu";
import { useBrowserAccounts } from "@opengeni/react/accounts";
import type { ManagedAuthSessionSetProjection } from "@opengeni/sdk/accounts";
import { CheckIcon, LogOutIcon, RefreshCwIcon, UserRoundPlusIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AccountTrigger } from "@/components/rail/account-trigger";
import { useRail } from "@/components/rail/rail-context";
import { AccountUsageMenuItem } from "@/components/usage/usage-entry";
import { useNewOrganizationMenuItem } from "@/components/rail/switcher-block";
import {
  accountMenuAriaLabel,
  OrganizationInvitationsDialog,
  OrganizationInvitationsMenuItem,
  useOrganizationInvitations,
} from "@/components/organization-invitations";
import { useBrowserAccountPopup } from "@/components/use-browser-account-popup";
import { useAppContext } from "@/context";
import { userErrorText } from "@/lib/api-error";

type ManagedAuthLoginSlot = ManagedAuthSessionSetProjection["slots"][number];

function slotLabel(slot: ManagedAuthLoginSlot): string {
  return `${slot.displayName}, ${slot.verifiedClaim.value}`;
}

export function BrowserAccountMenu({
  onSendFeedback,
}: {
  onSendFeedback?: (() => void) | undefined;
}) {
  const rail = useRail();
  const context = useAppContext();
  const accounts = useBrowserAccounts();
  const popup = useBrowserAccountPopup();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [logoutTarget, setLogoutTarget] = useState<ManagedAuthLoginSlot | null>(null);
  const [replacementSlotId, setReplacementSlotId] = useState<string | null>(null);
  const [logoutAllOpen, setLogoutAllOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const projection = accounts.projection;
  const selected = projection?.slots.find((slot) => slot.id === projection.selectedSlotId) ?? null;
  const busy = accounts.phase === "committing" || accounts.phase === "loading";
  const displayName =
    selected?.displayName ??
    context.authSession?.user.name ??
    context.authSession?.user.email ??
    context.accessContext.subjectLabel ??
    context.accessContext.subjectId;
  const image = context.authSession?.user.image ?? undefined;
  const newOrganization = useNewOrganizationMenuItem();
  const organizationInvitations = useOrganizationInvitations({
    client: context.client,
    enabled: true,
    activeEmail: selected?.verifiedClaim.value ?? context.authSession?.user.email ?? null,
    onUseInvitedAccount: continueInvitation,
    onAccepted: context.revalidatePrincipalAccess,
  });
  const replacementSlots = useMemo(
    () =>
      projection?.slots.filter((slot) => slot.id !== logoutTarget?.id && slot.state === "active") ??
      [],
    [logoutTarget?.id, projection?.slots],
  );

  useEffect(() => {
    if (accounts.phase === "loading") setAnnouncement("Loading the selected account");
    if (accounts.phase === "ready" && selected) {
      setAnnouncement(`Active account: ${slotLabel(selected)}`);
    }
    if (accounts.phase === "recoverable_error") {
      setAnnouncement("The account action needs attention");
    }
  }, [accounts.phase, selected]);

  function restoreFocus() {
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  function authenticate(kind: "add" | "reauth", slot?: ManagedAuthLoginSlot) {
    popup.open(() => (kind === "add" ? accounts.beginAdd() : accounts.beginReauth(slot!.id)), {
      onSettled: restoreFocus,
      onError: (error) =>
        toast.error("Couldn't start account authentication", {
          description: userErrorText(error),
        }),
    });
  }

  function chooseSlot(slot: ManagedAuthLoginSlot) {
    if (slot.state === "reauth_required") {
      authenticate("reauth", slot);
      return;
    }
    if (slot.id === projection?.selectedSlotId) return;
    void accounts
      .selectSlot(slot.id)
      .then((settled) => {
        if (settled) restoreFocus();
      })
      .catch((error) =>
        toast.error("Couldn't switch accounts", { description: userErrorText(error) }),
      );
  }

  function continueInvitation(targetEmail: string) {
    const targetSlot = projection?.slots.find(
      (slot) => slot.verifiedClaim.value.trim().toLowerCase() === targetEmail.trim().toLowerCase(),
    );
    if (!targetSlot) {
      authenticate("add");
      return;
    }
    chooseSlot(targetSlot);
  }

  function requestLogout(slot: ManagedAuthLoginSlot) {
    const alternatives =
      projection?.slots.filter(
        (candidate) => candidate.id !== slot.id && candidate.state === "active",
      ) ?? [];
    setLogoutTarget(slot);
    setReplacementSlotId(
      slot.id === projection?.selectedSlotId ? (alternatives[0]?.id ?? null) : null,
    );
  }

  async function confirmLogoutOne() {
    if (!logoutTarget) return;
    try {
      const settled = await accounts.logoutSlot(logoutTarget.id, replacementSlotId);
      if (settled) {
        setLogoutTarget(null);
        restoreFocus();
      }
    } catch (error) {
      toast.error("Couldn't sign out this account", {
        description: userErrorText(error),
      });
    }
  }

  async function confirmLogoutAll() {
    try {
      const settled = await accounts.logoutAll();
      if (settled) setLogoutAllOpen(false);
    } catch (error) {
      toast.error("Couldn't sign out all browser accounts", {
        description: userErrorText(error),
      });
    }
  }

  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <AccountTrigger
            ref={triggerRef}
            collapsed={rail.collapsed}
            displayName={displayName}
            image={image}
            pendingCount={organizationInvitations.pendingCount}
            busy={busy}
            aria-label={accountMenuAriaLabel({
              displayName,
              pendingCount: organizationInvitations.pendingCount,
            })}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // Own the Enter transition so native button activation cannot
              // immediately toggle Radix closed on Firefox or WebKit.
              event.preventDefault();
              setMenuOpen(true);
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          tabIndex={0}
          align="start"
          side={rail.collapsed ? "right" : "top"}
          className="w-[min(22rem,calc(100vw-1rem))] forced-colors:border-[CanvasText] forced-colors:text-[CanvasText]! motion-reduce:[&_*]:animate-none"
        >
          <DropdownMenuLabel className="flex items-center gap-2 forced-colors:text-[CanvasText]!">
            <UsersIcon className="size-4" />
            Browser accounts
            {projection ? (
              <DropdownMenuMeta className="forced-colors:text-[CanvasText]!">
                {projection.slots.length}/8
              </DropdownMenuMeta>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {projection?.slots.map((slot) => (
            <DropdownMenuSub key={slot.id}>
              <DropdownMenuSubTrigger className="whitespace-normal forced-colors:text-[CanvasText]!">
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate">{slot.displayName}</span>
                  <span className="truncate text-xs text-fg-muted forced-colors:text-[CanvasText]!">
                    {slot.verifiedClaim.value}
                    {slot.state === "reauth_required" ? " · Re-authentication required" : ""}
                  </span>
                </span>
                <DropdownMenuCheck
                  checked={slot.id === projection.selectedSlotId}
                  className="ml-0"
                />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-[min(18rem,calc(100vw-1rem))] forced-colors:text-[CanvasText]!">
                <DropdownMenuItem
                  className="forced-colors:text-[CanvasText]!"
                  disabled={
                    busy || slot.id === projection.selectedSlotId || slot.state !== "active"
                  }
                  onSelect={() => chooseSlot(slot)}
                >
                  <CheckIcon className="size-4" />
                  Use this account
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onSelect={() => authenticate("reauth", slot)}>
                  <RefreshCwIcon className="size-4" />
                  Re-authenticate
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="forced-colors:text-[CanvasText]!"
                  variant="destructive"
                  disabled={busy}
                  onSelect={() => requestLogout(slot)}
                >
                  <LogOutIcon className="size-4" />
                  Sign out this account
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
          {projection?.slots.length === 0 ? (
            <DropdownMenuItem disabled>No active accounts</DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="forced-colors:text-[CanvasText]!"
            disabled={busy || (projection?.slots.length ?? 8) >= 8}
            onSelect={() => authenticate("add")}
          >
            <UserRoundPlusIcon className="size-4" />
            Add another account
          </DropdownMenuItem>
          <OrganizationInvitationsMenuItem
            controller={organizationInvitations}
            className="forced-colors:text-[CanvasText]!"
            disabled={busy}
          />
          {newOrganization.item}
          <DropdownMenuSeparator />
          <AccountUsageMenuItem workspaceId={rail.workspaceId} />
          <AppearanceSubmenu />
          <HelpMenu
            documentationUrl={context.clientConfig.documentationUrl}
            supportEmail={context.clientConfig.supportEmail}
            onSendFeedback={onSendFeedback}
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="forced-colors:text-[CanvasText]!"
            variant="destructive"
            disabled={busy || !projection?.slots.length}
            onSelect={() => setLogoutAllOpen(true)}
          >
            <LogOutIcon className="size-4" />
            Sign out all browser accounts
          </DropdownMenuItem>
          {accounts.phase === "recoverable_error" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  const retry = accounts.hasPendingTransition
                    ? accounts.continueTransition()
                    : accounts.refresh();
                  void retry.catch((error) =>
                    toast.error("Couldn't reconcile account state", {
                      description: userErrorText(error),
                    }),
                  );
                }}
              >
                <RefreshCwIcon className="size-4" />
                {accounts.hasPendingTransition ? "Retry account action" : "Reconcile account state"}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <OrganizationInvitationsDialog controller={organizationInvitations} />
      {newOrganization.dialog}

      <Dialog open={logoutTarget !== null} onOpenChange={(open) => !open && setLogoutTarget(null)}>
        <DialogContent className="motion-reduce:duration-0">
          <DialogHeader>
            <DialogTitle>Sign out {logoutTarget?.displayName}?</DialogTitle>
            <DialogDescription>
              Only this browser login slot is revoked. Other accounts remain signed in.
            </DialogDescription>
          </DialogHeader>
          {logoutTarget?.id === projection?.selectedSlotId && replacementSlots.length > 0 ? (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Account to use next</legend>
              {replacementSlots.map((slot) => (
                <label
                  key={slot.id}
                  className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 py-2 forced-colors:border-[CanvasText]"
                >
                  <input
                    type="radio"
                    name="replacement-account"
                    value={slot.id}
                    checked={replacementSlotId === slot.id}
                    onChange={() => setReplacementSlotId(slot.id)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{slot.displayName}</span>
                    <span className="block truncate text-xs text-fg-subtle">
                      {slot.verifiedClaim.value}
                    </span>
                  </span>
                </label>
              ))}
              <label className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 py-2 forced-colors:border-[CanvasText]">
                <input
                  type="radio"
                  name="replacement-account"
                  checked={replacementSlotId === null}
                  onChange={() => setReplacementSlotId(null)}
                />
                <span className="text-sm">Return to sign in</span>
              </label>
            </fieldset>
          ) : null}
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setLogoutTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmLogoutOne()}>
              Sign out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={logoutAllOpen} onOpenChange={setLogoutAllOpen}>
        <DialogContent className="motion-reduce:duration-0">
          <DialogHeader>
            <DialogTitle>Sign out all browser accounts?</DialogTitle>
            <DialogDescription>
              This revokes only this browser session set. Other browsers and devices are not
              affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setLogoutAllOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmLogoutAll()}>
              Sign out all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={accounts.phase === "blocked"}>
        <DialogContent showCloseButton={false} className="motion-reduce:duration-0">
          <DialogHeader>
            <DialogTitle>Finish work before changing accounts</DialogTitle>
            <DialogDescription>
              Continuing clears account-bound drafts and activity. Review these blockers first.
            </DialogDescription>
          </DialogHeader>
          <ul className="grid gap-2" aria-label="Account transition blockers">
            {accounts.blockers.map((blocker) => (
              <li key={blocker.id} className="rounded-md border border-border p-3 text-sm">
                <span className="block font-medium">{blocker.label}</span>
                {blocker.detail ? (
                  <span className="mt-1 block text-fg-subtle">{blocker.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => accounts.cancelPendingTransition()}>
              Keep working
            </Button>
            <Button
              onClick={() =>
                void accounts.continueTransition().catch((error) =>
                  toast.error("Couldn't change accounts", {
                    description: userErrorText(error),
                  }),
                )
              }
            >
              Continue and clear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
