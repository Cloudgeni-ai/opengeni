import type { ConnectAccount } from "@opengeni/connect";
import type { CapabilityCatalogItem, OpenGeniClient } from "@opengeni/sdk";
import { ConnectionServiceLogo } from "./connection-service-logo";
import {
  accountServiceCapability,
  connectionServicePresentation,
} from "./connection-service-presentation";

/** Service presentation never changes which exact credential is acted on. */
export function ConnectAccountIdentity({
  account,
  client,
  capabilities,
}: {
  account: ConnectAccount;
  client?: OpenGeniClient | undefined;
  capabilities: CapabilityCatalogItem[];
}) {
  const item = accountServiceCapability(account, capabilities);
  const service = connectionServicePresentation({ id: account.providerId, label: account.label });
  const name = item?.name ?? service.name;
  return (
    <>
      <ConnectionServiceLogo client={client} item={item} name={name} fallback={service.logo} />
      <div>
        <strong>{name}</strong>
        <small>
          {account.ownership === "personal" ? "Only you" : "Workspace connection"}
          {name !== account.label ? ` · ${account.label}` : ""}
        </small>
      </div>
    </>
  );
}
