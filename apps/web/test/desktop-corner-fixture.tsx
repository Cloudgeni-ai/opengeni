// The top-left corner of desktop layouts as the app draws them. By default the
// production SettingsShell and workspace picker, with sample sections;
// `?view=content` a content page (ContentPage and PageHeader) beside the real
// rail, inside a canvas wired to the window bar as SessionShell wires it.
// `?platform=` picks the desktop platform (or `browser`), `?theme=light` the
// light theme; `?bar=` and `?zoom=` are the macOS shell's report (see the html).
import { createRoot } from "react-dom/client";
import { useRef } from "react";
import { OpenGeniProvider } from "@opengeni/react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  RouterProvider,
} from "@tanstack/react-router";
import {
  ActivityIcon,
  BotIcon,
  BoxIcon,
  CableIcon,
  CpuIcon,
  FileKey2Icon,
  KeyRoundIcon,
  MonitorIcon,
  PlugIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UserIcon,
  UsersIcon,
  WebhookIcon,
  type LucideIcon,
} from "lucide-react";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import {
  useWindowBarRow,
  WindowBarPageTitle,
  windowBarRowActive,
} from "@opengeni/react/app/components/window-bar";
import { applyDesktopWindowBar, desktopBridge } from "@opengeni/react/app/lib/desktop";
import { RailBody } from "../src/components/rail/rail-shell";
import { WorkspaceSwitcherMenu } from "../src/components/rail/workspace-switcher";
import {
  SettingsShell,
  settingsHomeLink,
  type SettingsRailSection,
} from "../src/components/settings/settings-sidebar";
import { client, useRail, workspaceId } from "./desktop-rail-context";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const platform = params.get("platform") ?? "macos";
if (platform !== "browser") document.documentElement.dataset.desktop = platform;
applyDesktopWindowBar(document.documentElement, desktopBridge);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;

const item = (id: string, label: string, icon: LucideIcon) => ({
  id,
  label,
  icon,
  link: <Link to="/test/desktop-corner.html" />,
});

const sections: SettingsRailSection[] = [
  {
    id: "workspace",
    label: "Workspace",
    groups: [
      {
        items: [
          item("general", "General", SlidersHorizontalIcon),
          item("models", "Models", SparklesIcon),
          item("agents", "Agents", BotIcon),
          item("integrations", "Integrations", PlugIcon),
        ],
      },
      {
        items: [
          item("secrets", "Secrets", FileKey2Icon),
          item("sandboxes", "Sandbox environments", BoxIcon),
          item("machines", "Machines", MonitorIcon),
          item("computer", "Computer use", CpuIcon),
        ],
      },
      {
        items: [
          item("access", "Access", UsersIcon),
          item("api-keys", "API keys", KeyRoundIcon),
          item("developer", "Developer", WebhookIcon),
          item("insights", "Insights", ActivityIcon),
        ],
      },
    ],
  },
  {
    id: "organization",
    label: "Organization",
    meta: "Cloudgeni",
    groups: [
      {
        items: [
          item("org-identity", "Identity", ShieldIcon),
          item("org-members", "Members", UsersIcon),
          item("org-connections", "Connections", CableIcon),
        ],
      },
    ],
  },
  {
    id: "account",
    label: "Your account",
    groups: [{ items: [item("account", "Profile", UserIcon)] }],
  },
];

function ContentPreview() {
  const rail = useRail();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const titleInWindowBar = windowBarRowActive({ platform, mobile: rail.isMobile });
  const windowBarRow = useWindowBarRow(canvasRef, titleInWindowBar);
  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 overflow-hidden"
      data-rail-collapsed={rail.collapsed ? "true" : undefined}
    >
      <nav
        data-shell-rail
        data-collapsed={rail.collapsed}
        style={{ width: rail.collapsed ? 56 : 288 }}
        className="h-full shrink-0 border-r border-border"
      >
        <RailBody />
      </nav>
      <div
        ref={canvasRef}
        data-canvas
        {...windowBarRow}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        <WindowBarPageTitle enabled={titleInWindowBar}>
          <ContentPage width="standard" className="pt-6">
            <PageHeader
              title="Automations"
              description="Scheduled and triggered work for this workspace."
            />
            {Array.from({ length: 30 }, (_, index) => (
              <p key={index} className="mt-4 text-sm text-fg-muted">
                Automation {index + 1} · Real content page components · Sample workspace data
              </p>
            ))}
          </ContentPage>
        </WindowBarPageTitle>
      </div>
    </div>
  );
}

function Preview() {
  if (params.get("view") === "content")
    return (
      <OpenGeniProvider client={client} workspaceId={workspaceId}>
        <TooltipProvider>
          <main data-window-frame className="flex h-dvh bg-canvas text-fg">
            <ContentPreview />
          </main>
        </TooltipProvider>
      </OpenGeniProvider>
    );
  return (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <TooltipProvider>
        <main data-window-frame className="flex h-dvh bg-canvas text-fg">
          <SettingsShell
            label="Settings"
            back={{ label: "Back to sessions", link: <Link to="/test/desktop-corner.html" /> }}
            home={settingsHomeLink(workspaceId)}
            scope={
              <WorkspaceSwitcherMenu
                workspaceId={workspaceId}
                collapsed={false}
                align="start"
                onSelect={() => {}}
                className="w-full"
              />
            }
            sections={sections}
            activeId="general"
            currentPage="General"
            page={{ title: "General", description: "Name and defaults for this workspace." }}
          >
            <p className="text-sm text-fg-muted">
              Real settings components · Sample workspace data
            </p>
          </SettingsShell>
        </main>
      </TooltipProvider>
    </OpenGeniProvider>
  );
}

const root = createRootRoute({ component: Preview });
const preview = createRoute({ getParentRoute: () => root, path: "/test/desktop-corner.html" });
const router = createRouter({ routeTree: root.addChildren([preview]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
