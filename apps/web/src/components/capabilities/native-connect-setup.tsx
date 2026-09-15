import { useEffect, useState, useRef } from "react";
import {
  ConnectController,
  authorizeConnectAttempt,
  createBrowserConnectNavigation,
  type ConnectTransport,
  type ConnectInstallationTarget,
  type ConnectAttempt,
} from "@opengeni/connect";
import { ConnectSetup, ConnectionLogo } from "@opengeni/react/connect";
import "@opengeni/react/connect.css";
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { CapabilityDialogContent } from "./detail-dialog";
import { Button } from "@/components/ui/button";
import { selectGitHubConnectAccount } from "@/lib/github-connect-account";

export type NativeConnectRequest = {
  scope: { workspaceId: string; transport: ConnectTransport };
  providerId: string;
  ownership: "personal" | "workspace";
  returnUrl: string;
  idempotencyKey: string;
  reconnectAccountId?: string;
  installationTarget?: ConnectInstallationTarget;
  displayName?: string;
  description?: string;
  logoUrl?: string;
  authorizeLabel?: string;
};

export function nativeConnectApiInput(request: NativeConnectRequest) {
  return {
    providerId: request.providerId,
    ownership: request.ownership,
    returnUrl: request.returnUrl,
    idempotencyKey: request.idempotencyKey,
    ...(request.reconnectAccountId ? { reconnectAccountId: request.reconnectAccountId } : {}),
    ...(request.installationTarget ? { installationTarget: request.installationTarget } : {}),
  };
}

/** Native presentation only. Durable setup and provider callbacks are shared
 * with host products; legacy query-param callbacks remain read-compatible. */
export function NativeConnectSetup({
  transport,
  workspaceId,
  request,
  onClose,
  onComplete,
}: {
  transport: ConnectTransport;
  workspaceId: string;
  request: NativeConnectRequest;
  onClose(): void;
  onComplete(): void;
}) {
  const [controller, setController] = useState<ConnectController | null>(null);
  const [failed, setFailed] = useState(false);
  const [preparing, setPreparing] = useState(true);
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState<ConnectAttempt[]>([]);
  const [resumed, setResumed] = useState(false);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const opener = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const navigation = useRef<AbortController | null>(null);
  useEffect(() => {
    if (request.scope.workspaceId !== workspaceId || request.scope.transport !== transport) {
      setController(null);
      return;
    }
    const next = new ConnectController(transport, workspaceId);
    setController(next);
    setFailed(false);
    setPreparing(true);
    setPending([]);
    setResumed(false);
    const abort = new AbortController();
    navigation.current?.abort();
    navigation.current = new AbortController();
    navigation.current = abort;
    let live = true;
    void transport
      .pending(workspaceId, { signal: abort.signal })
      .then(async (attempts) => {
        if (!live) return;
        const matches = attempts.filter(
          (attempt) =>
            attempt.providerId === request.providerId &&
            attempt.ownership === request.ownership &&
            attempt.installationTarget?.instanceKey === request.installationTarget?.instanceKey &&
            (!request.reconnectAccountId || attempt.account?.id === request.reconnectAccountId),
        );
        if (matches.length === 1) {
          setResumed(true);
          await next.recover(matches[0]!.id);
        } else if (matches.length > 1) setPending(matches);
        else await next.begin(nativeConnectApiInput(request));
      })
      .catch(() => {
        if (live) setFailed(true);
      })
      .finally(() => {
        if (live) setPreparing(false);
      });
    return () => {
      live = false;
      abort.abort();
      navigation.current?.abort();
      next.dispose();
    };
  }, [transport, workspaceId, request, retry]);
  useEffect(() => {
    if (!controller) return;
    let notified = false;
    const notify = () => {
      if (!notified && controller.getSnapshot().attempt?.state === "complete") {
        notified = true;
        onComplete();
      }
    };
    const unsubscribe = controller.subscribe(notify);
    notify();
    return unsubscribe;
  }, [controller, onComplete]);
  if (request.scope.workspaceId !== workspaceId || request.scope.transport !== transport)
    return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <CapabilityDialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-[36rem]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          heading.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus();
          }
        }}
      >
        <DialogHeader className="flex-row items-center gap-4 border-b border-border px-6 py-6 pr-12 text-left">
          <ConnectionLogo
            src={request.logoUrl ?? null}
            name={request.displayName ?? request.providerId}
          />
          <div className="min-w-0 space-y-1.5">
            <DialogTitle
              ref={heading}
              tabIndex={-1}
              className="text-xl font-semibold tracking-tight outline-none"
            >
              Connect{" "}
              {request.displayName ?? request.installationTarget?.displayName ?? request.providerId}
            </DialogTitle>
            <DialogDescription className="text-sm leading-6 text-fg-muted">
              {request.description ?? "Authorize access to use this connection in OpenGeni."}
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className="space-y-4 px-6 py-5 text-sm">
          {failed && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 text-status-error"
            >
              Could not start setup.{" "}
              <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
                Retry setup
              </Button>
            </div>
          )}
          {preparing && (
            <p role="status" className="py-2 text-fg-muted">
              Preparing connection…
            </p>
          )}
          {pending.length > 0 && controller && (
            <section aria-label="Unfinished connection setup" className="space-y-4">
              <p>
                You have unfinished setup for this provider. Resume an attempt or connect a
                different account.
              </p>
              <ul className="space-y-2">
                {pending.map((attempt) => (
                  <li key={attempt.id}>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setPending([]);
                        setResumed(true);
                        void controller.recover(attempt.id).catch(() => setFailed(true));
                      }}
                    >
                      Resume{" "}
                      {attempt.installationTarget?.displayName ??
                        attempt.account?.label ??
                        attempt.providerId}{" "}
                      — {attempt.state.replaceAll("_", " ")}
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                variant="outline"
                onClick={() => {
                  setPending([]);
                  void controller
                    .begin(nativeConnectApiInput(request))
                    .catch(() => setFailed(true));
                }}
              >
                Connect a different account
              </Button>
            </section>
          )}
          {resumed && controller && !preparing && !failed && (
            <Button
              variant="ghost"
              onClick={() => {
                setResumed(false);
                setPreparing(true);
                void controller
                  .begin(nativeConnectApiInput(request))
                  .catch(() => setFailed(true))
                  .finally(() => setPreparing(false));
              }}
            >
              Connect a different account
            </Button>
          )}
          {controller && !preparing && !failed && pending.length === 0 && (
            <ConnectSetup
              className="og-connect"
              authorizeLabel={request.authorizeLabel}
              controller={controller}
              {...(["github-app", "github-lens"].includes(request.providerId)
                ? {
                    onSelectAccount: (accountId: string) => {
                      const signal = navigation.current?.signal;
                      if (!signal) throw new Error("Connection setup is no longer active");
                      return selectGitHubConnectAccount(controller, accountId, window, signal);
                    },
                  }
                : {})}
              onAuthorize={async (attempt) => {
                const result = await authorizeConnectAttempt(
                  transport,
                  attempt,
                  createBrowserConnectNavigation(window),
                  {
                    mode: "popup",
                    ...(navigation.current ? { signal: navigation.current.signal } : {}),
                  },
                );
                if (result) await controller.recover(result.id);
              }}
            />
          )}
        </div>
      </CapabilityDialogContent>
    </Dialog>
  );
}
