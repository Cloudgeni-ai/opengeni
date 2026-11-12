import { ConnectAccounts } from "./connect-accounts";
import type { ChatClient } from "@opengeni/sdk";
import { ConnectChooser } from "./connect-chooser";
import { ConnectSetup, adminApprovalLink, type ConnectSetupProps } from "./connect-setup";
import type { ConnectAttempt } from "@opengeni/connect";
import { useConnect } from "./hooks/use-connect";
import type { OpenGeniClient } from "@opengeni/sdk";
import { useState } from "react";
import { connectionServicePresentation } from "./connection-service-presentation";
import { ConnectionDiscovery } from "./connection-discovery";
import { useOpenGeniText } from "./messages/runtime";
import { useNobodyToShareWith } from "./workspace-sharing";

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
  client?: ChatClient<OpenGeniClient> | undefined;
  /**
   * The host's `onAuthorize` opens the provider's sign-in in a popup. Setup
   * started here then returns that popup to a small page that closes itself,
   * instead of loading `returnUrl` (a second copy of the host) inside it.
   * Leave unset when sign-in redirects the whole page.
   */
  finishInPopup?: boolean;
};

/** Setup that has ended; the panel goes back to its service list. */
const SETTLED: readonly ConnectAttempt["state"][] = ["complete", "cancelled", "expired"];

/** Optional composition over the same unstyled surfaces. Import
 * @opengeni/react/connect.css for styling; the host retains navigation,
 * transport, actor admission, and controller lifetime. */
export function ConnectPanel({
  returnUrl,
  title: titleProp,
  showAccounts = true,
  showCustomConnections = true,
  showProviderConnections = false,
  presentation = "select",
  className,
  client,
  finishInPopup = false,
  ...setup
}: ConnectPanelProps) {
  const t = useOpenGeniText();
  const title = titleProp === undefined ? t("connectPanel.connections") : titleProp;
  const { attempt } = useConnect(setup.controller);
  const [inventoryRevision, setInventoryRevision] = useState(0);
  // The ended setup whose organization approval help the person put away.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const alone = useNobodyToShareWith(client, setup.controller.workspaceId);
  // The provider ended the sign-in and the server stored its organization
  // approval link with the outcome: an administrator must (or may have to)
  // approve the app first. Leaving Microsoft's "Need admin approval" page
  // comes back as a cancel, so that help stays up instead of the panel
  // quietly returning to its list. A plain cancel stores no link and ends.
  const approvalHelp = attempt !== null && adminApprovalLink(attempt) !== null;
  // Unknown/failed outcomes still need reconciliation or cancellation, not a
  // competing new acquisition. Unmounting observers never cancels controller work.
  const activeSetup =
    attempt !== null &&
    attempt.id !== dismissed &&
    (approvalHelp || !SETTLED.includes(attempt.state));
  const serviceName = attempt
    ? connectionServicePresentation({ id: attempt.providerId, label: "" }, t).name
    : "";
  const popup = finishInPopup ? { finishInPopup: true as const } : {};
  // Once IT approved, the person signs in again: a fresh setup for the same
  // service and owner, unless the host starts its own.
  const retry =
    setup.onRetry ??
    (attempt && approvalHelp
      ? () =>
          setup.controller.begin({
            providerId: attempt.providerId,
            ownership: attempt.ownership,
            returnUrl,
            ...popup,
            idempotencyKey: crypto.randomUUID(),
          })
      : undefined);
  return (
    <div className={["og-connect", className].filter(Boolean).join(" ")}>
      {title !== null && <h2>{title}</h2>}
      {showAccounts && !activeSetup && (
        <ConnectAccounts
          key={inventoryRevision}
          controller={setup.controller}
          returnUrl={returnUrl}
          finishInPopup={finishInPopup}
          client={client}
          onDisconnected={() => setInventoryRevision((value) => value + 1)}
        />
      )}
      {!activeSetup &&
        (client && presentation === "catalog" ? (
          <>
            <ConnectionDiscovery
              key={inventoryRevision}
              controller={showProviderConnections ? setup.controller : undefined}
              client={client}
              workspaceId={setup.controller.workspaceId}
              returnUrl={returnUrl}
              finishInPopup={finishInPopup}
              onConfigured={() => setInventoryRevision((value) => value + 1)}
            />
            {showCustomConnections && (
              <details className="og-connect-secondary">
                <summary>{t("connectPanel.customConnection")}</summary>
                <ConnectChooser
                  customOnly
                  presentation={presentation}
                  controller={setup.controller}
                  returnUrl={returnUrl}
                  finishInPopup={finishInPopup}
                  personalOnly={alone}
                />
              </details>
            )}
          </>
        ) : (
          <ConnectChooser
            presentation={presentation}
            controller={setup.controller}
            returnUrl={returnUrl}
            finishInPopup={finishInPopup}
            personalOnly={alone}
          />
        ))}
      {activeSetup && attempt && approvalHelp && (
        <button type="button" onClick={() => setDismissed(attempt.id)}>
          {t("connectPanel.backToConnections")}
        </button>
      )}
      {activeSetup && (
        <ConnectSetup
          {...setup}
          onRetry={retry}
          serviceName={setup.serviceName ?? (serviceName || undefined)}
          authorizeLabel={
            setup.authorizeLabel ??
            (serviceName
              ? t("connectPanel.continueToServicename", { serviceName })
              : t("connectPanel.authorizeConnection"))
          }
        />
      )}
    </div>
  );
}
