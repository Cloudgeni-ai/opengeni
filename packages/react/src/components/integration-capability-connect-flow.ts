// The renderer-neutral flow behind the in-chat Connect card for a reviewed
// integration. The web card and the React Native card draw it; no DOM here.
import {
  authorizeConnectAttempt,
  ConnectController,
  ConnectPopupClosedError,
  type ConnectAttempt,
  type ConnectNavigation,
} from "@opengeni/connect";
import { integrationDefinitionIdFromCapabilityId } from "@opengeni/contracts";
import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";
import { useEffect, useRef, useState } from "react";
import { attemptHint, type ConnectWindowHost } from "../connect-window-host";
import { useConnect } from "../hooks/use-connect";
import { useOpenGeniText } from "../messages/runtime";
import { attachSessionCapability } from "../session-capability-policy";

export type IntegrationCapabilityConnectInput = {
  client: OpenGeniClient;
  workspaceId: string;
  sessionId: string;
  /** `api:integration:<definition id>` from the agent's recommendation. */
  capabilityId: string;
  name: string;
  /** Exact host route the provider returns to after sign-in. */
  returnUrl: string;
  /** Where the provider's sign-in opens. */
  windows: ConnectWindowHost;
  onConfigured?: (() => void | Promise<void>) | undefined;
};

export type IntegrationCapabilityAvailability =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "connected" }
  | { kind: "unavailable"; reason: string }
  | { kind: "error" };

type ListedIntegration = Awaited<
  ReturnType<OpenGeniClient["listApiIntegrations"]>
>["integrations"][number];

const RESTARTABLE = new Set<ConnectAttempt["state"]>(["failed", "cancelled", "expired"]);

/** The in-chat Connect card for a reviewed integration, as a renderer draws it. */
export type IntegrationCapabilityConnect = {
  controller: ConnectController;
  attempt: ConnectAttempt | null;
  availability: IntegrationCapabilityAvailability;
  busy: boolean;
  /** The sign-in window is open and the card waits for it. */
  waiting: boolean;
  /** A plain line when starting failed, or null. Never a raw server message. */
  error: string | null;
  /**
   * The person closed the sign-in window before finishing. Not an error: the
   * card says so and its sign-in button offers to try again.
   */
  signInClosed: boolean;
  /** "Sign-in window closed…" while {@link signInClosed}, else null. */
  notice: string | null;
  chatAccessFailed: boolean;
  notRequester: boolean;
  /** The last attempt ended (failed, cancelled, expired) and a new one can start. */
  restartable: boolean;
  start: () => void;
  /** Sign in for an attempt that already waits for authorization. */
  authorizeAttempt: (next: ConnectAttempt) => Promise<void>;
  stopWaiting: () => void;
  reload: () => void;
};

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

/**
 * One-tap Connect for a reviewed integration recommended in chat. The person
 * viewing it signs in with their own account; setup then installs the
 * integration's reviewed tools for that personal account only, adds them to
 * this chat and lets the agent continue the request that asked. It follows
 * the viewer's own state, so a teammate in a shared chat connects their own.
 * Mount it once per client, workspace, session and capability.
 */
export function useIntegrationCapabilityConnect({
  client,
  workspaceId,
  sessionId,
  capabilityId,
  name,
  returnUrl,
  windows,
  onConfigured,
}: IntegrationCapabilityConnectInput): IntegrationCapabilityConnect {
  const t = useOpenGeniText();
  const definitionId = integrationDefinitionIdFromCapabilityId(capabilityId) ?? capabilityId;
  const [controller] = useState(
    () => new ConnectController(client.connectTransport(), workspaceId),
  );
  const view = useConnect(controller);
  const attempt = view.attempt;
  const [availability, setAvailability] = useState<IntegrationCapabilityAvailability>({
    kind: "loading",
  });
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInClosed, setSignInClosed] = useState(false);
  const [chatAccessFailed, setChatAccessFailed] = useState(false);
  const [notRequester, setNotRequester] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const authorization = useRef<AbortController | null>(null);
  const finished = useRef<string | null>(null);
  const configured = useRef(onConfigured);
  configured.current = onConfigured;
  const windowHost = useRef(windows);
  windowHost.current = windows;
  const hints = windows.hints ?? attemptHint;
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
      const connectedNow = ownInstances(installed.integrations, definitionId).some(
        (instance) => instance.connected,
      );
      // An attempt this card started and never saw finish (the page reloaded
      // or the app restarted while the person signed in) is picked up first,
      // so a finished one still adds the tools here and lets the agent continue.
      const saved = hints.read(storageKey);
      if (saved) {
        const recovered = await controller.recover(saved).catch(() => null);
        if (!live()) return;
        if (recovered?.state === "complete" && recovered.integrationInstalled) return;
        if (!recovered || connectedNow) hints.forget(storageKey);
      }
      if (connectedNow) {
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
    })().catch(() => {
      if (live()) setAvailability({ kind: "error" });
    });
    return () => {
      abort.abort();
      authorization.current?.abort();
    };
    // The flow is mounted once per client/workspace/session/capability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloads]);

  useEffect(() => () => controller.dispose(), [controller]);

  // A cancelled, failed or expired attempt has nothing left to pick up after a
  // reload or app restart; forget it so the next setup starts fresh.
  const attemptState = attempt?.state;
  useEffect(() => {
    if (attemptState && RESTARTABLE.has(attemptState)) hints.forget(storageKey);
  }, [attemptState, hints, storageKey]);

  // Setup installs the reviewed tools by itself; once it is complete, select
  // them for this chat (default-mode chats pick them up on their own).
  useEffect(() => {
    if (!attempt || attempt.state !== "complete" || !attempt.integrationInstalled) return;
    if (finished.current === attempt.id) return;
    finished.current = attempt.id;
    const live = () => !lifetime.current?.signal.aborted;
    void (async () => {
      hints.forget(storageKey);
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
  }, [attempt, client, workspaceId, sessionId, capabilityId, definitionId, storageKey, hints, t]);

  async function authorize(next: ConnectAttempt, navigation: ConnectNavigation) {
    const pending = new AbortController();
    authorization.current = pending;
    setSignInClosed(false);
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

  /** Fresh setup from one tap: the sign-in window is reserved inside the tap. */
  function start() {
    if (busy || availability.kind !== "ready") return;
    setError(null);
    setSignInClosed(false);
    let reserved: ReturnType<ConnectWindowHost["reserve"]>;
    try {
      reserved = windowHost.current.reserve();
    } catch {
      setError(t("connectWindowHost.allowPopups"));
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
        // A browser popup ends on a page that closes itself instead of
        // loading this page a second time; a phone returns to the app.
        ...(windowHost.current.finishInPopup ? { finishInPopup: true as const } : {}),
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
      hints.remember(storageKey, begun.id);
      if (begun.nextAction.type === "authorize") await authorize(begun, reserved.navigation);
    })()
      .catch((failure) => {
        // Closing the sign-in window is the person's choice: say so and offer
        // to try again. Server messages are not for the person; the card
        // shows its own plain line.
        if (failure instanceof ConnectPopupClosedError) setSignInClosed(true);
        else setError(t("sessionIntegrationCapabilityCard.couldNotStart"));
      })
      .finally(() => {
        reserved.close();
        setBusy(false);
      });
  }

  return {
    controller,
    attempt,
    availability,
    busy,
    waiting,
    error,
    signInClosed,
    notice: signInClosed ? t("connectSetup.signInWindowClosed") : null,
    chatAccessFailed,
    notRequester,
    restartable: !!attempt && RESTARTABLE.has(attempt.state),
    start,
    authorizeAttempt: (next: ConnectAttempt) => authorize(next, windowHost.current.open()),
    stopWaiting: () => authorization.current?.abort(new ConnectPopupClosedError()),
    reload: () => setReloads((value) => value + 1),
  };
}
