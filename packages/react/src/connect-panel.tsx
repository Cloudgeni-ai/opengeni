import { ConnectAccounts } from "./connect-accounts";
import { ConnectChooser } from "./connect-chooser";
import { ConnectSetup, type ConnectSetupProps } from "./connect-setup";
import { useConnect } from "./connect";
import type { OpenGeniClient } from "@opengeni/sdk";
import { useState } from "react";
import { ConnectionDiscovery } from "./connection-discovery";

export type ConnectPanelProps = ConnectSetupProps & {
  returnUrl: string;
  /** Null omits the heading when the host already supplies one. */
  title?: string | null;
  showAccounts?: boolean;
  /** Presentation only; the host backend owns acquisition admission. */
  showCustomConnections?: boolean;
  /** Include ready, non-custom adapters from the host's Connect catalogue. */
  showProviderConnections?: boolean;
  presentation?: "select" | "catalog";
  client?: OpenGeniClient | undefined;
};

/** Optional composition over the same unstyled surfaces. Import
 * @opengeni/react/connect.css for styling; the host retains navigation,
 * transport, actor admission, and controller lifetime. */
export function ConnectPanel({
  returnUrl,
  title = "Connections",
  showAccounts = true,
  showCustomConnections = true,
  showProviderConnections = false,
  presentation = "select",
  className,
  client,
  ...setup
}: ConnectPanelProps) {
  const { attempt } = useConnect(setup.controller);
  const [inventoryRevision, setInventoryRevision] = useState(0);
  // Unknown/failed outcomes still need reconciliation or cancellation, not a
  // competing new acquisition. Unmounting observers never cancels controller work.
  const activeSetup =
    attempt !== null && !["complete", "cancelled", "expired"].includes(attempt.state);
  return (
    <div className={["og-connect", className].filter(Boolean).join(" ")}>
      {title !== null && <h2>{title}</h2>}
      {showAccounts && !activeSetup && (
        <ConnectAccounts
          key={inventoryRevision}
          controller={setup.controller}
          returnUrl={returnUrl}
          client={client}
        />
      )}
      {!activeSetup &&
        (client && presentation === "catalog" ? (
          <>
            <ConnectionDiscovery
              client={client}
              workspaceId={setup.controller.workspaceId}
              returnUrl={returnUrl}
              onConfigured={() => setInventoryRevision((value) => value + 1)}
            />
            {showProviderConnections && (
              <ConnectChooser
                compact
                providerOnly
                presentation="catalog"
                controller={setup.controller}
                returnUrl={returnUrl}
              />
            )}
            {showCustomConnections && (
              <details className="og-connect-secondary">
                <summary>Custom connection</summary>
                <ConnectChooser
                  customOnly
                  presentation={presentation}
                  controller={setup.controller}
                  returnUrl={returnUrl}
                />
              </details>
            )}
          </>
        ) : (
          <ConnectChooser
            presentation={presentation}
            controller={setup.controller}
            returnUrl={returnUrl}
          />
        ))}
      {activeSetup && <ConnectSetup {...setup} />}
    </div>
  );
}
