import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";
import { useEffect, useState } from "react";
import { browserConnectWindowHost } from "../connect-window-host";
import { useOpenGeniText } from "../messages/runtime";
import { useMcpCapabilityConnect } from "./mcp-capability-connect-flow";
import { SessionCapabilityFrame } from "./session-capability-frame";

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
  /**
   * Offer only a personal connection: the provider only ever connects
   * someone's own account (official Gmail, Slack's hosted MCP), or the person
   * may only connect their own account. No ownership choice.
   */
  personalOnly?: boolean;
};

export type McpConnectionCardProps = Omit<SessionMcpCapabilityCardProps, "sessionId"> & {
  /** Omit for connection management: no session tool selection is written. */
  sessionId?: string;
  dialogOnly?: boolean;
  onClose?: (() => void) | undefined;
  /** The connect button's words, "Connect Gmail". Defaults to "Continue to <name>". */
  connectLabel?: string;
  /** The line under the dialog title. Defaults to the kind and provider domain. */
  dialogSubtitle?: string;
  /** The host's product copy for this connection, instead of the catalog description. */
  description?: string;
  /** The host's logo for this connection, when the catalog has no asset. */
  logoSrc?: string | null;
  /** The host's words for the ownership choice. */
  ownershipCopy?: { legend: string; workspace: string; personal: string };
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
  personalOnly: configuredPersonalOnly = false,
  connectLabel,
  dialogSubtitle,
  description: hostDescription,
  logoSrc,
  ownershipCopy,
}: McpConnectionCardProps) {
  const t = useOpenGeniText();
  const [windows] = useState(() => browserConnectWindowHost(window));
  const flow = useMcpCapabilityConnect({
    client,
    workspaceId,
    sessionId,
    capabilityId,
    returnUrl,
    windows,
    onConfigured,
    dialogOnly,
    onClose,
    personalOnly: configuredPersonalOnly,
  });
  const { item, personalOnly, busy, waiting, reconciling, connected, ownership } = flow;
  const [logo, setLogo] = useState<string | null>(null);

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

  return (
    <SessionCapabilityFrame
      name={item?.name ?? name}
      subtitle={dialogSubtitle !== undefined ? "" : (item?.providerDomain ?? "")}
      logo={logo ?? logoSrc ?? null}
      typeLabel={dialogSubtitle ?? t("sessionMcpCapabilityCard.mcpServer")}
      description={hostDescription || item?.description || rationale}
      skill={false}
      expanded={flow.expanded}
      complete={flow.complete}
      actionLabel={
        connected
          ? sessionId
            ? t("sessionMcpCapabilityCard.useInThisConversation")
            : t("sessionMcpCapabilityCard.connected")
          : t("sessionMcpCapabilityCard.connectName", { name: item?.name ?? name })
      }
      note={
        sessionId
          ? t("sessionMcpCapabilityCard.reviewAccessBeforeSigningIn")
          : t("sessionMcpCapabilityCard.reviewAccessBeforeSigningIn2")
      }
      onOpen={flow.open}
      onClose={flow.close}
      dialogOnly={dialogOnly}
    >
      <div className="og-session-capability-setup">
        {flow.error ? <p role="alert">{flow.error}</p> : null}
        {flow.notice ? (
          <p role="status" className="og-session-capability-notice">
            {flow.notice}
          </p>
        ) : null}
        {!item ? (
          <>
            <p role="status">
              {busy
                ? t("sessionMcpCapabilityCard.loadingConnectionDetails")
                : t("sessionMcpCapabilityCard.connectionDetailsAreUnavailable")}
            </p>
            <button disabled={busy} onClick={flow.open}>
              {t("sessionMcpCapabilityCard.retry")}
            </button>
          </>
        ) : (
          <>
            <p>{hostDescription || item.description || rationale}</p>
            {busy ? (
              <>
                <p role="status" className="og-session-capability-progress">
                  {waiting
                    ? t("sessionMcpCapabilityCard.finishSigningInWithName", { name: item.name })
                    : reconciling
                      ? t("sessionMcpCapabilityCard.finishingYourConnection")
                      : t("sessionMcpCapabilityCard.preparingYourConnection")}
                </p>
                {waiting ? (
                  <button
                    type="button"
                    className="og-session-capability-stop"
                    onClick={flow.stopWaiting}
                  >
                    {t("sessionMcpCapabilityCard.stopWaiting")}
                  </button>
                ) : null}
              </>
            ) : !connected ? (
              <>
                {!item.connectionRef && !personalOnly ? (
                  <fieldset disabled={busy}>
                    <legend>
                      {ownershipCopy?.legend ??
                        t("sessionMcpCapabilityCard.whoCanUseThisConnection")}
                    </legend>
                    <label>
                      <input
                        type="radio"
                        name={`${capabilityId}-ownership`}
                        checked={ownership === "workspace"}
                        onChange={() => flow.setOwnership("workspace")}
                      />
                      {t("sessionMcpCapabilityCard.everyoneInThisWorkspace")}
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`${capabilityId}-ownership`}
                        checked={ownership === "personal"}
                        onChange={() => flow.setOwnership("personal")}
                      />
                      {t("sessionMcpCapabilityCard.onlyMe")}
                    </label>
                  </fieldset>
                ) : null}
                <p className="og-session-capability-scope">
                  {personalOnly && ownership === "personal"
                    ? t("sessionMcpCapabilityCard.connectsYourOwnAccountOnly")
                    : ownershipCopy
                      ? ownership === "workspace"
                        ? ownershipCopy.workspace
                        : ownershipCopy.personal
                      : ownership === "workspace"
                        ? sessionId
                          ? t("sessionMcpCapabilityCard.thisConnectionWillBeAvailable")
                          : t("sessionMcpCapabilityCard.thisConnectionWillBeAvailable2")
                        : t("sessionMcpCapabilityCard.thisConnectionBelongsToYou")}
                </p>
                <button className="og-session-capability-primary" onClick={flow.signIn}>
                  {flow.retrySignIn
                    ? t("sessionMcpCapabilityCard.trySigningInAgain")
                    : (connectLabel ??
                      t("sessionMcpCapabilityCard.continueToName", { name: item.name }))}
                </button>
              </>
            ) : null}
            {connected && !busy ? (
              <>
                <p className="og-session-capability-scope">
                  {sessionId
                    ? t("sessionMcpCapabilityCard.yourAccountIsConnectedEnable")
                    : t("sessionMcpCapabilityCard.yourAccountIsConnected")}
                </p>
                <button
                  className="og-session-capability-primary"
                  disabled={busy || flow.view.busy}
                  onClick={flow.addHere}
                >
                  {sessionId
                    ? t("sessionMcpCapabilityCard.useInThisConversation")
                    : t("sessionMcpCapabilityCard.done")}
                </button>
              </>
            ) : null}
          </>
        )}
      </div>
    </SessionCapabilityFrame>
  );
}
