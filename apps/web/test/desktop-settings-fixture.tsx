// The settings shell as the desktop app draws it: the production SettingsShell
// and workspace picker, with sample sections. `?platform=` picks the desktop
// platform (or `browser`), `?theme=light` the light theme.
import { createRoot } from "react-dom/client";
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
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import { WorkspaceSwitcherMenu } from "../src/components/rail/workspace-switcher";
import {
  SettingsShell,
  settingsHomeLink,
  type SettingsRailSection,
} from "../src/components/settings/settings-sidebar";
import { client, workspaceId } from "./desktop-rail-context";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const platform = params.get("platform") ?? "macos";
if (platform !== "browser") document.documentElement.dataset.desktop = platform;
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;

const item = (id: string, label: string, icon: LucideIcon) => ({
  id,
  label,
  icon,
  link: <Link to="/test/desktop-settings.html" />,
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

function Preview() {
  return (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <TooltipProvider>
        <main className="flex h-dvh bg-canvas text-fg">
          <SettingsShell
            label="Settings"
            back={{ label: "Back to sessions", link: <Link to="/test/desktop-settings.html" /> }}
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
const preview = createRoute({ getParentRoute: () => root, path: "/test/desktop-settings.html" });
const router = createRouter({ routeTree: root.addChildren([preview]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
