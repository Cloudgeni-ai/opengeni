import { OpenGeniAppsClient, type OpenGeniAppsControlTransport } from "@opengeni/sdk/apps";
import { createContext, useContext, useMemo, type ReactNode } from "react";

const AppsControlContext = createContext<OpenGeniAppsClient | null>(null);

export function AppsControlProvider({
  transport,
  children,
}: {
  transport?: OpenGeniAppsControlTransport;
  children: ReactNode;
}) {
  const client = useMemo(() => (transport ? new OpenGeniAppsClient(transport) : null), [transport]);
  return <AppsControlContext.Provider value={client}>{children}</AppsControlContext.Provider>;
}

export function useAppsControlClient(): OpenGeniAppsClient | null {
  return useContext(AppsControlContext);
}
