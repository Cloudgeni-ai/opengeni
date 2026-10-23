// "Use this computer" in the Mac app: the app runs the connected-machine agent
// and these screens come from `@opengeni/react/this-computer`. Outside the Mac
// app (the browser dev build) there is no bridge and agents simply never get
// this computer.
import {
  ThisComputerSetup,
  defaultThisComputerLabels,
  useThisComputer,
  useThisComputerSetupOpen,
  type ThisComputerHost,
  type ThisComputerLabels,
  type ThisComputerPlatform,
  type UseThisComputerResult,
} from "@opengeni/react/this-computer";
import "@opengeni/react/this-computer.css";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type Bridge = { productName: string; thisComputer: ThisComputerHost };

const bridge: Bridge | null =
  typeof window === "undefined"
    ? null
    : ((window as unknown as { opengeniSimple?: Bridge }).opengeniSimple ?? null);

export type AppComputer = {
  computer: UseThisComputerResult;
  platform: ThisComputerPlatform;
  productName: string;
  labels: ThisComputerLabels;
  openSetup(): void;
};

const Context = createContext<AppComputer | null>(null);

/** This computer for the open workspace; null outside the Mac app. */
export function useAppComputer() {
  return useContext(Context);
}

export const insideMacApp = bridge !== null;

export function AppComputerProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const host = bridge?.thisComputer ?? null;
  const computer = useThisComputer(host, workspaceId);
  const [open, setOpen] = useThisComputerSetupOpen(computer);
  const labels = useMemo(() => simpleLabels(defaultThisComputerLabels()), []);
  // The setup dialog portals here so it wears the app's colors.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const value = useMemo<AppComputer | null>(
    () =>
      host
        ? {
            computer,
            platform: host.platform,
            productName: host.productName,
            labels,
            openSetup: () => setOpen(true),
          }
        : null,
    [computer, host, labels, setOpen],
  );
  return (
    <Context.Provider value={value}>
      {children}
      {host ? (
        <div ref={setContainer} className="simple-connections">
          {container ? (
            <ThisComputerSetup
              open={open}
              onOpenChange={setOpen}
              computer={computer}
              platform={host.platform}
              productName={host.productName}
              appIcon="/app-icon.png"
              labels={labels}
              container={container}
            />
          ) : null}
        </div>
      ) : null}
    </Context.Provider>
  );
}

// The app has no menu bar item: pausing lives in Settings > Computer.
function simpleLabels(labels: ThisComputerLabels): ThisComputerLabels {
  return {
    ...labels,
    safety: () => "Only you can ask for this, in your own chats. Pause it any time in Settings.",
    done: (machineName) => `Agents can now use ${machineName}. Pause any time in Settings.`,
    pauseHint: () => "While it's on, agents can use it in any of your chats.",
    resumeHint: () => "Agents can't use this computer while it's paused.",
    trayName: () => "Settings",
  };
}
