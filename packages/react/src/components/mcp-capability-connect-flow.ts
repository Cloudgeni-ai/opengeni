// The renderer-neutral flow behind the OAuth MCP connect card: read the live
// catalog entry, sign in, enable it with the chosen account, add it to the
// chat and let the agent continue. The web card and the React Native card
// both draw it; no DOM here.
import {
  authorizeConnectAttempt,
  ConnectController,
  ConnectPopupClosedError,
  type ConnectAttempt,
  type ConnectNavigation,
  type ConnectOwnership,
} from "@opengeni/connect";
import type { CapabilityCatalogItem } from "@opengeni/sdk";
import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";
import { useEffect, useRef, useState } from "react";
import { ConnectCardMessage } from "../connect-card-message";
import { attemptHint, type ConnectWindowHost } from "../connect-window-host";
import { useConnect, type ConnectView } from "../hooks/use-connect";
import { matchingActiveMcpConnections } from "../mcp-connection-status";
import { useOpenGeniText } from "../messages/runtime";
import {
  attachSessionCapability,
  continueAfterCapabilitySetup,
  sessionCapabilityTools,
} from "../session-capability-policy";

const GOOGLE_DRIVE_MCP_URL = "https://drivemcp.googleapis.com/mcp/v1";
const RESTART_STATES = ["failed", "expired", "cancelled"];

/** The OAuth MCP connect card, as a renderer draws it. */
export type McpCapabilityConnect = {
  controller: ConnectController;
  view: ConnectView;
  /** The live catalog entry, once read. */
  item: CapabilityCatalogItem | null;
  personalOnly: boolean;
  expanded: boolean;
  complete: boolean;
  /** An account is connected; the capability still has to be added here. */
  connected: boolean;
  waiting: boolean;
  reconciling: boolean;
  busy: boolean;
  /** A plain line for the person when a step failed, or null. Never a raw server message. */
  error: string | null;
  /** "Sign-in window closed…" or "Sign-in was cancelled…", or null. */
  notice: string | null;
  ownership: ConnectOwnership;
  setOwnership: (ownership: ConnectOwnership) => void;
  /** The sign-in button says "Try signing in again" rather than continuing. */
  retrySignIn: boolean;
  open: () => void;
  signIn: () => void;
  addHere: () => void;
  close: () => void;
  stopWaiting: () => void;
};

export type McpCapabilityConnectInput = {
  client: OpenGeniClient;
  workspaceId: string;
  /** Omit for connection management: no session tool selection is written. */
  sessionId?: string | undefined;
  capabilityId: string;
  /** Exact host route the provider returns to after sign-in. */
  returnUrl: string;
  /** Where the provider's sign-in opens. */
  windows: ConnectWindowHost;
  onConfigured?: (() => void | Promise<void>) | undefined;
  /** The card opens straight into setup (a dialog), loading and recovering at once. */
  dialogOnly?: boolean | undefined;
  onClose?: (() => void) | undefined;
  /**
   * Offer only a personal connection: the provider only ever connects
   * someone's own account, or the person may only connect their own account.
   */
  personalOnly?: boolean | undefined;
};

/**
 * The OAuth MCP connect flow. Identity and endpoint come from the live
 * catalog, never from model-authored recommendation text. Mount it once per
 * client, workspace, session and capability.
 */
export function useMcpCapabilityConnect({
  client,
  workspaceId,
  sessionId,
  capabilityId,
  returnUrl,
  windows,
  onConfigured,
  dialogOnly = false,
  onClose,
  personalOnly: configuredPersonalOnly = false,
}: McpCapabilityConnectInput): McpCapabilityConnect {
  const t = useOpenGeniText();
  const [controller] = useState(
    () => new ConnectController(client.connectTransport(), workspaceId),
  );
  const view = useConnect(controller);
  const [item, setItem] = useState<CapabilityCatalogItem | null>(null);
  const personalOnly =
    configuredPersonalOnly || (item?.mcpUrl ?? item?.endpointUrl) === GOOGLE_DRIVE_MCP_URL;
  const [expanded, setExpanded] = useState(dialogOnly);
  const [complete, setComplete] = useState(false);
  const [connected, setConnected] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryFresh, setRetryFresh] = useState(false);
  const [ownership, setOwnership] = useState<ConnectOwnership>(
    personalOnly ? "personal" : "workspace",
  );
  const lifetime = useRef<AbortController | null>(null);
  const authorization = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const reservedPopup = useRef<(() => void) | null>(null);
  const startKey = useRef(crypto.randomUUID());
  const advanceKey = useRef(crypto.randomUUID());
  const startInput = useRef<string | null>(null);
  const windowHost = useRef(windows);
  windowHost.current = windows;
  const hints = windows.hints ?? attemptHint;
  const storageKey = sessionId
    ? `opengeni:session-connect:${workspaceId}:${sessionId}:${capabilityId}`
    : `opengeni:workspace-connect:${workspaceId}:${capabilityId}`;
  const current = () => !!lifetime.current && !lifetime.current.signal.aborted;

  // A cancelled, failed or expired attempt has nothing left to pick up after a
  // reload or app restart; forget it so the next setup starts fresh.
  const attemptState = view.attempt?.state;
  useEffect(() => {
    if (attemptState && RESTART_STATES.includes(attemptState)) hints.forget(storageKey);
  }, [attemptState, hints, storageKey]);

  async function load(active: () => boolean = current) {
    const invocation = lifetime.current;
    const [catalog, session] = await Promise.all([
      client.listCapabilities(workspaceId),
      sessionId ? client.getSession(workspaceId, sessionId) : Promise.resolve(null),
    ]);
    if (!invocation || invocation.signal.aborted || lifetime.current !== invocation || !active())
      return null;
    let resolved = catalog.items.find((entry) => entry.id === capabilityId);
    // Custom catalog entries may not declare authentication. Discover it from
    // the live catalog's endpoint, never from recommendation/host copy.
    if (resolved?.kind === "mcp" && !resolved.enabled && !resolved.authKind) {
      const endpoint = resolved.mcpUrl ?? resolved.endpointUrl;
      if (endpoint) {
        const inspected = await client.inspectMcpAuthentication(workspaceId, endpoint);
        if (invocation.signal.aborted || lifetime.current !== invocation || !active()) return null;
        if (inspected.kind === "oauth2") resolved = { ...resolved, authKind: "oauth2" };
        else if (inspected.kind === "unknown")
          // The server's own explanation is for operators; the card says it plainly.
          throw new ConnectCardMessage(t("sessionMcpCapabilityCard.couldNotDetermineHowTo"));
      }
    }
    if (!resolved || resolved.kind !== "mcp" || resolved.authKind !== "oauth2")
      throw new ConnectCardMessage(t("sessionMcpCapabilityCard.thisRecommendationIsNotAn"));
    setItem(resolved);
    if (resolved.connectionRef)
      setOwnership(resolved.connectionRef.subjectScope === "subject" ? "personal" : "workspace");
    else if (
      !item &&
      (personalOnly ||
        (resolved.mcpUrl ?? resolved.endpointUrl) === GOOGLE_DRIVE_MCP_URL ||
        resolved.metadata?.defaultConnectionOwnership === "personal")
    )
      setOwnership("personal");
    let accountReady = false;
    if (resolved.enabled && resolved.connectionRef) {
      const connections =
        resolved.connectionRef.subjectScope === "subject"
          ? await client.listOwnConnectionAccounts(workspaceId)
          : await client.listConnections(workspaceId);
      if (invocation.signal.aborted || lifetime.current !== invocation || !active()) return null;
      const matches = matchingActiveMcpConnections(resolved, connections);
      accountReady = matches.length === 1;
    }
    if (invocation.signal.aborted || lifetime.current !== invocation || !active()) return null;
    const selected =
      session?.toolPolicy.mode === "workspace_default"
        ? session.effectiveToolPolicy?.selectedIds
        : session?.tools.filter((tool) => tool.kind === "mcp").map((tool) => tool.id);
    setConnected(accountReady);
    setComplete(
      accountReady &&
        !!selected &&
        sessionCapabilityTools(resolved).every((tool) => selected.includes(tool.id)),
    );
    return resolved;
  }

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    // Mount reads are scoped to this effect, not to the user-action lock.
    // Strict Mode may cancel the first mount while its promise is still in
    // flight; that must not suppress the replacement mount's initialization.
    if (dialogOnly) setBusy(true);
    void (async () => {
      await load();
      if (abort.signal.aborted || !dialogOnly) return;
      await recoverSavedAttempt();
    })()
      .catch((failure) => {
        if (!abort.signal.aborted)
          setError(
            failure instanceof ConnectCardMessage
              ? failure.message
              : t("sessionMcpCapabilityCard.couldnTLoadConnectionDetails"),
          );
      })
      .finally(() => {
        if (!abort.signal.aborted && dialogOnly) setBusy(false);
      });
    return () => {
      abort.abort();
    };
    // The flow is mounted once per client/workspace/session/capability.
    // These reads initialize that scope; rerunning on action closures would
    // cancel initialization whenever its own state updates render the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, sessionId, capabilityId, dialogOnly, t]);

  async function run(action: (active: () => boolean) => Promise<void>) {
    if (operation.current || !current()) return;
    const pending = new AbortController();
    operation.current = pending;
    const active = () => current() && operation.current === pending && !pending.signal.aborted;
    setBusy(true);
    setError(null);
    setNotice(null);
    setRetryFresh(false);
    try {
      await action(active);
    } catch (failure) {
      if (active()) {
        if (failure instanceof ConnectPopupClosedError)
          setNotice(t("connectSetup.signInWindowClosed"));
        else
          setError(
            // This flow's own steps explain themselves; a server or network
            // failure gets the card's plain line instead of its raw text.
            failure instanceof ConnectCardMessage
              ? failure.message
              : t("sessionMcpCapabilityCard.connectionSetupCouldNotFinish"),
          );
      }
    } finally {
      if (operation.current === pending) {
        operation.current = null;
        if (current()) setBusy(false);
      }
    }
  }

  async function reconcile(attempt: ConnectAttempt, active: () => boolean = current) {
    if (!active()) return;
    if (attempt.state !== "complete" || !attempt.account || !attempt.credentialsCommitted) return;
    const resolved = await load(active);
    if (!resolved || !active()) return;
    const connection = (await client.listConnections(workspaceId)).find(
      (entry) => entry.id === attempt.account!.id,
    );
    if (!active()) return;
    if (
      !connection ||
      connection.status !== "active" ||
      connection.kind !== "oauth2" ||
      connection.metadata.mcpUrl !== (resolved.mcpUrl ?? resolved.endpointUrl) ||
      (connection.subjectId !== null) !== (attempt.ownership === "personal")
    )
      throw new ConnectCardMessage(t("sessionMcpCapabilityCard.theAuthorizedAccountDoesNot"));
    const previous = resolved.connectionRef;
    if (
      resolved.enabled &&
      previous?.subjectScope !== "subject" &&
      previous?.connectionId &&
      previous.connectionId !== connection.id
    )
      throw new ConnectCardMessage(t("sessionMcpCapabilityCard.thisIntegrationSSelectedAccount"));
    // Enabling is a workspace installation change. When the capability is
    // already enabled with exactly this binding (each person's own account,
    // or this shared account), connecting an account needs no installation
    // change, and no permission to make one.
    const alreadyBound =
      resolved.enabled &&
      previous?.providerDomain === connection.providerDomain &&
      (attempt.ownership === "personal"
        ? previous.subjectScope === "subject"
        : previous.subjectScope !== "subject" && previous.connectionId === connection.id);
    if (!alreadyBound) {
      await client.enableCapability(workspaceId, capabilityId, {
        connectionRef:
          attempt.ownership === "personal"
            ? { providerDomain: connection.providerDomain, kind: "oauth2", subjectScope: "subject" }
            : {
                providerDomain: connection.providerDomain,
                kind: "oauth2",
                subjectScope: "workspace",
                connectionId: connection.id,
              },
      });
      if (!active()) return;
    }
    const enabled = await load(active);
    if (enabled && active()) {
      await finishConnection(enabled, active);
    }
    if (!active()) return;
    hints.forget(storageKey);
  }

  async function open() {
    setExpanded(true);
    await run(async (active) => {
      await load(active);
      if (!active()) return;
      await recoverSavedAttempt(active);
    });
  }

  async function recoverSavedAttempt(active: () => boolean = current) {
    const saved = hints.read(storageKey);
    if (saved) {
      const attempt = await controller.recover(saved);
      if (!active()) return;
      if (RESTART_STATES.includes(attempt.state)) setRetryFresh(true);
      if (attempt.state === "complete") setReconciling(true);
      try {
        await reconcile(attempt, active);
      } finally {
        if (active()) setReconciling(false);
      }
    }
  }

  async function begin(fresh = false) {
    await run(async (active) => {
      if (fresh || (view.attempt && RESTART_STATES.includes(view.attempt.state))) {
        startKey.current = crypto.randomUUID();
        advanceKey.current = crypto.randomUUID();
      }
      let reserved: ReturnType<ConnectWindowHost["reserve"]>;
      try {
        reserved = windowHost.current.reserve();
      } catch {
        // The browser refused the sign-in window (usually a pop-up blocker);
        // its own error text is technical and untranslated.
        throw new ConnectCardMessage(t("connectWindowHost.allowPopups"));
      }
      reservedPopup.current = reserved.close;
      try {
        const resolved = await load(active);
        if (!resolved || !active()) return;
        if (
          resolved.connectionRef &&
          ownership !==
            (resolved.connectionRef.subjectScope === "subject" ? "personal" : "workspace")
        )
          throw new ConnectCardMessage(
            t("sessionMcpCapabilityCard.theConnectionOwnershipChangedReview"),
          );
        const mcpUrl = resolved.mcpUrl ?? resolved.endpointUrl;
        if (!mcpUrl)
          throw new ConnectCardMessage(t("sessionMcpCapabilityCard.theCurrentCatalogHasNo"));
        // Never silently replace an already selected account. Reauthorization
        // stays on its exact native connection ID.
        let reconnectAccountId = resolved.connectionRef?.connectionId ?? undefined;
        if (resolved.connectionRef?.subjectScope === "subject") {
          const connections = (await client.listConnections(workspaceId)).filter(
            (entry) =>
              entry.subjectId !== null &&
              entry.kind === "oauth2" &&
              entry.metadata.mcpUrl === mcpUrl,
          );
          if (!active()) return;
          if (connections.length > 1)
            throw new ConnectCardMessage(t("sessionMcpCapabilityCard.moreThanOnePersonalAccount"));
          reconnectAccountId = connections[0]?.id;
        }
        // A closed request can still have reached the server. Keep its key for
        // an exact replay, but never reuse it when ownership or another input
        // changes while the user reopens setup.
        const input = JSON.stringify({ ownership, returnUrl, reconnectAccountId, mcpUrl });
        if (startInput.current !== null && startInput.current !== input) {
          startKey.current = crypto.randomUUID();
          advanceKey.current = crypto.randomUUID();
        }
        startInput.current = input;
        let attempt = await controller.begin({
          providerId: mcpUrl === GOOGLE_DRIVE_MCP_URL ? "google-drive" : "mcp-oauth",
          ownership,
          returnUrl,
          // A browser popup ends on a page that closes itself instead of
          // loading this page a second time; a phone returns to the app.
          ...(windowHost.current.finishInPopup ? { finishInPopup: true as const } : {}),
          idempotencyKey: startKey.current,
          ...(reconnectAccountId ? { reconnectAccountId } : {}),
        });
        if (!active()) return;
        hints.remember(storageKey, attempt.id);
        if (attempt.state === "credential_input")
          attempt = await controller.advance(
            {
              type: "credentials",
              values: mcpUrl === GOOGLE_DRIVE_MCP_URL ? {} : { mcpUrl },
            },
            advanceKey.current,
          );
        if (!active()) return;
        if (attempt.nextAction.type === "authorize")
          await performAuthorization(attempt, reserved.navigation, active);
        else await reconcile(attempt, active);
      } finally {
        if (reservedPopup.current === reserved.close) reservedPopup.current = null;
        reserved.close();
      }
    });
  }

  async function performAuthorization(
    attempt: ConnectAttempt,
    navigation: ConnectNavigation,
    active: () => boolean,
  ) {
    if (!active()) return;
    const pending = new AbortController();
    authorization.current = pending;
    const abortOnUnmount = () => pending.abort(lifetime.current?.signal.reason);
    lifetime.current!.signal.addEventListener("abort", abortOnUnmount, { once: true });
    setWaiting(true);
    try {
      const result = await authorizeConnectAttempt(controller.transport, attempt, navigation, {
        mode: "popup",
        signal: pending.signal,
      });
      if (!active() || !result) return;
      setWaiting(false);
      setReconciling(true);
      await reconcile(result, active);
      if (!active()) return;
      if (result.state === "cancelled") {
        setNotice(t("sessionMcpCapabilityCard.signInWasCancelledYou"));
        setRetryFresh(true);
        return;
      }
      if (result.state !== "complete") {
        if (["failed", "expired"].includes(result.state)) setRetryFresh(true);
        throw new ConnectCardMessage(t("sessionMcpCapabilityCard.signInDidNotFinish"));
      }
    } finally {
      lifetime.current?.signal.removeEventListener("abort", abortOnUnmount);
      if (authorization.current === pending) authorization.current = null;
      if (active()) {
        setReconciling(false);
        setWaiting(false);
      }
    }
  }

  function authorize(attempt: ConnectAttempt) {
    // run invokes action synchronously, retaining the person's tap gesture.
    return run((active) => performAuthorization(attempt, windowHost.current.open(), active));
  }

  async function finishConnection(
    capability: CapabilityCatalogItem,
    active: () => boolean = current,
  ) {
    if (!sessionId) {
      // Connection management does not select session tools.
      await onConfigured?.();
      if (!active()) return;
      setComplete(true);
      setExpanded(false);
      onClose?.();
      return;
    }
    if (capability.connectionRef && capability.connectionRef.subjectScope !== "subject") {
      const selected = (await client.listConnections(workspaceId)).find(
        (entry) => entry.id === capability.connectionRef?.connectionId,
      );
      if (!active()) return;
      if (!selected || selected.status !== "active")
        throw new ConnectCardMessage(
          t("sessionMcpCapabilityCard.thisAccountNeedsReconnectionBefore"),
        );
    }
    if (capability.connectionRef?.subjectScope === "subject") {
      const accounts = await client.listOwnConnectionAccounts(workspaceId);
      if (!active()) return;
      if (matchingActiveMcpConnections(capability, accounts).length === 0)
        throw new ConnectCardMessage(
          t("sessionMcpCapabilityCard.yourAccountNeedsReconnectionBefore"),
        );
    }
    if (!active()) return;
    await attachSessionCapability(t, client, workspaceId, sessionId, capability, active);
    if (!active()) return;
    await onConfigured?.();
    if (!active()) return;
    continueAfterCapabilitySetup(client, workspaceId, sessionId, capability.id);
    setComplete(true);
    setExpanded(false);
  }

  async function addHere() {
    await run(async (active) => {
      if (item) await finishConnection(item, active);
    });
  }

  function close() {
    const pending = operation.current;
    if (pending) {
      operation.current = null;
      pending.abort(new ConnectPopupClosedError());
      authorization.current?.abort(new ConnectPopupClosedError());
      authorization.current = null;
      reservedPopup.current?.();
      setBusy(false);
      setWaiting(false);
      setReconciling(false);
    }
    setExpanded(false);
    onClose?.();
  }

  /** The setup's main button: a fresh sign-in, or the waiting attempt's sign-in. */
  function signIn() {
    if (notice || retryFresh) void begin(true);
    else if (view.attempt?.nextAction.type === "authorize" && view.attempt.ownership === ownership)
      void authorize(view.attempt);
    else void begin();
  }

  return {
    controller,
    view,
    item,
    personalOnly,
    expanded,
    complete,
    connected,
    waiting,
    reconciling,
    busy,
    error,
    notice,
    ownership,
    setOwnership,
    /** The sign-in button says "Try signing in again" rather than continuing. */
    retrySignIn:
      retryFresh || (Boolean(error || notice) && view.attempt?.nextAction.type === "authorize"),
    open: () => void open(),
    signIn,
    addHere: () => void addHere(),
    close,
    stopWaiting: () => authorization.current?.abort(new ConnectPopupClosedError()),
  };
}
