import { useState } from "react";
import { createRoot } from "react-dom/client";

import { RowQuickActions } from "../src/components/rail/session-list";
import {
  SessionRowContent,
  SessionRowHoverDetails,
} from "../src/components/rail/session-row-content";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../src/components/ui/hover-card";
import { cn } from "../src/lib/utils";
import type { Session } from "../src/types";
import "../src/styles.css";

const neutral = { kind: "neutral", count: 1, total: 1, label: "Idle" } as const;
const active = { kind: "active", count: 1, total: 1, label: "Running" } as const;
const longTitle =
  "Now I am testing your workspace rail and this title should use every available pixel";

const cases = [
  { id: "time-only", active: false, depth: 0, summary: neutral, relativeTime: "1h" },
  { id: "status-time", active: false, depth: 0, summary: active, relativeTime: "2m" },
  {
    id: "schedule-date",
    active: false,
    depth: 0,
    summary: neutral,
    scheduled: true,
    relativeTime: "1 Aug",
  },
  { id: "no-metadata", active: false, depth: 0, summary: neutral },
  { id: "selected-child", active: true, depth: 1, summary: neutral, relativeTime: "1h" },
  { id: "unselected-child", active: false, depth: 2, summary: active, relativeTime: "now" },
] as const;

function SessionRailRowMetadataFixture() {
  const [quickActionSession, setQuickActionSession] = useState({
    id: "quick-actions",
    archived: false,
    parentSessionId: null,
    pinned: false,
  } as Session);

  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <aside
        data-testid="production-session-rail"
        className="w-[244px] min-w-0 overflow-x-hidden border border-border bg-surface/40 py-3"
      >
        <div className="min-w-0 overflow-x-hidden pb-2 pl-2 pr-3">
          {cases.map((scenario) => (
            <div
              key={scenario.id}
              data-row-case={scenario.id}
              className={cn(
                "group relative flex h-8 w-full items-center gap-1.5 rounded-md py-1 pl-1.5 pr-1 text-left text-sm",
                scenario.active ? "bg-surface-3 font-medium text-fg" : "text-fg-muted",
              )}
            >
              <span
                aria-hidden="true"
                className="flex w-4 shrink-0 items-center"
                style={scenario.depth > 0 ? { marginLeft: scenario.depth * 12 } : undefined}
              />
              <HoverCard openDelay={100} closeDelay={80}>
                <HoverCardTrigger asChild>
                  <a
                    href={`#${scenario.id}`}
                    aria-current={scenario.active ? "page" : undefined}
                    aria-label={`Open ${longTitle}. Idle`}
                    className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-sm text-left outline-none"
                  >
                    <SessionRowContent
                      title={longTitle}
                      stateLabel="Idle"
                      depthLabel={scenario.depth > 0 ? `Level ${scenario.depth + 1}` : null}
                      descendantLabel={null}
                      mobile={false}
                      summary={scenario.summary}
                      scheduled={"scheduled" in scenario ? scenario.scheduled : false}
                      relativeTime={"relativeTime" in scenario ? scenario.relativeTime : undefined}
                      creator={{
                        kind: "subject",
                        subjectId: "user:bendik",
                        label: "Bendik Nyheim",
                      }}
                    />
                  </a>
                </HoverCardTrigger>
                <HoverCardContent side="right" collisionPadding={8}>
                  <SessionRowHoverDetails
                    title={longTitle}
                    createdAt={new Date(Date.now() - 13 * 3_600_000).toISOString()}
                    createdBy={{
                      kind: "subject",
                      subjectId: "user:bendik",
                      label: "Bendik Nyheim",
                    }}
                    descendantCount={3}
                    descendantCountTruncated={false}
                  />
                </HoverCardContent>
              </HoverCard>
              {scenario.id === "time-only" ? (
                <RowQuickActions
                  session={quickActionSession}
                  onPin={async (session, pinned) => {
                    const updated = { ...session, pinned };
                    setQuickActionSession(updated);
                    return updated;
                  }}
                  onArchive={async (session, archived) => {
                    setQuickActionSession({ ...session, archived });
                  }}
                />
              ) : null}
            </div>
          ))}
        </div>
      </aside>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<SessionRailRowMetadataFixture />);
