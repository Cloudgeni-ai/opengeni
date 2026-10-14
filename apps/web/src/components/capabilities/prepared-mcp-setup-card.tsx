import { useEffect, useRef, useState } from "react";
import { ConnectController } from "@opengeni/connect";
import { ConnectSetup, useConnect } from "@opengeni/react/connect";
import { attachSessionCapability, type AuthNeededItem } from "@opengeni/react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Button } from "@/components/ui/button";
import { SessionCapabilityFrame } from "./session-capability-frame";
import "@opengeni/react/connect.css";

type Props = {
  item: AuthNeededItem;
  workspaceId: string;
  sessionId: string;
  client: OpenGeniBrowserClient;
  actorId: string;
  canConfigure: boolean;
  onConfigured?: (() => Promise<void>) | undefined;
};

/** Client/actor changes discard unsent secret DOM. No credential is placed in
 * component state, an event, local storage, or an OAuth redirect. */
export function PreparedMcpSetupCard(props: Props) {
  const [client, setClient] = useState(props.client);
  const [generation, setGeneration] = useState(0);
  if (client !== props.client) {
    setClient(props.client);
    setGeneration(generation + 1);
  }
  return (
    <ScopedCard
      key={JSON.stringify([
        generation,
        props.workspaceId,
        props.sessionId,
        props.actorId,
        props.item.id,
        props.item.setupRequest,
        props.canConfigure,
      ])}
      {...props}
    />
  );
}

function ScopedCard({ item, client, workspaceId, sessionId, canConfigure, onConfigured }: Props) {
  const [proposal] = useState(() => item.setupRequest!);
  const [controller, setController] = useState<ConnectController | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [beginKey, setBeginKey] = useState(`mcp-card:${item.id}`);
  const configured = useRef(onConfigured);
  configured.current = onConfigured;
  useEffect(() => {
    if (!canConfigure || !proposal.mcpSetup || !proposal.ownership) return;
    let active = true;
    const next = new ConnectController(client.connectTransport(), workspaceId);
    setController(next);
    setFailed(false);
    // The card identity is a stable operation key, including across reload and
    // Strict Mode. Never recover an unrelated pending setup by provider alone.
    void next
      .begin({
        providerId: "mcp-headers",
        ownership: proposal.ownership,
        mcpSetup: proposal.mcpSetup,
        idempotencyKey: beginKey,
        returnUrl: new URL(window.location.pathname, window.location.origin).href,
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      next.dispose();
    };
  }, [client, workspaceId, canConfigure, proposal, beginKey, retry]);

  const contents = !canConfigure ? (
    <p role="status">
      Someone with connection and integration management access needs to connect this server.
    </p>
  ) : failed ? (
    <div role="alert">
      <p>Could not load this connection setup. Your key has not been submitted.</p>
      <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
        Reload setup
      </Button>
    </div>
  ) : controller ? (
    <PreparedSetup
      controller={controller}
      client={client}
      workspaceId={workspaceId}
      sessionId={sessionId}
      onConfigured={() => configured.current?.()}
      onRestart={(previousId) => setBeginKey(`mcp-restart:${previousId}`)}
    />
  ) : (
    <p role="status">Preparing the key form…</p>
  );
  return (
    <SessionCapabilityFrame
      name={proposal.name}
      subtitle={proposal.endpointUrl}
      logo={null}
      typeLabel="MCP server"
      description={proposal.rationale}
      skill={false}
      expanded={false}
      complete={false}
      actionLabel="Connect"
      opensDialog={false}
      note="Keys stay in the protected form, never in chat. The server and headers are already configured."
      onOpen={() => {}}
      onClose={() => {}}
      inlineSetup={contents}
    />
  );
}

function PreparedSetup({
  controller,
  client,
  workspaceId,
  sessionId,
  onConfigured,
  onRestart,
}: {
  controller: ConnectController;
  client: OpenGeniBrowserClient;
  workspaceId: string;
  sessionId: string;
  onConfigured(): void | Promise<void>;
  onRestart(previousId: string): void;
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
      await attachSessionCapability(client, workspaceId, sessionId, item, () => active);
      if (!active) return;
      setAccess("ready");
      // A host refresh failure cannot undo a verified connection or turn it
      // into a reason to resubmit credentials.
      void Promise.resolve(notify.current()).catch(() => {});
    })().catch(() => {
      if (active) setAccess("failed");
    });
    return () => {
      active = false;
    };
  }, [client, workspaceId, sessionId, id, retry]);

  return (
    <>
      <ConnectSetup
        controller={controller}
        className="og-connect"
        onAuthorize={() => {
          throw new Error("Prepared key setup does not use OAuth");
        }}
      />
      {view.attempt && ["cancelled", "expired"].includes(view.attempt.state) ? (
        <Button variant="outline" onClick={() => onRestart(view.attempt!.id)}>
          Start a new setup
        </Button>
      ) : null}
      {id ? (
        access === "ready" ? (
          <p role="status">Connected. Its tools are available from your next message.</p>
        ) : access === "failed" ? (
          <div role="alert">
            <p>
              Connected, but chat access could not be confirmed. Your key is saved; do not submit it
              again.
            </p>
            <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
              Check chat access
            </Button>
          </div>
        ) : (
          <p role="status">Connected. Checking this chat's tool access…</p>
        )
      ) : null}
    </>
  );
}
