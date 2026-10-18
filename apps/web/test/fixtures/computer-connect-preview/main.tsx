import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ThisComputerCard,
  ThisComputerSetup,
  useThisComputer,
} from "@opengeni/react/this-computer";
import type { AuthNeededItem } from "@opengeni/react";
import { SessionMachineCapabilityCard } from "../../../src/components/capabilities/session-machine-card";
import { DesktopContext, host, params } from "./host";
import "../../../src/styles.css";
import "../../../src/components/capabilities/session-capability-card.css";
import "@opengeni/react/this-computer.css";

const request = {
  id: "offer",
  kind: "auth-needed",
  capability: {
    id: "api:connected-machine",
    name: "Your computer",
    rationale: "Let me work with the files on your computer.",
    requiredVariables: [],
  },
} as unknown as AuthNeededItem;
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
document.documentElement.dataset.ogTheme = params.get("theme") === "dark" ? "dark" : "light";
function Preview() {
  const computer = useThisComputer(host, "workspace");
  const [open, setOpen] = useState(false);
  const desktop = useMemo(() => ({ computer, openSetup: () => setOpen(true) }), [computer]);
  const embedded = params.get("environment") === "embed";
  return (
    <main style={{ maxWidth: 620, margin: "40px auto", padding: 16 }}>
      <DesktopContext.Provider value={desktop}>
        {embedded ? (
          <ThisComputerCard
            productName="Example App"
            rationale={request.capability!.rationale}
            {...(params.has("installed")
              ? { computer, onSetup: () => setOpen(true) }
              : {
                  downloads: [
                    { label: "Download Example App", url: "https://example.com/download" },
                  ],
                  openAppUrl: "example://connect?destination=chat",
                })}
          />
        ) : (
          <SessionMachineCapabilityCard
            item={request}
            workspaceId="workspace"
            sessionId="session"
          />
        )}
        <ThisComputerSetup
          open={open}
          onOpenChange={setOpen}
          computer={computer}
          platform={host.platform}
          productName={host.productName}
        />
      </DesktopContext.Provider>
    </main>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview />);
import.meta.hot?.dispose(() => root.unmount());
