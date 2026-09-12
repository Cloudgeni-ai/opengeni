import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionCatalog } from "@opengeni/react/connect";
import { CapabilityCatalogItem } from "@opengeni/contracts";
import "@opengeni/react/connect.css";
import { CapabilityDetailSheet } from "../src/components/capabilities/capability-detail-sheet";
import { IntegrationSheet } from "../src/components/capabilities/integration-sheet";
import "../src/styles.css";

function Fixture() {
  const params = new URLSearchParams(window.location.search);
  const plugin = params.has("plugin");
  const long = params.has("long");
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  return (
    <main className="mx-auto max-w-5xl p-6 sm:p-12">
      <h1 className="mb-2 text-xl font-semibold">Capabilities</h1>
      <p className="mb-8 text-sm text-fg-muted">
        Connect your favorite tools and extend OpenGeni’s capabilities.
      </p>
      <ConnectionCatalog
        services={[
          {
            id: "drive",
            name: "Google Drive",
            options: [
              {
                id: "drive",
                name: "Google Drive",
                description:
                  "Browse selected folders and Shared Drives for read-only knowledge sync.",
                status: "Connected",
                connected: true,
                onOpen: () => {
                  opener.current = document.activeElement as HTMLElement;
                  setOpen(true);
                },
              },
            ],
          },
        ]}
      />
      {plugin ? (
        <CapabilityDetailSheet
          open={open}
          onOpenChange={setOpen}
          restoreFocusRef={opener}
          item={CapabilityCatalogItem.parse({
            id: "plugin:source-package",
            kind: "plugin",
            source: "manual",
            name: "Source Package",
            description: "Reviewed tools for your workspace. ".repeat(long ? 100 : 1),
            category: "developer-tools",
            enabled: true,
            runtime: { available: true, notes: null },
            lifecycle: {
              status: "installed",
              readiness: "ready",
              detail: "installed",
              managedBy: "workspace",
            },
            actions: ["configure", "update", "uninstall", "inspect"],
          })}
          health={{ state: "none" }}
          logoSrc={null}
          busy={false}
          errorMessage={null}
          onAction={() => {}}
        />
      ) : (
        <IntegrationSheet
          open={open}
          onOpenChange={setOpen}
          restoreFocusRef={opener}
          model={{
            id: "drive",
            name: "Google Drive",
            description: "Browse selected folders and Shared Drives for read-only knowledge sync.",
            mark: { monogram: "G" },
            chip: { label: "Connected", tone: "ok" },
            connection: [
              { label: "Google account", value: "Example account" },
              { label: "Publishing", value: "Not enabled" },
              ...(long
                ? Array.from({ length: 30 }, (_, index) => ({
                    label: `Folder ${index + 1}`,
                    value: "Read-only",
                  }))
                : []),
            ],
            access: {
              title: "Folders",
              items: [
                {
                  name: "No folders selected yet. Choose folders to make them available to your agents.",
                },
              ],
            },
            options: [
              {
                kind: "toggle",
                id: "publishing",
                label: "Publish finished documents to Drive",
                description:
                  "Asks Google for separate write access to the output folder you choose.",
                checked: false,
                onChange: () => {},
              },
            ],
            disclosures: [
              {
                id: "access",
                text: "OpenGeni requests read-only Google Drive access to browse folders and Shared Drives. Source sync only imports supported files within the boundaries you select. Publishing is optional and requests separate consent.",
              },
            ],
            footer: { kind: "connected", onReconnect: () => {}, onDisconnect: () => {} },
          }}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
