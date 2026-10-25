import {
  authorizeConnectAttempt,
  ConnectController,
  ConnectPopupClosedError,
  createBrowserConnectNavigation,
  reserveBrowserConnectNavigation,
  type ConnectAttempt,
  type ConnectNavigation,
} from "@opengeni/connect";
import { integrationDefinitionIdFromCapabilityId } from "@opengeni/contracts";
import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectSetup } from "../connect-setup";
import { connectionServicePresentation } from "../connection-service-presentation";
import { useConnect } from "../hooks/use-connect";
import { useOpenGeniText } from "../messages/runtime";
import { attachSessionCapability } from "../session-capability-policy";
import { SessionCapabilityFrame } from "./session-capability-frame";

/** The client methods the card uses. Session proxies that do not forward
 * Connect and integration routes cannot render it. */
export function supportsIntegrationCapabilityCard(client: unknown): client is OpenGeniClient {
  const candidate = client as Partial<Record<keyof OpenGeniClient, unknown>> | null;
  return (
    !!candidate &&
    typeof candidate.connectTransport === "function" &&
    typeof candidate.listApiIntegrations === "function" &&
    typeof candidate.getSession === "function" &&
    typeof candidate.updateSessionToolPolicy === "function"
  );
}

export type SessionIntegrationCapabilityCardProps = {
  client: OpenGeniClient;
  workspaceId: string;
  sessionId: string;
  /** `api:integration:<definition id>` from the agent's recommendation. */
  capabilityId: string;
  name: string;
  rationale?: string;
  /** Exact host route the provider returns to after a full-page redirect. */
  returnUrl: string;
  onConfigured?: (() => void | Promise<void>) | undefined;
};

const RESTARTABLE = new Set<ConnectAttempt["state"]>(["failed", "cancelled", "expired"]);

// An opaque recovery hint after a reload or full-page redirect; the server
// rechecks the authenticated owner on recover. Storage may be disabled.
function rememberAttempt(key: string, attemptId: string) {
  try {
    sessionStorage.setItem(key, attemptId);
  } catch {
    /* Recovery hint only. */
  }
}

function forgetAttempt(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Recovery hint only. */
  }
}

/**
 * One-click Connect card for a reviewed integration recommended in chat. The
 * person viewing it signs in with their own account in a popup; setup then
 * installs the integration's reviewed tools for that personal account only,
 * never as a workspace account. It shows the viewer's own state, so a
 * teammate in a shared chat sees and connects their own account. When
 * Microsoft says an administrator must approve the app first, the shared
 * setup view shows the approval link to pass on, and "Try again" connects
 * after that.
 */
export function SessionIntegrationCapabilityCard(props: SessionIntegrationCapabilityCardProps) {
  return (
    <ScopedCard key={`${props.workspaceId}:${props.sessionId}:${props.capabilityId}`} {...props} />
  );
}

type Availability =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "connected" }
  | { kind: "unavailable"; reason: ReactNode }
  | { kind: "error" };

type ListedIntegration = Awaited<
  ReturnType<OpenGeniClient["listApiIntegrations"]>
>["integrations"][number];

/** The viewer's own accounts of this definition; workspace accounts are not this card's. */
function ownInstances(integrations: readonly ListedIntegration[], definitionId: string) {
  return integrations.filter(
    (instance) => instance.definitionId === definitionId && instance.ownership === "personal",
  );
}

/** The account to reconnect: the most recently used one that lost its sign-in. */
export function reconnectCandidate(
  integrations: readonly ListedIntegration[],
  definitionId: string,
): ListedIntegration | null {
  const disconnected = ownInstances(integrations, definitionId).filter(
    (instance) => !instance.connected,
  );
  const lastUsed = (instance: ListedIntegration) =>
    instance.connectionLastUsedAt ? Date.parse(instance.connectionLastUsedAt) || 0 : 0;
  return (
    [...disconnected].sort(
      (left, right) =>
        lastUsed(right) - lastUsed(left) || left.instanceKey.localeCompare(right.instanceKey),
    )[0] ?? null
  );
}

function ScopedCard({
  client,
  workspaceId,
  sessionId,
  capabilityId,
  name,
  rationale = "",
  returnUrl,
  onConfigured,
}: SessionIntegrationCapabilityCardProps) {
  const t = useOpenGeniText();
  const definitionId = integrationDefinitionIdFromCapabilityId(capabilityId) ?? capabilityId;
  const presentation = connectionServicePresentation({ id: definitionId, label: name });
  const [controller] = useState(
    () => new ConnectController(client.connectTransport(), workspaceId),
  );
  const view = useConnect(controller);
  const attempt = view.attempt;
  const [availability, setAvailability] = useState<Availability>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatAccessFailed, setChatAccessFailed] = useState(false);
  const [notRequester, setNotRequester] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const authorization = useRef<AbortController | null>(null);
  const finished = useRef<string | null>(null);
  const configured = useRef(onConfigured);
  configured.current = onConfigured;
  const storageKey = `opengeni:session-integration-connect:${workspaceId}:${sessionId}:${capabilityId}`;

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    const live = () => !abort.signal.aborted;
    setAvailability({ kind: "loading" });
    void (async () => {
      const [providers, installed] = await Promise.all([
        controller.transport.catalog(workspaceId, { signal: abort.signal }),
        client.listApiIntegrations(workspaceId),
      ]);
      if (!live()) return;
      // Connected means signed in now; an expired or revoked account
      // reconnects from this card.
      if (
        ownInstances(installed.integrations, definitionId).some((instance) => instance.connected)
      ) {
        setAvailability({ kind: "connected" });
        return;
      }
      const provider = providers.find((entry) => entry.id === definitionId);
      if (!provider || provider.readiness !== "available") {
        setAvailability({
          kind: "unavailable",
          reason:
            provider?.readiness === "unsupported"
              ? t("sessionIntegrationCapabilityCard.noPermission", { name })
              : t("sessionIntegrationCapabilityCard.notSetUp", { name }),
        });
        return;
      }
      // Only ever the person's own account: a mailbox connected as a
      // workspace account would serve every member's chats.
      if (!provider.ownership.includes("personal")) {
        setAvailability({
          kind: "unavailable",
          reason: t("sessionIntegrationCapabilityCard.personalUnavailable", { name }),
        });
        return;
      }
      setAvailability({ kind: "ready" });
      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem(storageKey);
      } catch {
        /* Storage may be disabled. */
      }
      if (saved) await controller.recover(saved).catch(() => forgetAttempt(storageKey));
    })().catch(() => {
      if (live()) setAvailability({ kind: "error" });
    });
    return () => {
      abort.abort();
      authorization.current?.abort();
    };
    // The card remounts for client/workspace/session/capability changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  useEffect(() => () => controller.dispose(), [controller]);

  // Setup installs the reviewed tools by itself; once it is complete, select
  // them for this chat (default-mode chats pick them up on their own).
  useEffect(() => {
    if (!attempt || attempt.state !== "complete" || !attempt.integrationInstalled) return;
    if (finished.current === attempt.id) return;
    finished.current = attempt.id;
    const live = () => !lifetime.current?.signal.aborted;
    void (async () => {
      forgetAttempt(storageKey);
      const instances = ownInstances(
        (await client.listApiIntegrations(workspaceId)).integrations,
        definitionId,
      ).filter((instance) => instance.connected);
      for (const instance of instances) {
        await attachSessionCapability(
          t,
          client,
          workspaceId,
          sessionId,
          {
            kind: "api",
            tools: [{ kind: "mcp", id: instance.serverId, optional: true }],
            runtime: { available: true, notes: null },
            metadata: {},
          },
          live,
        );
      }
      // The agent continues the request that asked for this connection, when
      // that request was this person's own.
      void Promise.resolve()
        .then(() => client.continueAfterCapabilitySetup(workspaceId, sessionId, { capabilityId }))
        .then((result) => {
          if (live() && result.outcome === "not_needed" && result.reason === "not_requester")
            setNotRequester(true);
        })
        .catch(() => undefined);
    })()
      .catch(() => {
        if (live()) setChatAccessFailed(true);
      })
      .finally(() => {
        if (!live()) return;
        setAvailability({ kind: "connected" });
        void Promise.resolve(configured.current?.()).catch(() => {});
      });
  }, [attempt, client, workspaceId, sessionId, capabilityId, definitionId, storageKey, t]);

  async function authorize(next: ConnectAttempt, navigation: ConnectNavigation) {
    const pending = new AbortController();
    authorization.current = pending;
    setWaiting(true);
    try {
      const result = await authorizeConnectAttempt(controller.transport, next, navigation, {
        mode: "popup",
        signal: pending.signal,
      });
      if (result && !pending.signal.aborted) await controller.recover(result.id);
    } finally {
      if (authorization.current === pending) authorization.current = null;
      setWaiting(false);
    }
  }

  /** Fresh setup from one click: the popup is reserved inside the click. */
  function start() {
    if (busy || availability.kind !== "ready") return;
    setError(null);
    let reserved: ReturnType<typeof reserveBrowserConnectNavigation>;
    try {
      reserved = reserveBrowserConnectNavigation(window);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : t("sessionIntegrationCapabilityCard.couldNotStart"),
      );
      return;
    }
    setBusy(true);
    void (async () => {
      // Reconnect an account of yours that lost its sign-in (expired or
      // revoked), the most recently used one, instead of adding another.
      const existing = reconnectCandidate(
        (await client.listApiIntegrations(workspaceId)).integrations,
        definitionId,
      );
      const begun = await controller.begin({
        providerId: definitionId,
        ownership: "personal",
        returnUrl,
        idempotencyKey: crypto.randomUUID(),
        ...(existing?.connectionId ? { reconnectAccountId: existing.connectionId } : {}),
        // A new account gets a fresh instance the server names after the
        // attempt, so connecting can never overwrite someone else's.
        ...(existing
          ? {
              installationTarget: {
                instanceKey: existing.instanceKey,
                displayName: existing.displayName,
                expectedInstanceVersion: existing.instanceVersion,
              },
            }
          : {}),
      });
      rememberAttempt(storageKey, begun.id);
      if (begun.nextAction.type === "authorize") await authorize(begun, reserved.navigation);
    })()
      .catch((failure) => {
        if (failure instanceof ConnectPopupClosedError) return;
        setError(
          failure instanceof Error
            ? failure.message
            : t("sessionIntegrationCapabilityCard.couldNotStart"),
        );
      })
      .finally(() => {
        reserved.close();
        setBusy(false);
      });
  }

  const restartable = !!attempt && RESTARTABLE.has(attempt.state);
  const setup =
    availability.kind === "ready" && (attempt || busy || error) ? (
      <>
        {error ? <p role="alert">{error}</p> : null}
        {attempt ? (
          <ConnectSetup
            className="og-connect"
            controller={controller}
            authorizeLabel={t("sessionIntegrationCapabilityCard.signIn")}
            onAuthorize={(next) => authorize(next, createBrowserConnectNavigation(window))}
          />
        ) : busy ? (
          <p role="status">{t("sessionIntegrationCapabilityCard.preparing")}</p>
        ) : null}
        {waiting ? (
          <p role="status" className="og-session-capability-progress">
            {t("sessionIntegrationCapabilityCard.finishSigningIn", { name: presentation.name })}{" "}
            <button
              type="button"
              className="og-session-capability-stop"
              onClick={() => authorization.current?.abort(new ConnectPopupClosedError())}
            >
              {t("sessionIntegrationCapabilityCard.stopWaiting")}
            </button>
          </p>
        ) : null}
        {!busy && !waiting && (restartable || error) ? (
          <button type="button" className="og-session-capability-primary" onClick={start}>
            {t("sessionIntegrationCapabilityCard.tryAgain")}
          </button>
        ) : null}
      </>
    ) : undefined;

  return (
    <SessionCapabilityFrame
      name={presentation.name}
      subtitle=""
      logo={presentation.logo}
      typeLabel={t("sessionIntegrationCapabilityCard.integration")}
      description={rationale}
      skill={false}
      expanded={false}
      complete={availability.kind === "connected"}
      completeLabel={t("sessionIntegrationCapabilityCard.connected")}
      actionLabel={t("sessionIntegrationCapabilityCard.connectName", { name: presentation.name })}
      opensDialog={false}
      busy={busy || availability.kind === "loading"}
      note={t("sessionIntegrationCapabilityCard.note")}
      onOpen={start}
      onClose={() => {}}
      inlineSetup={setup}
      actionUnavailable={
        availability.kind === "unavailable" ? (
          availability.reason
        ) : availability.kind === "error" ? (
          <>
            {t("sessionIntegrationCapabilityCard.couldNotLoad")}{" "}
            <button type="button" onClick={() => setReload((value) => value + 1)}>
              {t("sessionIntegrationCapabilityCard.retry")}
            </button>
          </>
        ) : undefined
      }
      details={
        availability.kind === "connected" && (chatAccessFailed || notRequester) ? (
          <>
            {chatAccessFailed ? (
              <p role="status" className="og-session-capability-copy">
                {t("sessionIntegrationCapabilityCard.chatAccessFailed")}
              </p>
            ) : null}
            {notRequester ? (
              <p role="status" className="og-session-capability-copy">
                {t("sessionIntegrationCapabilityCard.notRequester")}
              </p>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
}
