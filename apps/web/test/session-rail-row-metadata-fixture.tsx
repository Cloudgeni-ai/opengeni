import { SessionChrome, type UseTurnQueueResult } from "@opengeni/react";
import { SessionBrowseOrderControls } from "@opengeni/react/app/components/rail/session-browse-order-controls";
import type {
  SessionBrowseGroupBy,
  SessionBrowseSortBy,
} from "@opengeni/react/app/lib/sessions-group";
import type { SessionBrowseStatus } from "@opengeni/react/app/lib/session-browse-preferences";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@opengeni/react/ui/dropdown-menu";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { SessionHeader } from "@opengeni/react/app/components/rail/session-header";
import { sessionInputWait, sessionStateLabel } from "@opengeni/react/app/lib/session-rail";
import { RowQuickActions } from "@opengeni/react/app/components/rail/session-list";
import { SessionRowContent } from "@opengeni/react/app/components/rail/session-row-content";
import { SessionRowHoverDetails } from "@opengeni/react/app/components/rail/session-row-hover-details";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@opengeni/react/ui/hover-card";
import { cn } from "@opengeni/react/app/lib/utils";
import type { Session } from "@opengeni/react/app/types";
import "../src/styles.css";

const neutral = { kind: "neutral", count: 1, total: 1, label: "Idle" } as const;
const emptyQueue = {
  queue: [],
  pendingInputs: [],
  mutationFor: () => null,
} as unknown as UseTurnQueueResult;

// The header and rows only render inside the app shell, which always provides
// the app context; their chat actions (copy link, pin) run through it. The
// fixture supplies the read-only workspace grant used to label archive actions.
// All unexpected context reads and action calls still fail loudly.
const appContext = new Proxy({} as AppContextValue, {
  get(_target, key) {
    if (key === "accessContext") {
      return {
        subjectId: "rail-preview-user",
        workspaceGrants: [
          {
            accountId: "rail-preview-organization",
            workspaceId: "workspace",
            subjectId: "rail-preview-user",
            permissionMode: "explicit",
            permissions: ["sessions:control"],
          },
        ],
        accountGrants: [],
      } satisfies AppContextValue["accessContext"];
    }
    throw new Error(`The session rail fixture's app context has no ${String(key)}`);
  },
});
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
    automationWait: "schedule" as const,
    relativeTime: "12 Aug",
  },
  {
    id: "event-wait",
    active: false,
    depth: 0,
    summary: neutral,
    automationWait: "event" as const,
    relativeTime: "3h",
  },
  { id: "no-metadata", active: false, depth: 0, summary: neutral },
  { id: "selected-child", active: true, depth: 1, summary: neutral, relativeTime: "1h" },
  { id: "unselected-child", active: false, depth: 2, summary: active, relativeTime: "now" },
  { id: "overflow", active: false, depth: 0, summary: neutral },
] as const;

function SessionRailRowMetadataFixture() {
  const [groupBy, setGroupBy] = useState<SessionBrowseGroupBy>("activity");
  const [sortBy, setSortBy] = useState<SessionBrowseSortBy>("updatedAt");
  const [status, setStatus] = useState<SessionBrowseStatus>("active");
  const [showEmptyGroups, setShowEmptyGroups] = useState(false);
  const [waitSession, setWaitSession] = useState({
    id: "waiting",
    workspaceId: "workspace",
    title: "Ship the typography PR",
    initialMessage: "Ship the typography PR",
    metadata: {},
    status: "idle",
    model: "codex/gpt-5.6-sol",
    reasoningEffort: "medium",
    latencyMode: "standard",
    effectiveControl: {
      state: "active",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
    },
    inputWait: {
      deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      reason: "Waiting for CI",
    },
  } as Session);
  const [quickActionSession, setQuickActionSession] = useState({
    id: "quick-actions",
    workspaceId: "workspace",
    archived: false,
    parentSessionId: null,
    pinned: false,
  } as Session);

  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <DropdownMenu>
        <DropdownMenuTrigger>Session view</DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <SessionBrowseOrderControls
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            sortBy={sortBy}
            onSortByChange={setSortBy}
            status={status}
            onStatusChange={setStatus}
            mineOnly={false}
            onMineOnlyChange={() => {}}
            showEmptyGroups={showEmptyGroups}
            onShowEmptyGroupsChange={setShowEmptyGroups}
          />
        </DropdownMenuContent>
      </DropdownMenu>
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
                      quickActionSlots={Number(!quickActionSession.archived) + 1}
                      title={longTitle}
                      stateLabel="Idle"
                      depthLabel={scenario.depth > 0 ? `Level ${scenario.depth + 1}` : null}
                      descendantLabel={null}
                      mobile={false}
                      summary={scenario.summary}
                      automationWait={"automationWait" in scenario ? scenario.automationWait : null}
                      relativeTime={"relativeTime" in scenario ? scenario.relativeTime : undefined}
                      creator={
                        scenario.depth > 0
                          ? null
                          : {
                              kind: "subject",
                              subjectId: "user:example-owner",
                              label: "Example Owner",
                            }
                      }
                    />
                  </a>
                </HoverCardTrigger>
                <HoverCardContent side="right" collisionPadding={8}>
                  <SessionRowHoverDetails
                    title={
                      scenario.id === "overflow"
                        ? "Long_unbroken_session_title_".repeat(8)
                        : longTitle
                    }
                    session={{
                      ...waitSession,
                      id: `hover-${scenario.id}`,
                      inputWait: null,
                      createdAt: new Date(Date.now() - 13 * 3_600_000).toISOString(),
                      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
                      createdBy: {
                        kind: "subject",
                        subjectId: "user:example-owner",
                        label:
                          scenario.id === "overflow"
                            ? "opengeni-workbench-acceptance-".repeat(6)
                            : "Example Owner",
                      },
                    }}
                    descendantCount={3}
                    descendantCountTruncated={false}
                  />
                </HoverCardContent>
              </HoverCard>
              <RowQuickActions
                session={{
                  ...quickActionSession,
                  parentSessionId: scenario.depth > 0 ? "parent" : null,
                }}
                onPin={async (session, pinned) => {
                  const updated = { ...session, pinned };
                  setQuickActionSession(updated);
                  return updated;
                }}
                onArchive={async (session, archived) => {
                  setQuickActionSession({ ...session, archived });
                }}
              />
            </div>
          ))}
        </div>
      </aside>
      <section data-testid="wait-preview" className="mt-8 border border-border">
        <SessionHeader
          session={waitSession}
          ancestors={[]}
          connectionState="live"
          status={waitSession.status}
          keyAuthRequired={false}
          onForgetAccessKey={() => undefined}
          inspectorOpen={false}
          onToggleInspector={() => undefined}
          onRename={async () => null}
          onPin={async () => null}
        />
        {/* The wait chip in the status row above the composer, as in the session route. */}
        <SessionChrome
          queue={emptyQueue}
          sessionStatus={waitSession.status}
          wait={sessionInputWait(waitSession)}
        />
        <div data-testid="waiting-row" className="flex h-8 w-[244px] items-center px-3">
          <SessionRowContent
            title={waitSession.title!}
            stateLabel={sessionStateLabel(waitSession)}
            mobile={false}
            depthLabel={null}
            descendantLabel={null}
            summary={waitSession.inputWait ? active : neutral}
            automationWait={null}
          />
        </div>
        <div className="flex flex-wrap gap-3 p-4">
          <button
            onClick={() =>
              setWaitSession({
                ...waitSession,
                inputWait: {
                  deadlineAt: new Date(Date.now() - 60_000).toISOString(),
                  reason: "Waiting for CI",
                },
              })
            }
          >
            Recheck due
          </button>
          <button
            onClick={() => setWaitSession({ ...waitSession, inputWait: null, status: "idle" })}
          >
            Complete work
          </button>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppContext.Provider value={appContext}>
    <SessionRailRowMetadataFixture />
  </AppContext.Provider>,
);
