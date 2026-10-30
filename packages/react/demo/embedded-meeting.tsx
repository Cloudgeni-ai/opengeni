/* A meeting's page inside a plain host product, with fixture data: the real
   components, mounted with zero styling, so they follow the host page.

   The host scrolls its own content frame and pads it, as products do to keep
   room for something floating at the bottom (here an "Assistant" button):
   the meeting's sticky player and Ask bars must still meet the window's edges
   with the page's own background, with nothing scrolling past beyond them.
   `?theme=dark` puts the host in dark mode (`class="dark"` on <html> and a
   dark page). */
import { createRoot } from "react-dom/client";
import { MeetingDetailPage } from "@opengeni/react/meetings";
import { createMeetingsFixture } from "../src/testing/meetings-fixture";
import "@opengeni/react/compiled.css";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const palette =
  theme === "light"
    ? { page: "#ffffff", rail: "#f7f7f5", ink: "#1d1d1b", line: "#e7e7e4", pill: "#ffffff" }
    : { page: "#1a1a19", rail: "#202020", ink: "#ececec", line: "#2e2e2e", pill: "#262626" };
document.documentElement.classList.toggle("dark", theme === "dark");
document.body.style.background = palette.page;
document.body.style.color = palette.ink;

const fixture = createMeetingsFixture();

function Host() {
  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <nav
        style={{
          width: 220,
          flex: "none",
          background: palette.rail,
          borderRight: `1px solid ${palette.line}`,
          padding: 16,
          fontSize: 14,
        }}
      >
        Host product
      </nav>
      {/* The host's scroll frame: top padding, and bottom room for its floating button. */}
      <main
        data-host-scroll-frame=""
        style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "12px 32px 88px" }}
      >
        <div style={{ maxWidth: 840, margin: "0 auto", padding: "24px 0" }}>
          <MeetingDetailPage
            workspaceId={fixture.workspaceId}
            recordingId={fixture.readyId}
            viewerSubjectId={fixture.viewerSubjectId}
            recordings={fixture.client}
            onBack={() => {}}
            onAsk={() => {}}
          />
        </div>
      </main>
      <button
        type="button"
        style={{
          position: "fixed",
          left: "calc(50% + 110px)",
          bottom: 18,
          transform: "translateX(-50%)",
          zIndex: 40,
          border: `1px solid ${palette.line}`,
          borderRadius: 999,
          background: palette.pill,
          color: palette.ink,
          padding: "8px 16px",
          font: "inherit",
        }}
      >
        Assistant
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Host />);
