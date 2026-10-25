// index.html installs the bridge before the app host loads.
import { params } from "./bridge";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LaptopIcon } from "lucide-react";
import {
  DesktopThisComputerOffer,
  DesktopThisComputerPanel,
  DesktopThisComputerProvider,
} from "@opengeni/react/app/components/desktop/this-computer";
import { ConnectMachineDialog } from "@opengeni/react/app/components/machines/connect-machine-dialog";
import { MachinesDashboard } from "@opengeni/react/machines";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { staging } from "./host";
import "../../../src/styles.css";

const dark = params.get("theme") !== "light";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.ogTheme = dark ? "dark" : "light";

function Machines() {
  const [connectOpen, setConnectOpen] = useState(params.has("connect"));
  return (
    <div className="flex min-h-screen bg-bg text-fg">
      <aside
        className="flex w-64 shrink-0 flex-col justify-end border-r border-border bg-bg-subtle pb-3"
        data-preview-sidebar=""
      >
        <DesktopThisComputerOffer className="mx-2 mt-2" />
        <div className="mx-2 mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
          <span className="flex size-6 items-center justify-center rounded-full bg-bg-muted text-xs">
            B
          </span>
          Bendik
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <ContentPage width="standard">
          <PageHeader
            icon={<LaptopIcon className="size-4" />}
            title="Machines"
            description="Your own computers, connected as agent sandboxes. One agent can serve this workspace alongside any other Opengeni workspaces or deployments already connected to the machine."
          />
          <div className="pt-6">
            <DesktopThisComputerPanel className="mb-6" />
            <MachinesDashboard
              machines={[staging]}
              activeSandboxId={null}
              loading={false}
              error={null}
              seriesByMachine={{}}
              onOpenDetail={() => undefined}
              now={Date.now()}
              onRefresh={() => undefined}
              onEnroll={() => setConnectOpen(true)}
            />
          </div>
        </ContentPage>
      </main>
      <ConnectMachineDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        workspaceId="workspace"
        origin="https://staging.app.opengeni.ai"
        machines={[staging]}
        machinesLoading={false}
        machinesError={null}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <DesktopThisComputerProvider workspaceId="workspace">
    <Machines />
  </DesktopThisComputerProvider>,
);
