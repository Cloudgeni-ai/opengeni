import {
  authorizeConnectAttempt,
  ConnectPopupClosedError,
  ConnectController,
  createBrowserConnectNavigation,
  reserveBrowserConnectNavigation,
  type ConnectAttempt,
  type ConnectNavigation,
  type ConnectOwnership,
} from "@opengeni/connect";
import type { CapabilityCatalogItem } from "@opengeni/sdk";
import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";
import { useEffect, useRef, useState } from "react";
import { useConnect } from "../hooks/use-connect";
import { attachSessionCapability, sessionCapabilityTools } from "../session-capability-policy";
import { SessionCapabilityFrame } from "./session-capability-frame";
import { matchingActiveMcpConnections } from "../mcp-connection-status";

export type SessionMcpCapabilityCardProps = {
  client: OpenGeniClient;
  workspaceId: string;
  sessionId: string;
  capabilityId: string;
  name: string;
  rationale?: string;
  /** Exact host route; no console-specific routing is assumed. */
  returnUrl: string;
  onConfigured?: (() => void | Promise<void>) | undefined;
};

export type McpConnectionCardProps = Omit<SessionMcpCapabilityCardProps, "sessionId"> & {
  /** Omit for connection management: no session tool selection is written. */
  sessionId?: string;
  dialogOnly?: boolean;
  onClose?: (() => void) | undefined;
};

/** Native OAuth recommendation flow. Identity and endpoint come from the live
 * catalog, never from model-authored recommendation text. */
export function SessionMcpCapabilityCard(props: SessionMcpCapabilityCardProps) {
  return <McpConnectionCard {...props} />;
}

export function McpConnectionCard(props: McpConnectionCardProps) {
  const [client, setClient] = useState(props.client);
  const [generation, setGeneration] = useState(0);
  if (client !== props.client) {
    setClient(props.client);
    setGeneration(generation + 1);
  }
  return (
    <ScopedCard
      key={`${generation}:${props.workspaceId}:${props.sessionId}:${props.capabilityId}`}
      {...props}
    />
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
  dialogOnly = false,
  onClose,
}: McpConnectionCardProps) {
  const [controller] = useState(
    () => new ConnectController(client.connectTransport(), workspaceId),
  );
  const view = useConnect(controller);
  const [item, setItem] = useState<CapabilityCatalogItem | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(dialogOnly);
  const [complete, setComplete] = useState(false);
  const [connected, setConnected] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryFresh, setRetryFresh] = useState(false);
  const [ownership, setOwnership] = useState<ConnectOwnership>("workspace");
  const lifetime = useRef<AbortController | null>(null);
  const authorization = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const reservedPopup = useRef<(() => void) | null>(null);
  const startKey = useRef(crypto.randomUUID());
  const advanceKey = useRef(crypto.randomUUID());
  const startInput = useRef<string | null>(null);
  const storageKey = sessionId
    ? `opengeni:session-connect:${workspaceId}:${sessionId}:${capabilityId}`
    : `opengeni:workspace-connect:${workspaceId}:${capabilityId}`;
  const current = () => !!lifetime.current && !lifetime.current.signal.aborted;

  async function load(active: () => boolean = current) {
    const invocation = lifetime.current;
    const [catalog, session] = await Promise.all([
      client.listCapabilities(workspaceId),
      sessionId ? client.getSession(workspaceId, sessionId) : Promise.resolve(null),
    ]);
    if (!invocation || invocation.signal.aborted || lifetime.current !== invocation || !active())
      return null;
    const resolved = catalog.items.find((entry) => entry.id === capabilityId);
    if (!resolved || resolved.kind !== "mcp" || resolved.authKind !== "oauth2")
      throw new Error(
        "This recommendation is not an available OAuth MCP integration. Review the current connection catalog.",
      );
    setItem(resolved);
    if (resolved.connectionRef)
      setOwnership(resolved.connectionRef.subjectScope === "subject" ? "personal" : "workspace");
    else if (!item && resolved.metadata?.defaultConnectionOwnership === "personal")
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
            failure instanceof Error ? failure.message : "Couldn't load connection details.",
          );
      })
      .finally(() => {
        if (!abort.signal.aborted && dialogOnly) setBusy(false);
      });
    return () => {
      abort.abort();
    };
    // ScopedCard remounts for client/workspace/session/capability changes.
    // These reads initialize that scope; rerunning on action closures would
    // cancel initialization whenever its own state updates render the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, sessionId, capabilityId, dialogOnly]);

  useEffect(() => {
    const path = item?.logoAssetPath;
    setLogo(null);
    if (!path?.startsWith("catalog-assets/")) return;
    const abort = new AbortController();
    let objectUrl: string | null = null;
    // Embeds can require authentication even for the API's public catalog
    // asset route. Use the client's transport instead of an unauthenticated img.
    void client
      .downloadCatalogAsset(path, { signal: abort.signal })
      .then((blob) => {
        if (abort.signal.aborted || !blob.type.startsWith("image/") || blob.size > 2_000_000)
          return;
        objectUrl = URL.createObjectURL(blob);
        setLogo(objectUrl);
      })
      .catch(() => {
        /* Keep the provider's initials if its passive mark is unavailable. */
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, item?.logoAssetPath]);

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
        if (failure instanceof ConnectPopupClosedError) setNotice(failure.message);
        else
          setError(
            failure instanceof Error
              ? failure.message
              : "Connection setup could not finish. Try again.",
          );
      }
    } finally {
      if (operation.current === pending) {
        operation.current = null;
        if (current()) setBusy(false);
      }
    }
  }

  function remember(attemptId: string) {
    // An opaque recovery hint only. The backend rechecks the authenticated
    // owner on recover; this value never grants access or proves completion.
    try {
      sessionStorage.setItem(storageKey, attemptId);
    } catch {
      /* Storage may be disabled. */
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
      throw new Error(
        "The authorized account does not match this integration. Review its connection settings.",
      );
    const previous = resolved.connectionRef;
    if (
      resolved.enabled &&
      previous?.subjectScope !== "subject" &&
      previous?.connectionId &&
      previous.connectionId !== connection.id
    )
      throw new Error(
        "This integration's selected account changed during setup. Review it before continuing.",
      );
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
    const enabled = await load(active);
    if (enabled && active()) {
      await finishConnection(enabled, active);
    }
    if (!active()) return;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Recovery hint only. */
    }
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
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(storageKey);
    } catch {
      /* No persisted attempt. */
    }
    if (saved) {
      const attempt = await controller.recover(saved);
      if (!active()) return;
      if (["failed", "expired", "cancelled"].includes(attempt.state)) setRetryFresh(true);
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
      if (
        fresh ||
        (view.attempt && ["failed", "expired", "cancelled"].includes(view.attempt.state))
      ) {
        startKey.current = crypto.randomUUID();
        advanceKey.current = crypto.randomUUID();
      }
      const reserved = reserveBrowserConnectNavigation(window);
      reservedPopup.current = reserved.close;
      try {
        const resolved = await load(active);
        if (!resolved || !active()) return;
        if (
          resolved.connectionRef &&
          ownership !==
            (resolved.connectionRef.subjectScope === "subject" ? "personal" : "workspace")
        )
          throw new Error(
            "The connection ownership changed. Review the current account before continuing.",
          );
        const mcpUrl = resolved.mcpUrl ?? resolved.endpointUrl;
        if (!mcpUrl)
          throw new Error(
            "The current catalog has no authorization endpoint for this integration.",
          );
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
            throw new Error(
              "More than one personal account matches. Choose the account in connection settings before reconnecting.",
            );
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
          providerId: "mcp-oauth",
          ownership,
          returnUrl,
          idempotencyKey: startKey.current,
          ...(reconnectAccountId ? { reconnectAccountId } : {}),
        });
        if (!active()) return;
        remember(attempt.id);
        if (attempt.state === "credential_input")
          attempt = await controller.advance(
            { type: "credentials", values: { mcpUrl } },
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
        setNotice("Sign-in was cancelled. You can try connecting again.");
        setRetryFresh(true);
        return;
      }
      if (result.state !== "complete") {
        if (["failed", "expired"].includes(result.state)) setRetryFresh(true);
        throw new Error("Sign-in did not finish. You can try connecting again.");
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
    // run invokes action synchronously, retaining the browser click gesture.
    return run((active) =>
      performAuthorization(attempt, createBrowserConnectNavigation(window), active),
    );
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
        throw new Error("This account needs reconnection before it can be used here.");
    }
    if (capability.connectionRef?.subjectScope === "subject") {
      const accounts = await client.listOwnConnectionAccounts(workspaceId);
      if (!active()) return;
      if (matchingActiveMcpConnections(capability, accounts).length === 0)
        throw new Error("Your account needs reconnection before it can be used here.");
    }
    if (!active()) return;
    await attachSessionCapability(client, workspaceId, sessionId, capability, active);
    if (!active()) return;
    await onConfigured?.();
    if (!active()) return;
    setComplete(true);
    setExpanded(false);
  }

  async function useHere() {
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

  return (
    <SessionCapabilityFrame
      name={item?.name ?? name}
      subtitle={item?.providerDomain ?? ""}
      logo={logo}
      typeLabel="MCP server"
      description={item?.description || rationale}
      skill={false}
      expanded={expanded}
      complete={complete}
      actionLabel={
        connected
          ? sessionId
            ? "Use in this conversation"
            : "Connected"
          : `Connect ${item?.name ?? name}`
      }
      note={
        sessionId
          ? "Review access before signing in. You'll return to this conversation after authorization."
          : "Review access before signing in. You'll return here after authorization."
      }
      onOpen={() => void open()}
      onClose={close}
      dialogOnly={dialogOnly}
    >
      <div className="og-session-capability-setup">
        {error ? <p role="alert">{error}</p> : null}
        {notice ? (
          <p role="status" className="og-session-capability-notice">
            {notice}
          </p>
        ) : null}
        {!item ? (
          <>
            <p role="status">
              {busy ? "Loading connection details…" : "Connection details are unavailable."}
            </p>
            <button disabled={busy} onClick={() => void open()}>
              Retry
            </button>
          </>
        ) : (
          <>
            <p>{item.description || rationale}</p>
            {busy ? (
              <>
                <p role="status" className="og-session-capability-progress">
                  {waiting
                    ? `Finish signing in with ${item.name} in the opened window. This will close automatically when you’re connected.`
                    : reconciling
                      ? "Finishing your connection…"
                      : "Preparing your connection…"}
                </p>
                {waiting ? (
                  <button
                    type="button"
                    className="og-session-capability-stop"
                    onClick={() => authorization.current?.abort(new ConnectPopupClosedError())}
                  >
                    Stop waiting
                  </button>
                ) : null}
              </>
            ) : !connected ? (
              <>
                {!item.connectionRef ? (
                  <fieldset disabled={busy}>
                    <legend>Who can use this connection?</legend>
                    <label>
                      <input
                        type="radio"
                        name={`${capabilityId}-ownership`}
                        checked={ownership === "workspace"}
                        onChange={() => setOwnership("workspace")}
                      />
                      Everyone in this workspace
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`${capabilityId}-ownership`}
                        checked={ownership === "personal"}
                        onChange={() => setOwnership("personal")}
                      />
                      Only me
                    </label>
                  </fieldset>
                ) : null}
                <p className="og-session-capability-scope">
                  {ownership === "workspace"
                    ? sessionId
                      ? "This connection will be available to your workspace and used in this conversation."
                      : "This connection will be available to your workspace."
                    : "This connection belongs to you. Your messages can use it; other participants use their own accounts."}
                </p>
                <button
                  className="og-session-capability-primary"
                  onClick={() => {
                    if (notice || retryFresh) void begin(true);
                    else if (view.attempt?.nextAction.type === "authorize")
                      void authorize(view.attempt);
                    else void begin();
                  }}
                >
                  {retryFresh ||
                  ((error || notice) && view.attempt?.nextAction.type === "authorize")
                    ? "Try signing in again"
                    : `Continue to ${item.name}`}
                </button>
              </>
            ) : null}
            {connected && !busy ? (
              <>
                <p className="og-session-capability-scope">
                  {sessionId
                    ? "Your account is connected. Enable it for this conversation to finish."
                    : "Your account is connected."}
                </p>
                <button
                  className="og-session-capability-primary"
                  disabled={busy || view.busy}
                  onClick={() => void useHere()}
                >
                  {sessionId ? "Use in this conversation" : "Done"}
                </button>
              </>
            ) : null}
          </>
        )}
      </div>
    </SessionCapabilityFrame>
  );
}
