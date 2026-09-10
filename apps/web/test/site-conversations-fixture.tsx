import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SiteSessionGroupHeading } from "../src/components/rail/site-session-group-heading";
import { SiteOriginLink } from "../src/components/session/site-origin-link";
import { SiteConversationsPanel } from "../src/components/artifacts/site-conversations";
import type { Session } from "../src/types";
import "../src/styles.css";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const origin = { siteId, title: "Product analytics" };
const sessions = [
  "Review conversion trends",
  "Explain last week’s activity",
  "Investigate onboarding drop-off",
].map(
  (title, i) =>
    ({
      id: `33333333-3333-4333-8333-33333333333${i}`,
      workspaceId,
      title,
      status: i === 0 ? "running" : "idle",
      metadata: { _opengeniSiteOrigin: origin },
      effectiveControl: { state: "active" },
    }) as Session,
);

function Fixture() {
  const [expanded, setExpanded] = useState(false);
  return (
    <main className="flex min-h-screen bg-background text-fg">
      <aside className="w-72 shrink-0 border-r border-border p-3">
        <h2 className="px-2 py-4 text-xs text-fg-muted">Recent activity</h2>
        <SiteSessionGroupHeading
          origin={origin}
          workspaceId={workspaceId}
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
          summary={{ kind: "active", count: 1, total: 3, label: "1 working" }}
        />
        {expanded && <p className="px-9 py-2 text-xs text-fg-muted">Conversations expand here</p>}
        <h2 className="px-2 pb-2 pt-8 text-xs text-fg-muted">Growth project</h2>
        <div className="flex items-center gap-1 rounded-md bg-surface-2 px-2 py-2 text-sm">
          <SiteOriginLink session={sessions[0]!} compact />
          <span className="truncate">Review conversion trends</span>
        </div>
      </aside>
      <section className="min-w-0 flex-1">
        <header className="flex items-center justify-between gap-4 border-b border-border p-4">
          <h1 className="truncate text-sm font-medium">Review conversion trends</h1>
          <SiteOriginLink session={sessions[0]!} />
        </header>
        <div className="p-8">
          <h2 className="mb-4 text-lg font-semibold">Product analytics</h2>
          <SiteConversationsPanel
            workspaceId={workspaceId}
            siteId={siteId}
            title={origin.title}
            client={{
              listSessionPage: async (_workspace, options = {}) => {
                if (options.originSiteId !== siteId) throw new Error("Missing Site filter");
                const matches = sessions.filter((s) =>
                  s.title!.toLowerCase().includes(options.search?.toLowerCase() ?? ""),
                );
                return {
                  pinned: [],
                  sessions: options.archivedOnly
                    ? []
                    : options.cursor
                      ? matches.slice(2)
                      : matches.slice(0, 2),
                  nextCursor:
                    !options.archivedOnly && !options.cursor && matches.length > 2 ? "older" : null,
                  filtersApplied: true,
                  originSiteId: siteId,
                };
              },
            }}
          />
        </div>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
