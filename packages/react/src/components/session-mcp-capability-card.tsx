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
  const [ownership, setOwnership] = useState<ConnectOwnership>("workspace");
  const lifetime = useRef<AbortController | null>(null);
  const authorization = useRef<AbortController | null>(null);
  const operation = useRef(false);
  const startKey = useRef(crypto.randomUUID());
  const advanceKey = useRef(crypto.randomUUID());
  const storageKey = sessionId
    ? `opengeni:session-connect:${workspaceId}:${sessionId}:${capabilityId}`
    : `opengeni:workspace-connect:${workspaceId}:${capabilityId}`;
  const current = () => !!lifetime.current && !lifetime.current.signal.aborted;

  async function load() {
    const invocation = lifetime.current;
    const [catalog, session] = await Promise.all([
      client.listCapabilities(workspaceId),
      sessionId ? client.getSession(workspaceId, sessionId) : Promise.resolve(null),
    ]);
    if (!invocation || invocation.signal.aborted || lifetime.current !== invocation) return null;
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
      if (invocation.signal.aborted || lifetime.current !== invocation) return null;
      const matches = matchingActiveMcpConnections(resolved, connections);
      accountReady = matches.length === 1;
    }
    if (invocation.signal.aborted || lifetime.current !== invocation) return null;
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

  async function run(action: () => Promise<void>) {
    if (operation.current || !current()) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (failure) {
      if (current()) {
        if (failure instanceof ConnectPopupClosedError) setNotice(failure.message);
        else
          setError(
            failure instanceof Error
              ? failure.message
              : "Connection setup could not finish. Try again.",
          );
      }
    } finally {
      operation.current = false;
      if (current()) setBusy(false);
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

  async function reconcile(attempt: ConnectAttempt) {
    if (!current()) return;
    if (attempt.state !== "complete" || !attempt.account || !attempt.credentialsCommitted) return;
    const resolved = await load();
    if (!resolved || !current()) return;
    const connection = (await client.listConnections(workspaceId)).find(
      (entry) => entry.id === attempt.account!.id,
    );
    if (!current()) return;
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
    if (!current()) return;
    const enabled = await load();
    if (enabled && current()) {
      await finishConnection(enabled);
    }
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Recovery hint only. */
    }
  }

  async function open() {
    setExpanded(true);
    await run(async () => {
      await load();
      if (!current()) return;
      await recoverSavedAttempt();
    });
  }

  async function recoverSavedAttempt() {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(storageKey);
    } catch {
      /* No persisted attempt. */
    }
    if (saved) {
      const attempt = await controller.recover(saved);
      await reconcile(attempt);
    }
  }

  async function begin(fresh = false) {
    await run(async () => {
      if (
        fresh ||
        (view.attempt && ["failed", "expired", "cancelled"].includes(view.attempt.state))
      ) {
        startKey.current = crypto.randomUUID();
        advanceKey.current = crypto.randomUUID();
      }
      const reserved = reserveBrowserConnectNavigation(window);
      try {
        const resolved = await load();
        if (!resolved || !current()) return;
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
          if (!current()) return;
          if (connections.length > 1)
            throw new Error(
              "More than one personal account matches. Choose the account in connection settings before reconnecting.",
            );
          reconnectAccountId = connections[0]?.id;
        }
        let attempt = await controller.begin({
          providerId: "mcp-oauth",
          ownership,
          returnUrl,
          idempotencyKey: startKey.current,
          ...(reconnectAccountId ? { reconnectAccountId } : {}),
        });
        if (!current()) return;
        remember(attempt.id);
        if (attempt.state === "credential_input")
          attempt = await controller.advance(
            { type: "credentials", values: { mcpUrl } },
            advanceKey.current,
          );
        if (attempt.nextAction.type === "authorize")
          await performAuthorization(attempt, reserved.navigation);
        else await reconcile(attempt);
      } finally {
        reserved.close();
      }
    });
  }

  async function performAuthorization(attempt: ConnectAttempt, navigation: ConnectNavigation) {
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
      if (!current() || !result) return;
      setWaiting(false);
      setReconciling(true);
      await reconcile(result);
      if (result.state === "cancelled") {
        setNotice("Sign-in was cancelled. You can try connecting again.");
        return;
      }
      if (result.state !== "complete")
        throw new Error("Sign-in did not finish. You can try connecting again.");
    } finally {
      if (current()) setReconciling(false);
      lifetime.current?.signal.removeEventListener("abort", abortOnUnmount);
      if (authorization.current === pending) authorization.current = null;
      if (current()) setWaiting(false);
    }
  }

  function authorize(attempt: ConnectAttempt) {
    // run invokes action synchronously, retaining the browser click gesture.
    return run(() => performAuthorization(attempt, createBrowserConnectNavigation(window)));
  }

  async function finishConnection(capability: CapabilityCatalogItem) {
    if (!sessionId) {
      // Connection management does not select session tools.
      await onConfigured?.();
      if (!current()) return;
      setComplete(true);
      setExpanded(false);
      onClose?.();
      return;
    }
    if (capability.connectionRef && capability.connectionRef.subjectScope !== "subject") {
      const selected = (await client.listConnections(workspaceId)).find(
        (entry) => entry.id === capability.connectionRef?.connectionId,
      );
      if (!current()) return;
      if (!selected || selected.status !== "active")
        throw new Error("This account needs reconnection before it can be used here.");
    }
    if (capability.connectionRef?.subjectScope === "subject") {
      const accounts = await client.listOwnConnectionAccounts(workspaceId);
      if (!current()) return;
      if (matchingActiveMcpConnections(capability, accounts).length === 0)
        throw new Error("Your account needs reconnection before it can be used here.");
    }
    if (!current()) return;
    await attachSessionCapability(client, workspaceId, sessionId, capability, current);
    if (!current()) return;
    await onConfigured?.();
    if (!current()) return;
    setComplete(true);
    setExpanded(false);
  }

  async function useHere() {
    await run(async () => {
      if (item) await finishConnection(item);
    });
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
      onClose={() => {
        setExpanded(false);
        onClose?.();
      }}
      busy={(busy && !reconciling) || view.busy}
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
                    if (notice) void begin(true);
                    else if (view.attempt?.nextAction.type === "authorize")
                      void authorize(view.attempt);
                    else void begin();
                  }}
                >
                  {(error || notice) && view.attempt?.nextAction.type === "authorize"
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
