// DEV only. The production browser pages a desktop sign-in ends on, in each
// state, and the app's Connections rows before and after the app sees the
// finished connection (it watches for it; no deep link needed).
import "@opengeni/react/connect.css";
import { ConnectionCatalog } from "@opengeni/react/connect";
import { Button } from "@opengeni/react/ui/button";

import { ConnectReturnCard } from "@/components/connect-return-card";
import { DesktopReturnView } from "@/routes/desktop-return";

const appLink = "opengeni://open?url=%2Fworkspaces%2Fpreview%2Fplugins";
const browserLink = "/workspaces/preview/plugins";

export function ConnectReturnPreview() {
  return (
    <div className="grid min-h-dvh grid-cols-1 gap-4 p-6 md:grid-cols-2">
      <Frame label="Connected">
        <DesktopReturnView
          outcome={{ kind: "connected" }}
          appLink={appLink}
          browserLink={browserLink}
        />
      </Frame>
      <Frame label="Failed">
        <DesktopReturnView
          outcome={{ kind: "failed", message: "Gmail didn't allow access. Try again." }}
          appLink={appLink}
          browserLink={browserLink}
        />
      </Frame>
      <Frame label="Done (sign-in)">
        <DesktopReturnView outcome={{ kind: "done" }} appLink={appLink} browserLink={browserLink} />
      </Frame>
      <Frame label="Finishing after sign-in">
        <ConnectReturnCard tone="working" title="Finishing your connection…" />
      </Frame>
      <Frame label="App, while the browser is open">
        <div className="p-4">
          <ConnectionCatalog
            grouped={false}
            services={[gmail("Account removed", "attention", false)]}
          />
        </div>
      </Frame>
      <Frame label="App, once the browser finishes">
        <div className="p-4">
          <ConnectionCatalog grouped={false} services={[gmail("Connected", "added", true)]} />
        </div>
      </Frame>
    </div>
  );
}

function gmail(status: string, state: "attention" | "added", connected: boolean) {
  return {
    id: "gmail",
    name: "Gmail",
    options: [
      {
        id: "gmail",
        name: "Gmail",
        description: "Search, read, draft, and send email from your Gmail.",
        status,
        state,
        connected,
        onOpen: () => {},
        ...(connected
          ? {}
          : {
              action: (
                <Button size="sm" variant="outline">
                  Connect Gmail
                </Button>
              ),
            }),
      },
    ],
  };
}

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-80 flex-col rounded-lg border border-border">
      <p className="px-3 pt-2 text-xs text-fg-subtle">{label}</p>
      {children}
    </div>
  );
}
