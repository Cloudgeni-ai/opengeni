import { t } from "../../lib/console-text";
import { useRef, useState } from "react";
import type { ConnectController } from "@opengeni/connect";
import { ConnectSetup } from "../../../connect";
import {
  usePreparedMcpSetupAccess,
  usePreparedMcpSetupAttempt,
} from "../../../components/prepared-mcp-setup-flow";
import type { AuthNeededItem } from "../../../timeline";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Button } from "../../../ui/button";
import { SessionCapabilityFrame } from "../../../components/session-capability-frame";
import "../../../../styles/connect.css";
import { usePage } from "../../lib/navigation";

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
  const page = usePage();
  const [returnUrl] = useState(() => new URL(new URL(page.href()).pathname, page.origin()).href);
  const setup = usePreparedMcpSetupAttempt({ client, workspaceId, item, canConfigure, returnUrl });
  const { proposal, controller, failed } = setup;
  const configured = useRef(onConfigured);
  configured.current = onConfigured;

  const contents = !canConfigure ? (
    <p role="status">{t("preparedMcpSetup.needsManager")}</p>
  ) : failed ? (
    <div role="alert">
      <p>{t("preparedMcpSetup.loadFailed")}</p>
      <Button variant="outline" onClick={setup.reload}>
        {t("preparedMcpSetup.reloadSetup")}
      </Button>
    </div>
  ) : controller ? (
    <PreparedSetup
      controller={controller}
      client={client}
      workspaceId={workspaceId}
      sessionId={sessionId}
      onConfigured={() => configured.current?.()}
      onRestart={setup.restart}
    />
  ) : (
    <p role="status">{t("preparedMcpSetup.preparing")}</p>
  );
  return (
    <SessionCapabilityFrame
      name={proposal.name}
      subtitle={proposal.endpointUrl}
      logo={null}
      typeLabel={t("sessionMcpCapabilityCard.mcpServer")}
      description={proposal.rationale}
      skill={false}
      expanded={false}
      complete={false}
      actionLabel={t("preparedMcpSetup.connect")}
      opensDialog={false}
      note={t("preparedMcpSetup.note")}
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
  const {
    view,
    connectedCapabilityId: id,
    access,
    restartable,
    recheckAccess,
  } = usePreparedMcpSetupAccess({ t, controller, client, workspaceId, sessionId, onConfigured });

  return (
    <>
      <ConnectSetup
        controller={controller}
        className="og-connect"
        onAuthorize={() => {
          throw new Error("Prepared key setup does not use OAuth");
        }}
      />
      {restartable && view.attempt ? (
        <Button variant="outline" onClick={() => onRestart(view.attempt!.id)}>
          {t("preparedMcpSetup.startNewSetup")}
        </Button>
      ) : null}
      {id ? (
        access === "ready" ? (
          <p role="status">{t("preparedMcpSetup.connected")}</p>
        ) : access === "failed" ? (
          <div role="alert">
            <p>{t("preparedMcpSetup.chatAccessFailed")}</p>
            <Button variant="outline" onClick={recheckAccess}>
              {t("preparedMcpSetup.checkChatAccess")}
            </Button>
          </div>
        ) : (
          <p role="status">{t("preparedMcpSetup.checkingChatAccess")}</p>
        )
      ) : null}
    </>
  );
}
