import { useEffect, useState, useRef } from "react";
import {
  ConnectController,
  authorizeConnectAttempt,
  createBrowserConnectNavigation,
  type ConnectTransport,
  type ConnectInstallationTarget,
  type ConnectAttempt,
} from "@opengeni/connect";
import { ConnectSetup } from "@opengeni/react/connect";
import "@opengeni/react/connect.css";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type NativeConnectRequest = {
  scope: { workspaceId: string; transport: ConnectTransport };
  providerId: string;
  ownership: "personal" | "workspace";
  returnUrl: string;
  idempotencyKey: string;
  reconnectAccountId?: string;
  installationTarget?: ConnectInstallationTarget;
  displayName?: string;
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
            (!request.reconnectAccountId || attempt.account?.id === request.reconnectAccountId),
        );
        if (matches.length) setPending(matches);
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
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Connect{" "}
            {request.displayName ?? request.installationTarget?.displayName ?? request.providerId}
          </DialogTitle>
          <DialogDescription>
            Complete the setup below. Closing this window does not cancel saved setup.
          </DialogDescription>
        </DialogHeader>
        {failed && (
          <div role="alert">
            Could not start setup.{" "}
            <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
              Retry setup
            </Button>
          </div>
        )}
        {preparing && <p role="status">Preparing account setup…</p>}
        {pending.length > 0 && controller && (
          <section aria-label="Unfinished connection setup">
            <p>
              You have unfinished setup for this provider. Resume an attempt or connect a different
              account.
            </p>
            <ul>
              {pending.map((attempt) => (
                <li key={attempt.id}>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setPending([]);
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
                void controller.begin(nativeConnectApiInput(request)).catch(() => setFailed(true));
              }}
            >
              Connect a different account
            </Button>
          </section>
        )}
        {controller && !preparing && !failed && pending.length === 0 && (
          <ConnectSetup
            className="og-connect"
            controller={controller}
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
      </DialogContent>
    </Dialog>
  );
}
