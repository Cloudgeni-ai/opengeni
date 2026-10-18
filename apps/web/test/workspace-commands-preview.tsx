import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { LaptopIcon } from "lucide-react";
import type { WorkspaceBackgroundCommand } from "@opengeni/sdk";
import { MachinesDashboard } from "@opengeni/react/machines";
import { onlineMachine } from "../../../packages/react/demo/machines-fixtures";
import { WorkspaceCommands } from "../src/components/machines/workspace-commands";
import { ContentPage } from "../src/components/ui/content-layout";
import { PageHeader } from "../src/components/ui/page-header";
import "../src/styles.css";

const now = Date.parse("2026-10-18T12:00:00Z");
const workspaceId = "11111111-1111-4111-8111-111111111111";
const rows: WorkspaceBackgroundCommand[] = [
  ["Preview the customer portal", "Build workstation", "bun run start --host 0.0.0.0", 12600],
  [
    "Watch asset changes for the design system and its shared component documentation",
    "Design laptop",
    "bun run watch --filter @example/components --preserveWatchOutput",
    7320,
  ],
  ["Refresh the search index", null, "bun run search:index --watch", 180500],
].map(([sessionTitle, machineName, commandPreview, seconds], index) => ({
  id: `22222222-2222-4222-8222-22222222222${index}`,
  sessionId: `33333333-3333-4333-8333-33333333333${index}`,
  workspaceId,
  provider: index === 2 ? "managed" : "connected_machine",
  state: "running",
  sessionTitle: String(sessionTitle),
  machineName: machineName as string | null,
  commandPreview: String(commandPreview),
  commandText: String(commandPreview),
  startedAt: new Date(now - Number(seconds) * 1000).toISOString(),
  updatedAt: new Date(now).toISOString(),
  cancelRequestedAt: null,
  settledAt: null,
  exitCode: null,
  settlementReason: null,
}));

function Preview() {
  const mode = new URLSearchParams(location.search).get("state");
  const [commands, setCommands] = useState(mode === "empty" || mode === "loading" ? [] : rows);
  const [error, setError] = useState<Error | null>(mode === "error" ? new Error("Offline") : null);
  const [loading, setLoading] = useState(mode === "loading");
  return (
    <main className="min-h-screen bg-canvas text-fg">
      <ContentPage width="standard">
        <PageHeader
          title="Machines"
          icon={<LaptopIcon className="size-4" />}
          description="Your own computers, connected as agent sandboxes."
        />
        <div className="pt-6">
          <MachinesDashboard
            machines={[{ ...onlineMachine, name: "Build workstation", metrics: null }]}
            activeSandboxId={null}
            loading={false}
            error={null}
            onRefresh={() => {}}
            onOpenDetail={() => {}}
            now={now}
          />
        </div>
        <WorkspaceCommands
          workspaceId={workspaceId}
          canControl={mode !== "readonly"}
          now={now}
          commands={{
            commands: error ? [] : commands,
            error,
            loading,
            refresh: async () => {
              setError(null);
              setLoading(false);
              setCommands(rows);
            },
            cancel: async (id) => {
              if (mode === "stop-error")
                throw new Error("The command could not be stopped. Try again.");
              setCommands((items) =>
                items.map((item) => (item.id === id ? { ...item, state: "stopping" } : item)),
              );
            },
            hasMore: false,
            loadMore: () => {},
          }}
        />
      </ContentPage>
    </main>
  );
}
const routeTree = createRootRoute({ component: Preview });
const router = createRouter({ routeTree, history: createMemoryHistory() });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
