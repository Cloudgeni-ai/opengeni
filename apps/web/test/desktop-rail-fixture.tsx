import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { OpenGeniProvider, WorkspaceDock } from "@opengeni/react";
import { SessionHeader } from "@opengeni/react/app/components/rail/session-header";
import { useWindowBarRowLeft } from "@opengeni/react/app/lib/window-bar-row";
import { applyDesktopWindowBar, desktopBridge } from "@opengeni/react/app/lib/desktop";
import type { Session } from "@opengeni/react/app/types";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { RailBody } from "../src/components/rail/rail-shell";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import { client, useRail, workspaceId } from "./desktop-rail-context";
import "../src/styles.css";

// The browser test installs the native bridge before module evaluation.
const params = new URLSearchParams(location.search);
const platform = params.get("platform") ?? "macos";
if (platform !== "browser") document.documentElement.dataset.desktop = platform;
applyDesktopWindowBar(document.documentElement, desktopBridge);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;
localStorage.setItem("opengeni.rail.nav", "true");
// `?view=chat`: a chat's page, with the real chat header at the top of the
// canvas, marked as the session shell marks it in the macOS app
// (`data-window-bar-row`). `?rail=none`: no rail beside the canvas (an embed).
// `?subchat=1`: the chat is a sub-chat, with its parent's line above the title.
const chat = params.get("view") === "chat";
const withRail = params.get("rail") !== "none";
const subchat = params.get("subchat") === "1";

const session = {
  id: "00000000-0000-4000-8000-0000000000c1",
  workspaceId,
  title: "Ship the window bar",
  initialMessage: "Ship the window bar",
  metadata: {},
  status: "idle",
  archived: false,
  pinned: false,
  parentSessionId: subchat ? "00000000-0000-4000-8000-0000000000c0" : null,
  model: "codex/gpt-5.6-sol",
  reasoningEffort: "medium",
  latencyMode: "standard",
  effectiveControl: {
    state: "active",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
  },
} as Session;

function Preview() {
  const rail = useRail();
  // The session page's real workspace dock, closed until asked: below 1024px
  // it is a full-window overlay that stays mounted (hidden) while closed.
  const [dockClosed, setDockClosed] = useState(true);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  useWindowBarRowLeft(canvasRef, chat && platform === "macos");
  return (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <TooltipProvider>
        {/* Clips like the app's frame and shell do. */}
        <main
          data-window-frame
          data-rail-collapsed={withRail && rail.collapsed ? "true" : undefined}
          className="flex h-dvh overflow-hidden bg-canvas text-fg"
        >
          {withRail ? (
            <nav
              data-shell-rail
              data-collapsed={rail.collapsed}
              style={{ width: rail.collapsed ? 56 : 288 }}
              className="h-full shrink-0 border-r border-border"
            >
              <RailBody />
            </nav>
          ) : null}
          <div
            ref={canvasRef}
            data-canvas
            data-window-bar-row={chat ? "" : undefined}
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            {chat ? (
              <SessionHeader
                session={session}
                ancestors={[]}
                lineageLoading={subchat}
                connectionState="live"
                status={session.status}
                keyAuthRequired={false}
                onForgetAccessKey={() => undefined}
                inspectorOpen={!dockClosed}
                onToggleInspector={() => setDockClosed((closed) => !closed)}
                onRename={async () => null}
                onPin={async () => null}
              />
            ) : null}
            <WorkspaceDock
              collapsed={dockClosed}
              onCollapsedChange={setDockClosed}
              tabs={[
                {
                  id: "files",
                  label: "Files",
                  content: (
                    <button type="button" onClick={() => setDockClosed(true)}>
                      Close workspace
                    </button>
                  ),
                },
              ]}
              primary={
                <section className="flex h-full flex-col items-center justify-center gap-3 text-sm text-fg-muted">
                  Real sidebar components · Sample workspace data
                  {chat ? null : (
                    <button type="button" onClick={() => setDockClosed(false)}>
                      Open workspace
                    </button>
                  )}
                </section>
              }
            />
          </div>
        </main>
      </TooltipProvider>
    </OpenGeniProvider>
  );
}
const root = createRootRoute({ component: Preview });
const preview = createRoute({
  getParentRoute: () => root,
  path: "/test/desktop-rail.html",
});
const router = createRouter({ routeTree: root.addChildren([preview]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
