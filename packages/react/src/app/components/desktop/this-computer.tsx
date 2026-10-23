// "Use this computer" inside the Opengeni desktop app: the app runs the
// connected-machine agent and the web app shows the shared screens from
// `@opengeni/react/this-computer`. Outside the desktop app (or where the
// deployment doesn't offer connected machines) everything here renders nothing.
import {
  ThisComputerOffer,
  ThisComputerPanel,
  ThisComputerSetup,
  defaultThisComputerLabels,
  useThisComputer,
  useThisComputerOfferDismissed,
  useThisComputerSetupOpen,
  type ThisComputerHost,
  type ThisComputerLabels,
  type ThisComputerPlatform,
  type UseThisComputerResult,
} from "../../../this-computer";
import "../../../../styles/this-computer.css";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useAppContext } from "../../app-context";
import { desktopBridge, desktopCapability } from "../../lib/desktop";

export interface DesktopThisComputer {
  workspaceId: string;
  computer: UseThisComputerResult;
  platform: ThisComputerPlatform;
  productName: string;
  labels: ThisComputerLabels;
  /** Opens the setup steps: turning it on, or finishing the permissions. */
  openSetup(): void;
}

const Context = createContext<DesktopThisComputer | null>(null);

/** This computer for the open workspace; null outside the desktop app. */
export function useDesktopThisComputer(): DesktopThisComputer | null {
  return useContext(Context);
}

/** The bridge as the shared screens' host. */
function bridgeHost(): ThisComputerHost | null {
  const bridge = desktopCapability("thisComputer");
  if (!bridge) return null;
  const computer = bridge.thisComputer;
  return {
    platform: bridge.platform,
    productName: bridge.productName,
    status: (workspaceId) => computer.status(workspaceId),
    connect: (workspaceId, options) => computer.connect(workspaceId, options),
    pause: () => computer.pause(),
    resume: () => computer.resume(),
    ...(computer.requestPermission
      ? { requestPermission: (id) => computer.requestPermission!(id) }
      : {}),
    ...(computer.disconnect
      ? { disconnect: (workspaceId) => computer.disconnect!(workspaceId) }
      : {}),
    onChange: (listener) => computer.onChange(listener),
  };
}

const host = typeof window === "undefined" ? null : bridgeHost();

/** Mounted once per workspace shell, around the rail and the pages. */
export function DesktopThisComputerProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  // Only where the deployment lets people connect their own computers.
  const { clientConfig } = useAppContext();
  const offered = clientConfig.connectedMachines !== false ? host : null;
  const computer = useThisComputer(offered, workspaceId);
  const [open, setOpen] = useThisComputerSetupOpen(computer);
  const labels = useMemo(() => defaultThisComputerLabels(), []);
  const value = useMemo<DesktopThisComputer | null>(
    () =>
      offered
        ? {
            workspaceId,
            computer,
            platform: offered.platform,
            productName: offered.productName,
            labels,
            openSetup: () => setOpen(true),
          }
        : null,
    [computer, labels, offered, setOpen, workspaceId],
  );
  return (
    <Context.Provider value={value}>
      {children}
      {offered ? (
        <ThisComputerSetup
          open={open}
          onOpenChange={setOpen}
          computer={computer}
          platform={offered.platform}
          productName={offered.productName}
          appIcon="/icon-192.png"
          labels={labels}
        />
      ) : null}
    </Context.Provider>
  );
}

/** Above the account row: the offer, or what's left to do; nothing once it's ready. */
export function DesktopThisComputerOffer({ className }: { className?: string | undefined }) {
  const desktop = useDesktopThisComputer();
  if (!desktop) return null;
  return <DismissibleOffer desktop={desktop} className={className} />;
}

function DismissibleOffer({
  desktop,
  className,
}: {
  desktop: DesktopThisComputer;
  className?: string | undefined;
}) {
  const [dismissed, dismiss] = useThisComputerOfferDismissed(desktop.workspaceId);
  return (
    <ThisComputerOffer
      computer={desktop.computer}
      labels={desktop.labels}
      onSetup={desktop.openSetup}
      dismissed={dismissed}
      onDismiss={dismiss}
      className={className}
    />
  );
}

/** Turning it on, pausing, resuming and turning it off, e.g. on the Machines page. */
export function DesktopThisComputerPanel({ className }: { className?: string | undefined }) {
  const desktop = useDesktopThisComputer();
  if (!desktop) return null;
  return (
    <ThisComputerPanel
      computer={desktop.computer}
      platform={desktop.platform}
      labels={desktop.labels}
      onSetup={desktop.openSetup}
      className={className}
    />
  );
}

/** True when the page runs inside a desktop app at all. */
export const insideDesktopApp = desktopBridge !== null;
