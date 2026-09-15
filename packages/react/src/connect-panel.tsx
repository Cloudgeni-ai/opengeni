import { ConnectAccounts } from "./connect-accounts";
import { ConnectChooser } from "./connect-chooser";
import { ConnectSetup, type ConnectSetupProps } from "./connect-setup";
import { useConnect } from "./connect";

export type ConnectPanelProps = ConnectSetupProps & {
  returnUrl: string;
  /** Null omits the heading when the host already supplies one. */
  title?: string | null;
  showAccounts?: boolean;
  presentation?: "select" | "catalog";
};

/** Optional composition over the same unstyled surfaces. Import
 * @opengeni/react/connect.css for styling; the host retains navigation,
 * transport, actor admission, and controller lifetime. */
export function ConnectPanel({
  returnUrl,
  title = "Connections",
  showAccounts = true,
  presentation = "select",
  className,
  ...setup
}: ConnectPanelProps) {
  const { attempt } = useConnect(setup.controller);
  // Unknown/failed outcomes still need reconciliation or cancellation, not a
  // competing new acquisition. Unmounting observers never cancels controller work.
  const activeSetup =
    attempt !== null && !["complete", "cancelled", "expired"].includes(attempt.state);
  return (
    <div className={["og-connect", className].filter(Boolean).join(" ")}>
      {title !== null && <h2>{title}</h2>}
      {!activeSetup && (
        <ConnectChooser
          presentation={presentation}
          controller={setup.controller}
          returnUrl={returnUrl}
        />
      )}
      <ConnectSetup {...setup} />
      {showAccounts && !activeSetup && (
        <ConnectAccounts controller={setup.controller} returnUrl={returnUrl} />
      )}
    </div>
  );
}
