import {
  BrowserAccountsProvider,
  useBrowserAccountTransitionBlocker,
  useBrowserAccounts,
  type BrowserAccountTransition,
} from "@opengeni/react/accounts";
import { createBrowserAccountsClient } from "@opengeni/sdk/accounts";
import { Loader2Icon, UserRoundPlusIcon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";

import {
  apiBaseUrl,
  managedActorMutationBusySnapshot,
  subscribeManagedActorInvalidation,
  subscribeManagedActorMutationBusy,
} from "@/api";
import { Button } from "@/components/ui/button";
import { LoadingPanel, ProblemPanel } from "@/components/common";
import { useBrowserAccountPopup } from "@/components/use-browser-account-popup";
import {
  browserAccountBridgeBlockersSnapshot,
  installBrowserAccountBridgeOperations,
  subscribeBrowserAccountBridgeBlockers,
} from "@/lib/browser-account-bridge";
import {
  clearOrganizationInvitationContinuation,
  type OrganizationInvitationContinuation,
} from "@/lib/organization-invitation-continuation";

export type BrowserAccountsRuntimeProps = {
  bootstrapLegacySession: boolean;
  onActorTransition: (transition: BrowserAccountTransition) => Promise<void>;
  mutationBusy: boolean;
  children?: ReactNode;
};

export function BrowserAccountsRuntime({
  bootstrapLegacySession,
  onActorTransition,
  mutationBusy,
  children,
}: BrowserAccountsRuntimeProps) {
  const client = useMemo(() => createBrowserAccountsClient({ baseUrl: apiBaseUrl }), []);
  return (
    <BrowserAccountsProvider
      client={client}
      bootstrapLegacySession={bootstrapLegacySession}
      onActorTransition={onActorTransition}
    >
      <RootMutationBlocker busy={mutationBusy} />
      <ExternalActorInvalidation />
      <BrowserAccountBridge />
      {children}
    </BrowserAccountsProvider>
  );
}

function BrowserAccountBridge() {
  const accounts = useBrowserAccounts();
  const registerTransitionBlocker = accounts.registerTransitionBlocker;
  const resolveDeepLink = accounts.resolveDeepLink;
  const selectSlot = accounts.selectSlot;
  const blockers = useSyncExternalStore(
    subscribeBrowserAccountBridgeBlockers,
    browserAccountBridgeBlockersSnapshot,
    browserAccountBridgeBlockersSnapshot,
  );
  useEffect(() => {
    const unregister = blockers.map(({ id, inspect }) => registerTransitionBlocker(id, inspect));
    return () => {
      for (const release of unregister) release();
    };
  }, [blockers, registerTransitionBlocker]);
  useEffect(
    () =>
      installBrowserAccountBridgeOperations({
        resolveDeepLink,
        selectSlot,
      }),
    [resolveDeepLink, selectSlot],
  );
  return null;
}

function RootMutationBlocker({ busy }: { busy: boolean }) {
  const transportMutationBusy = useSyncExternalStore(
    subscribeManagedActorMutationBusy,
    managedActorMutationBusySnapshot,
    managedActorMutationBusySnapshot,
  );
  useBrowserAccountTransitionBlocker("root-mutation", () =>
    busy || transportMutationBusy
      ? {
          id: "root-mutation",
          label: "An account-scoped operation is still running",
          detail: "Wait for it to finish before changing accounts.",
        }
      : null,
  );
  return null;
}

function ExternalActorInvalidation() {
  const accounts = useBrowserAccounts();
  const invalidateActor = accounts.invalidateActor;
  useEffect(
    () =>
      subscribeManagedActorInvalidation(() => {
        void invalidateActor().catch(() => undefined);
      }),
    [invalidateActor],
  );
  return null;
}

export function BrowserAccountsSignedOutPanel(props: {
  emptySetRegistrationPanel?: ReactNode;
  invitation?: OrganizationInvitationContinuation | null;
}) {
  const accounts = useBrowserAccounts();
  const popup = useBrowserAccountPopup();
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [invitationDismissed, setInvitationDismissed] = useState(false);
  const busy = accounts.phase === "committing" || accounts.phase === "loading";
  const slots = accounts.projection?.slots ?? [];
  const invitation = invitationDismissed ? null : (props.invitation ?? null);
  const invitedSlot = invitation
    ? (slots.find(
        (slot) =>
          normalizeEmail(slot.verifiedClaim.value) === normalizeEmail(invitation.targetEmail),
      ) ?? null)
    : null;
  const visibleSlots = invitation ? (invitedSlot ? [invitedSlot] : []) : slots;

  function authenticate(kind: "add" | "reauth", slotId?: string) {
    popup.open(() => (kind === "add" ? accounts.beginAdd() : accounts.beginReauth(slotId!)), {
      onError: (error) =>
        toast.error("Couldn't start account authentication", { description: String(error) }),
    });
  }

  function select(slotId: string) {
    void accounts.selectSlot(slotId).catch((error) => {
      toast.error("Couldn't select that account", { description: String(error) });
    });
  }

  function dismissInvitation() {
    clearOrganizationInvitationContinuation();
    setInvitationDismissed(true);
  }

  return (
    <section className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-sm forced-colors:border-[CanvasText]">
        <div className="mb-4 flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-brand-strong/20 text-brand forced-colors:border forced-colors:border-[CanvasText]">
            <UserRoundPlusIcon className="size-5" />
          </span>
          <div>
            <h1 className="text-base font-semibold">
              {invitation
                ? "Continue your invitation"
                : slots.length > 0
                  ? "Choose an account"
                  : "Sign in to OpenGeni"}
            </h1>
            <p className="mt-1 text-sm text-fg-subtle">
              {invitation
                ? `Use the account for ${invitation.targetEmail} to continue joining ${invitation.organizationName}.`
                : slots.length > 0
                  ? "No browser account is active. Choose one explicitly before OpenGeni loads account data."
                  : "Authentication opens in an isolated window so an existing account is never replaced implicitly."}
            </p>
          </div>
        </div>
        {accounts.phase === "recoverable_error" ? (
          <p role="alert" className="mb-3 text-sm text-status-failed">
            The account request did not finish. Try again.
          </p>
        ) : null}
        <div className="grid gap-2">
          {visibleSlots.map((slot) =>
            slot.state === "active" ? (
              <Button
                key={slot.id}
                type="button"
                variant="secondary"
                className="min-h-11 h-auto w-full justify-start py-2 text-left"
                disabled={busy}
                aria-label={`Continue as ${slot.displayName}`}
                onClick={() => select(slot.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{slot.displayName}</span>
                  <span className="block truncate text-xs font-normal text-fg-subtle">
                    {slot.verifiedClaim.value}
                  </span>
                </span>
              </Button>
            ) : (
              <Button
                key={slot.id}
                type="button"
                variant="secondary"
                className="min-h-11 h-auto w-full justify-start py-2 text-left"
                disabled={busy}
                aria-label={`Re-authenticate ${slot.displayName}`}
                onClick={() => authenticate("reauth", slot.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{slot.displayName}</span>
                  <span className="block truncate text-xs font-normal text-fg-subtle">
                    Re-authentication required
                  </span>
                </span>
              </Button>
            ),
          )}
          {!invitation || !invitedSlot ? (
            <Button
              type="button"
              className="min-h-11 w-full"
              variant={!invitation && slots.length > 0 ? "outline" : "default"}
              disabled={busy}
              onClick={() => authenticate("add")}
            >
              {busy ? (
                <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {invitation
                ? `Sign in as ${invitation.targetEmail}`
                : slots.length > 0
                  ? "Use another account"
                  : "Continue with email"}
            </Button>
          ) : null}
          {invitation ? (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={busy}
              onClick={dismissInvitation}
            >
              Continue without this invitation
            </Button>
          ) : null}
          {!invitation && slots.length === 0 && props.emptySetRegistrationPanel ? (
            <div className="mt-2 border-t border-border pt-4">
              {registrationOpen ? (
                <>
                  {props.emptySetRegistrationPanel}
                  <Button
                    type="button"
                    variant="ghost"
                    className="mt-2 w-full"
                    disabled={busy}
                    onClick={() => setRegistrationOpen(false)}
                  >
                    Back to sign in
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  disabled={busy}
                  onClick={() => setRegistrationOpen(true)}
                >
                  Create an account
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function BrowserAccountsLoadingGate({ children }: { children?: ReactNode }) {
  const accounts = useBrowserAccounts();
  if (accounts.phase === "recoverable_error") {
    return (
      <ProblemPanel
        title="Browser accounts unavailable"
        description="OpenGeni couldn't verify the active browser account. No tenant data was shown."
        action={
          <Button
            type="button"
            variant="secondary"
            onClick={() => void accounts.refresh().catch(() => undefined)}
          >
            Try again
          </Button>
        }
      />
    );
  }
  if (accounts.phase === "loading" || accounts.projection === null) {
    return <LoadingPanel label="Loading browser accounts" />;
  }
  return children;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
