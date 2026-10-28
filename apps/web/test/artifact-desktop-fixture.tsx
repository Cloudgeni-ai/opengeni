import { createRoot } from "react-dom/client";
import { ArtifactSandbox } from "../../../packages/react/src/components/artifacts/artifact-sandbox";
import { installDesktopShell } from "../../../packages/react/src/app/lib/desktop";
import { openBlankTab } from "../../../packages/react/src/app/lib/navigation";
import { DesktopAppSubmenu } from "../src/components/desktop-app-menu";
import "../src/styles.css";

// Real viewer and app styles; only the Site content and native platform are
// fixtures. Browser assertions supply the shell's data-desktop attribute, or
// the desktop app's user agent for the app's own marking (as App.tsx does).
installDesktopShell(() => undefined);
// For assertions: the app's own blank-tab opener, and whether the account
// menu offers the desktop app download on this page.
Object.assign(window, {
  opengeniFixture: {
    openBlankTab,
    offersDesktopDownload: () => DesktopAppSubmenu() !== null,
  },
});
createRoot(document.getElementById("root")!).render(
  <main className="h-dvh bg-bg p-8 text-fg">
    <ArtifactSandbox
      title="Kitchen intelligence — artifact preview"
      versionLabel="v2"
      theme="dark"
      html={
        '<!doctype html><html><body style="margin:0;padding:32px;background:#13251d;color:#eff5ed;font:16px system-ui"><h1>Kitchen intelligence</h1><p>Sample Site content · desktop navigation preview</p><button onclick="this.textContent = \'Site state preserved\'">Try the Site</button></body></html>'
      }
    />
  </main>,
);
