import {
  BrowserAccountsProvider,
  useBrowserAccountTransitionBlocker,
  useBrowserAccounts,
  type BrowserAccountTransition,
} from "@opengeni/react/accounts";
import { createBrowserAccountsClient } from "@opengeni/sdk/accounts";
import { Loader2Icon, UserRoundPlusIcon } from "lucide-react";
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
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
      {children}
    </BrowserAccountsProvider>
  );
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

export function BrowserAccountsSignedOutPanel(props: { dualEmptySetFallback?: ReactNode }) {
  const accounts = useBrowserAccounts();
  const popup = useBrowserAccountPopup();
  const busy = accounts.phase === "committing" || accounts.phase === "loading";

  if (
    accounts.projection?.mode === "dual" &&
    accounts.projection.slots.length === 0 &&
    props.dualEmptySetFallback
  ) {
    return props.dualEmptySetFallback;
  }

  function signIn() {
    popup.open(() => accounts.beginAdd(), {
      onError: (error) => toast.error("Couldn't start sign in", { description: String(error) }),
    });
  }

  return (
    <section className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-sm forced-colors:border-[CanvasText]">
        <div className="mb-4 flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-brand-strong/20 text-brand forced-colors:border forced-colors:border-[CanvasText]">
            <UserRoundPlusIcon className="size-5" />
          </span>
          <div>
            <h1 className="text-base font-semibold">Sign in to OpenGeni</h1>
            <p className="mt-1 text-sm text-fg-subtle">
              Authentication opens in an isolated window so an existing account is never replaced
              implicitly.
            </p>
          </div>
        </div>
        {accounts.phase === "recoverable_error" ? (
          <p role="alert" className="mb-3 text-sm text-status-failed">
            The account request did not finish. Try again.
          </p>
        ) : null}
        <Button type="button" className="min-h-11 w-full" disabled={busy} onClick={signIn}>
          {busy ? <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          Continue with email
        </Button>
      </div>
    </section>
  );
}

export function BrowserAccountsLoadingGate({ children }: { children?: ReactNode }) {
  const accounts = useBrowserAccounts();
  if (accounts.projection !== null) return children;
  if (accounts.phase !== "recoverable_error") {
    return <LoadingPanel label="Loading browser accounts" />;
  }
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
