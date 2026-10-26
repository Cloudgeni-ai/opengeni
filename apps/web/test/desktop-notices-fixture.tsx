import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { PauseIcon } from "lucide-react";
import { Button } from "@opengeni/react/ui/button";
import { Notice } from "@opengeni/react/ui/notice";
import { mountApiUpdateNotice, showApiUpdateNotice } from "../src/api";
import { SignInCallbackNotice } from "../src/components/sign-in-callback-notice";
import { clearSignInChangeFeedback, retainSignInChangeFeedback } from "../src/lib/sign-in-feedback";
import "../src/styles.css";

// The app's top-level notices with the real notice code and app styles, in
// the console's layout: notices above every page, then the rail and the page
// canvas (marked as the session shell marks them). Only the platform, the
// collapsed state and the sample text are fixtures.
//   ?platform=macos|windows|browser  ?theme=dark|light  ?rail=open
//   ?update=0 (no update notice)  ?signin (a sign-in notice)  ?paused (a page banner)
const params = new URLSearchParams(location.search);
const platform = params.get("platform") ?? "macos";
if (platform !== "browser") document.documentElement.dataset.desktop = platform;
if (platform === "windows") {
  // Chromium has no native Windows overlay. Supply the same CSS
  // environment-derived values the Electron host exposes.
  document.documentElement.style.setProperty("--og-caption-buttons-width", "138px");
  document.documentElement.style.setProperty("--og-caption-row-height", "56px");
}
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;
const collapsed = params.get("rail") !== "open";
if (params.has("signin"))
  retainSignInChangeFeedback({
    userId: "user-1",
    email: "alex@example.com",
    message: "Google is now connected to your account.",
  });
else clearSignInChangeFeedback();

function Preview() {
  useEffect(() => {
    if (params.get("update") !== "0") showApiUpdateNotice(false);
  }, []);
  return (
    <main className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-bg text-fg">
      <div ref={mountApiUpdateNotice} className="shrink-0" />
      {params.has("signin") ? <SignInCallbackNotice userId="user-1" /> : null}
      <div
        className="flex min-h-0 flex-1 overflow-hidden"
        data-rail-collapsed={collapsed ? "true" : undefined}
      >
        <nav
          aria-label="Primary"
          data-collapsed={collapsed}
          style={{ width: collapsed ? 56 : 240 }}
          className="shrink-0 border-r border-border bg-surface"
        />
        <div data-canvas className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {params.has("paused") ? (
            <Notice
              layout="banner"
              tone="muted"
              icon={<PauseIcon className="size-4" />}
              className="shrink-0 bg-surface"
              action={
                <Button type="button" size="sm">
                  Resume
                </Button>
              }
            >
              Agent work is paused in Product engineering.
            </Notice>
          ) : null}
          <section className="flex flex-1 items-center justify-center text-sm text-fg-muted">
            Real notices and app styles · Sample page
          </section>
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
