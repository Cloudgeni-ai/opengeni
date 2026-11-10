import type { ConnectAccount } from "@opengeni/connect";
import type { ChatClient } from "@opengeni/sdk";
import type { CapabilityCatalogItem, OpenGeniClient } from "@opengeni/sdk";
import { ConnectionServiceLogo } from "./connection-service-logo";
import {
  accountServiceCapability,
  connectionServicePresentation,
  connectionServiceWording,
} from "./connection-service-presentation";
import { useOpenGeniText } from "./messages/runtime";

/** Service presentation never changes which exact credential is acted on. */
export function ConnectAccountIdentity({
  account,
  client,
  capabilities,
}: {
  account: ConnectAccount;
  client?: ChatClient<OpenGeniClient> | undefined;
  capabilities: CapabilityCatalogItem[];
}) {
  const t = useOpenGeniText();
  const item = accountServiceCapability(account, capabilities);
  const service = connectionServicePresentation({ id: account.providerId, label: account.label });
  // The host's name for the service wins, so it reads as it did in discovery.
  const name = connectionServiceWording(t, account.providerId).name ?? item?.name ?? service.name;
  return (
    <>
      <ConnectionServiceLogo client={client} item={item} name={name} fallback={service.logo} />
      <div>
        <strong>{name}</strong>
        <small>
          {account.ownership === "personal"
            ? t("connectAccountIdentity.onlyYou")
            : t("connectAccountIdentity.workspaceConnection")}
          {name !== account.label ? ` · ${account.label}` : ""}
        </small>
      </div>
    </>
  );
}
