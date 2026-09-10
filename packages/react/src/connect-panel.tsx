import { ConnectAccounts } from "./connect-accounts";
import { ConnectChooser } from "./connect-chooser";
import { ConnectSetup, type ConnectSetupProps } from "./connect-setup";

export type ConnectPanelProps = ConnectSetupProps & {
  returnUrl: string;
  title?: string;
  showAccounts?: boolean;
};

/** Optional composition over the same unstyled surfaces. Import
 * @opengeni/react/connect.css for styling; the host retains navigation,
 * transport, actor admission, and controller lifetime. */
export function ConnectPanel({
  returnUrl,
  title = "Connections",
  showAccounts = true,
  className,
  ...setup
}: ConnectPanelProps) {
  return (
    <div className={["og-connect", className].filter(Boolean).join(" ")}>
      <h2>{title}</h2>
      <ConnectChooser controller={setup.controller} returnUrl={returnUrl} />
      <ConnectSetup {...setup} />
      {showAccounts && <ConnectAccounts controller={setup.controller} returnUrl={returnUrl} />}
    </div>
  );
}
