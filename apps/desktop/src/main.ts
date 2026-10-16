import { join } from "node:path";

import { createDesktopApp } from "@opengeni/desktop";

const here = import.meta.dirname;

createDesktopApp({
  productName: "Opengeni",
  appId: "ai.opengeni.desktop",
  scheme: "opengeni",
  defaultServerUrl: "https://app.opengeni.ai",
  preloadPath: join(here, "preload.cjs"),
  welcomePreloadPath: join(here, "welcome-preload.cjs"),
  welcomePagePath: join(here, "pages", "welcome.html"),
  trayIconPath: join(
    here,
    "assets",
    process.platform === "darwin" ? "trayTemplate.png" : "tray.png",
  ),
  appIconPath: join(here, "assets", "icon.png"),
  background: { light: "#ffffff", dark: "#202020" },
  thisComputer: true,
  // The second line of agent/install/opengeni-agent-minisign.pub.
  agentSigningKey: "RWSaqgF1EVFuci7hXvDJO7cBh2xf2k0XKhCpvl23aWKG+nMAGfZ6D2Pn",
  updates: { githubRepository: "Cloudgeni-ai/opengeni", tagPrefix: "desktop-v" },
});
