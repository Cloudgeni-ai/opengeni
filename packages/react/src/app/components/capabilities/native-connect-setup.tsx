import {
  adminApprovalLink,
  connectSetupContinuesWithoutDialog,
  continueConnectSetup,
} from "../../../connect-setup-model";
import {
  connectionServicePresentation,
  connectionServiceWording,
} from "../../../connection-service-presentation";
import { useOpenGeniText } from "../../../messages/runtime";
import { useEffect, useState, useRef } from "react";
import {
  ConnectController,
  ConnectPopupClosedError,
  authorizeConnectAttempt,
  createBrowserConnectNavigation,
  type ConnectTransport,
  type ConnectInstallationTarget,
  type ConnectAttempt,
} from "@opengeni/connect";
import { ConnectSetup, ConnectionLogo, isOwnerApprovalPending } from "../../../connect";
import "../../../../styles/connect.css";
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from "../../../ui/dialog";
import { CapabilityDialogContent } from "./detail-dialog";
import { Button } from "../../../ui/button";
import { selectGitHubConnectAccount } from "../../lib/github-connect-account";
import { recordGitHubInstallRequest } from "../../lib/github-install-request";
import {
  beginIntegrationConnect,
  connectAttemptOutcome,
  integrationClassFromConnectProvider,
  type IntegrationConnectTracker,
} from "../../lib/integration-connect-analytics";

export type NativeConnectRequest = {
  scope: { workspaceId: string; transport: ConnectTransport };
  providerId: string;
  ownership: "personal" | "workspace";
  returnUrl: string;
  idempotencyKey: string;
  reconnectAccountId?: string | undefined;
  /** Additional provider access this reconnect asks for (incremental consent). */
  requestedScopes?: string[] | undefined;
  installationTarget?: ConnectInstallationTarget | undefined;
  displayName?: string | undefined;
  /**
   * Replaces "Connect <name>", for a repair that names its fix ("Authorize acme").
   * With a description, the setup drops its generic connection summary.
   */
  title?: string | undefined;
  description?: string | undefined;
  logoUrl?: string | undefined;
  authorizeLabel?: string | undefined;
};

export function nativeConnectApiInput(request: NativeConnectRequest) {
  return {
    providerId: request.providerId,
    ownership: request.ownership,
    returnUrl: request.returnUrl,
    idempotencyKey: request.idempotencyKey,
    ...(request.reconnectAccountId ? { reconnectAccountId: request.reconnectAccountId } : {}),
    ...(request.reconnectAccountId && request.requestedScopes?.length
      ? { requestedScopes: [...request.requestedScopes] }
      : {}),
    ...(request.installationTarget ? { installationTarget: request.installationTarget } : {}),
  };
}

function sameScopes(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  const a = [...new Set(left ?? [])].sort();
  const b = [...new Set(right ?? [])].sort();
  return a.length === b.length && a.every((scope, index) => scope === b[index]);
}

/** How long setup closed mid-way may keep finishing without its dialog. */
const BACKGROUND_SETUP_LIMIT_MS = 30 * 60_000;

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
  /**
   * Setup completed. Closing the dialog after sign-in lets setup carry on,
   * so this can run after `onClose`, possibly while another dialog is open.
   */
  onComplete(attempt: ConnectAttempt): void;
}) {
  const t = useOpenGeniText();
  const own = connectionServiceWording(t, request.providerId);
  const serviceName = own.name ?? request.displayName;
  const [controller, setController] = useState<ConnectController | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);
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
  const completedAttempt = useRef<string | null>(null);
  // The person opened the provider's sign-in for this attempt.
  const signInStarted = useRef(false);
  const latestComplete = useRef(onComplete);
  latestComplete.current = onComplete;
  // Consent-gated connect journey: started when the dialog begins setup,
  // finished by the attempt's settled state, `abandoned` when closed first.
  const journey = useRef<IntegrationConnectTracker | null>(null);
  useEffect(() => {
    const tracker = beginIntegrationConnect(
      integrationClassFromConnectProvider(request.providerId),
      "oauth",
    );
    journey.current = tracker;
    return () => {
      tracker.finish("abandoned");
      if (journey.current === tracker) journey.current = null;
    };
  }, [request.providerId]);
  useEffect(() => {
    if (request.scope.workspaceId !== workspaceId || request.scope.transport !== transport) {
      setController(null);
      return;
    }
    const next = new ConnectController(transport, workspaceId);
    signInStarted.current = false;
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
            // A reconnect resumes only its own account; a new connection never
            // resumes another account's reconnect.
            (request.reconnectAccountId
              ? attempt.account?.id === request.reconnectAccountId
              : attempt.account?.status !== "auth_needed") &&
            // A pending reconnect resumes only if it asks for the same access.
            sameScopes(attempt.requestedScopes, request.requestedScopes),
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
    const notify = () => {
      const attempt = controller.getSnapshot().attempt;
      setApprovalPending(Boolean(attempt && adminApprovalLink(attempt)));
      const outcome = attempt ? connectAttemptOutcome(attempt) : null;
      if (outcome) journey.current?.finish(outcome);
      // A non-owner's request: remember it so the GitHub card can say it's
      // waiting for an owner rather than offering the same dead end again.
      if (attempt?.providerId === "github-app" && isOwnerApprovalPending(attempt))
        recordGitHubInstallRequest(attempt.workspaceId);
      if (attempt?.state === "complete" && completedAttempt.current !== attempt.id) {
        completedAttempt.current = attempt.id;
        onComplete(attempt);
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
        if (open) return;
        // Closing never stops setup the person already authorized: it carries
        // on without the dialog and reports completion the same way.
        const attempt = controller?.getSnapshot().attempt;
        if (
          attempt &&
          completedAttempt.current !== attempt.id &&
          connectSetupContinuesWithoutDialog(attempt, signInStarted.current)
        ) {
          completedAttempt.current = attempt.id;
          const complete = latestComplete.current;
          void continueConnectSetup(transport, attempt, {
            // Bounded: the attempt's own expiry ends it sooner.
            signal: AbortSignal.timeout(BACKGROUND_SETUP_LIMIT_MS),
          }).then((done) => {
            if (done) complete(done);
          });
        }
        onClose();
      }}
    >
      <CapabilityDialogContent
        className="w-full max-h-[85dvh] overflow-y-auto sm:max-w-[36rem]"
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
        <DialogHeader
          className={`flex-row items-center gap-4 px-6 py-6 pr-12 text-left ${approvalPending ? "pb-2" : "border-b border-border"}`}
        >
          <ConnectionLogo
            src={
              request.logoUrl ??
              connectionServicePresentation({
                id: request.providerId,
                label: serviceName ?? request.providerId,
              }).logo
            }
            name={serviceName ?? request.providerId}
          />
          <div className="min-w-0 space-y-1.5">
            <DialogTitle
              ref={heading}
              tabIndex={-1}
              className="text-xl font-semibold tracking-tight outline-hidden"
            >
              {request.title ??
                `Connect ${serviceName ?? request.installationTarget?.displayName ?? request.providerId}`}
            </DialogTitle>
            <DialogDescription
              className={approvalPending ? "sr-only" : "text-sm leading-6 text-fg-muted"}
            >
              {own.description ??
                request.description ??
                "Authorize access to use this connection in Opengeni."}
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className="space-y-4 px-6 py-5 text-sm">
          {failed && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 text-danger"
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
                {request.reconnectAccountId ? "Start over" : "Connect a different account"}
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
              {request.reconnectAccountId ? "Start over" : "Connect a different account"}
            </Button>
          )}
          {controller && !preparing && !failed && pending.length === 0 && (
            <ConnectSetup
              className="og-connect"
              authorizeLabel={request.authorizeLabel}
              explained={!!request.title && !!request.description}
              serviceName={serviceName ?? request.installationTarget?.displayName}
              controller={controller}
              onRetry={() =>
                controller.begin(
                  nativeConnectApiInput({ ...request, idempotencyKey: crypto.randomUUID() }),
                )
              }
              {...(request.providerId === "github-app"
                ? {
                    onSelectAccount: (accountId: string) => {
                      const signal = navigation.current?.signal;
                      if (!signal) throw new Error("Connection setup is no longer active");
                      return selectGitHubConnectAccount(controller, accountId, window, signal);
                    },
                  }
                : {})}
              onAuthorize={async (attempt) => {
                const browser = createBrowserConnectNavigation(window);
                try {
                  const result = await authorizeConnectAttempt(
                    transport,
                    attempt,
                    {
                      // Sign-in counts as started only once its window opened.
                      openPopup: (url) => {
                        const popup = browser.openPopup(url);
                        if (popup) signInStarted.current = true;
                        return popup;
                      },
                      redirect: (url) => browser.redirect(url),
                    },
                    {
                      mode: "popup",
                      ...(navigation.current ? { signal: navigation.current.signal } : {}),
                    },
                  );
                  if (result) await controller.recover(result.id);
                } catch (error) {
                  // The person closed the sign-in window: nothing to carry on.
                  if (error instanceof ConnectPopupClosedError) signInStarted.current = false;
                  throw error;
                }
              }}
            />
          )}
        </div>
      </CapabilityDialogContent>
    </Dialog>
  );
}
