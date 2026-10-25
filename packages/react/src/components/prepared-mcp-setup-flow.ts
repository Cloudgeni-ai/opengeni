// The renderer-neutral flow behind an agent's prepared custom MCP setup: the
// server and its headers are already proposed, the person only enters the
// requested key in the protected form. Shared by the web card and the React
// Native card; no DOM, and no key ever enters React state here.
import { ConnectController } from "@opengeni/connect";
import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";
import { useEffect, useRef, useState } from "react";
import { useConnect } from "../hooks/use-connect";
import type { OpenGeniText } from "../messages/runtime";
import { attachSessionCapability } from "../session-capability-policy";
import type { AuthNeededItem } from "../timeline";

/** Whether an auth notice is an agent's prepared key setup for a custom MCP server. */
export function isPreparedMcpSetup(item: AuthNeededItem): boolean {
  return !!item.setupRequest?.mcpSetup && !!item.setupRequest.ownership;
}

/**
 * Start (or replay) the prepared setup attempt. The card identity is a stable
 * operation key, including across reloads and Strict Mode, so an unrelated
 * pending setup is never recovered by provider alone. Mount once per client,
 * workspace, session, person and card.
 */
export function usePreparedMcpSetupAttempt({
  client,
  workspaceId,
  item,
  canConfigure,
  returnUrl,
}: {
  client: OpenGeniClient;
  workspaceId: string;
  item: AuthNeededItem;
  canConfigure: boolean;
  returnUrl: string;
}) {
  const [proposal] = useState(() => item.setupRequest!);
  const [controller, setController] = useState<ConnectController | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [beginKey, setBeginKey] = useState(`mcp-card:${item.id}`);
  useEffect(() => {
    if (!canConfigure || !proposal.mcpSetup || !proposal.ownership) return;
    let active = true;
    const next = new ConnectController(client.connectTransport(), workspaceId);
    setController(next);
    setFailed(false);
    void next
      .begin({
        providerId: "mcp-headers",
        ownership: proposal.ownership,
        mcpSetup: proposal.mcpSetup,
        idempotencyKey: beginKey,
        returnUrl,
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      next.dispose();
    };
  }, [returnUrl, client, workspaceId, canConfigure, proposal, beginKey, retry]);
  return {
    proposal,
    controller,
    failed,
    reload: () => setRetry((value) => value + 1),
    /** Begin a new setup after the previous one was cancelled or expired. */
    restart: (previousId: string) => setBeginKey(`mcp-restart:${previousId}`),
  };
}

/**
 * After the key is verified and the server installed, add its tools to this
 * chat with the existing CAS-fenced selection, which preserves every other
 * choice. A failure here never asks for the key again.
 */
export function usePreparedMcpSetupAccess({
  t,
  controller,
  client,
  workspaceId,
  sessionId,
  onConfigured,
}: {
  t: OpenGeniText;
  controller: ConnectController;
  client: OpenGeniClient;
  workspaceId: string;
  sessionId: string;
  onConfigured?: (() => void | Promise<void>) | undefined;
}) {
  const view = useConnect(controller);
  const [access, setAccess] = useState<"pending" | "ready" | "failed">("pending");
  const [retry, setRetry] = useState(0);
  const notify = useRef(onConfigured);
  notify.current = onConfigured;
  const id =
    view.attempt?.state === "complete" && view.attempt.integrationInstalled
      ? view.attempt.mcpCapabilityId
      : undefined;
  useEffect(() => {
    if (!id) return;
    let active = true;
    setAccess("pending");
    void (async () => {
      const item = (await client.listCapabilities(workspaceId)).items.find(
        (entry) => entry.id === id,
      );
      if (!active) return;
      if (!item?.enabled) throw new Error("Connection not yet visible");
      // Existing CAS-fenced selection preserves all other choices and cannot
      // widen a parent's ceiling or the currently accepted attempt's tools.
      await attachSessionCapability(t, client, workspaceId, sessionId, item, () => active);
      if (!active) return;
      setAccess("ready");
      // A host refresh failure cannot undo a verified connection or turn it
      // into a reason to resubmit credentials.
      void Promise.resolve(notify.current?.()).catch(() => {});
    })().catch(() => {
      if (active) setAccess("failed");
    });
    return () => {
      active = false;
    };
  }, [t, client, workspaceId, sessionId, id, retry]);
  return {
    view,
    /** The verified server's capability, once setup installed it. */
    connectedCapabilityId: id,
    access,
    /** The attempt ended without connecting; a new setup can start. */
    restartable: !!view.attempt && ["cancelled", "expired"].includes(view.attempt.state),
    recheckAccess: () => setRetry((value) => value + 1),
  };
}
