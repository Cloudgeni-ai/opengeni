import { useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ActivityRail,
  buildTimeline,
  DisclosureDefaultsProvider,
  groupTimeline,
  LightboxProvider,
  MessageTimeline,
  TimelineRow,
  TurnSummary,
  type ActivityItem,
  type TimelineGroup,
} from "../src/index";
import {
  authNeededEvents,
  cancelledTurnEvents,
  completedTurnEvents,
  failedTurnEvents,
  liveTurnEvents,
  memoryTurnEvents,
  tourEvents,
  workerCompletionEvents,
  workerGoalEvents,
} from "./timeline-fixtures";
import "./styles.css";

/* ----------------------------------------------------------------------------
   Timeline renderer harness

   Mounts the REAL @opengeni/react timeline against real-shaped SessionEvents
   (timeline-fixtures.ts) — the same buildTimeline projection and the same
   renderer components the live app uses. Every tool × state, plus turn-collapse,
   workers, goals, and a live streaming turn.

   Critically: there is NO forked markup here. User messages and goal pills draw
   through the real `TimelineRow`; activity clusters through the real
   `ActivityRail`. Wiring this into apps/web is a visual no-op.
   -------------------------------------------------------------------------- */

/** One overline/eyebrow recipe, used for every uppercase section label. */
const EYEBROW = "text-og-xs font-medium uppercase tracking-[0.1em] text-og-fg-subtle";

/** Demo-only stand-in for the app's catalog-asset logos (an inline data-URI so
    the harness needs no network). The real app resolves these via catalogAssetUrl. */
const DEMO_PROVIDER_LOGOS: Record<string, string> = {
  "linear.app":
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="#5e6ad2"/><g stroke="#fff" stroke-width="7" stroke-linecap="round"><line x1="24" y1="62" x2="62" y2="24"/><line x1="24" y1="44" x2="44" y2="24"/><line x1="38" y1="76" x2="76" y2="38"/></g></svg>`,
    ),
};

/**
 * A demo section. The `hint` is intentionally ONE short line (never a wrapping
 * paragraph) so the gallery reads as a sleek component showcase, not docs
 * crammed onto the timeline.
 */
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-t border-og-border/60 pt-7">
      <h2 className={EYEBROW}>{title}</h2>
      {hint ? <p className="mt-1.5 truncate text-og-sm text-og-fg-subtle">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/* ----------------------------------------------------------------------------
   Screenshot instrumentation (DEMO-ONLY, fully inert in the real app)

   Two opt-in URL params let a reviewer headlessly capture a deterministic frame:
     ?theme=light|dark  — seed the initial theme (same data-og-theme mechanism as
                          the Light/Dark toggle button).
     ?expand=all        — force every collapsible (rows + folded turns) open via
                          the real DisclosureDefaultsProvider context, and reveal
                          the renderer catalog so the whole matrix is on screen.

   These only seed initial state; the live components and animations are untouched.
   -------------------------------------------------------------------------- */
const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
const INITIAL_THEME: "dark" | "light" = params.get("theme") === "light" ? "light" : "dark";
const FORCE_EXPAND_ALL = params.get("expand") === "all";

function Harness() {
  const [theme, setTheme] = useState<"dark" | "light">(INITIAL_THEME);
  const [showCatalog, setShowCatalog] = useState(FORCE_EXPAND_ALL);

  const tree = (
    <div className="og-root min-h-full bg-og-bg" data-og-theme={theme === "light" ? "light" : undefined}>
      <div className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8">
        <header className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold text-og-fg">Timeline tool-call renderers</h1>
            <p className="mt-0.5 text-[12.5px] text-og-fg-subtle">
              @opengeni/react — real components, real SessionEvent shapes, one buildTimeline pipeline.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="shrink-0 rounded-og-sm border border-og-border px-2.5 py-1 text-xs font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:text-og-fg"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </header>

        <LightboxProvider>
          <div className="flex flex-col gap-9">
            {/* The kitchen-sink catalog is a reference matrix (every renderer ×
                every state at once) — NOT a real timeline. It is gated behind a
                toggle so the default view is the calm, representative gallery
                below, never the full wall of rows. */}
            <section className="border-t border-og-border/60 pt-7">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <h2 className={EYEBROW}>Renderer catalog — every tool × state</h2>
                  <p className="mt-1.5 text-og-sm text-og-fg-subtle">
                    A reference matrix, not a real run — it deliberately includes the failure states (a
                    rejected patch, an unparseable diff) so every fallback renders. Click a row to expand;
                    screenshots open in the lightbox.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCatalog((v) => !v)}
                  className="shrink-0 rounded-og-sm border border-og-border px-2.5 py-1 text-og-sm font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:text-og-fg"
                >
                  {showCatalog ? "Hide" : "Show all states"}
                </button>
              </div>
              {showCatalog ? (
                <div className="mt-4">
                  <RawRail events={tourEvents()} />
                </div>
              ) : null}
            </section>

            <Section
              title="Sub-agent workers & goal landmarks"
              hint="session_create / session_send_message → worker cards; goal_* → landmark pills."
            >
              <RawRail events={workerGoalEvents()} />
            </Section>

            <Section
              title="Worker completions — inbound results, not user bubbles"
              hint="A child's childCompletion payload → a quiet result card (completed / paused / failed) with the report behind a fold and a deep-link into the child."
            >
              <RawRail events={workerCompletionEvents()} />
            </Section>

            <Section
              title="Completed turn — folded to a summary chip"
              hint="Prompt bubble → one turn chip → final answer; expand for narration and nested tool clusters."
            >
              <MessageTimeline events={completedTurnEvents()} className="max-h-none" />
            </Section>

            <Section title="Failed turn — folds, but the error is never hidden" hint="Failed turns start open so the error and folded context stay visible.">
              <MessageTimeline events={failedTurnEvents()} className="max-h-none" />
            </Section>

            <Section
              title="Memory writes — a first-class step, saved & corrected"
              hint="memory.saved / memory.corrected fold into the chip summary ('… · 2 memories saved · 2 memories updated'); expanded, each is a calm neutral row (supersede = old → new, in-place = live text). With a host onMemoryClick, expanding reveals a 'View in memory' deep-link.">
              <MessageTimeline
                events={memoryTurnEvents()}
                onMemoryClick={(id) => window.alert(`Open memory ${id}`)}
                className="max-h-none"
              />
            </Section>

            <Section
              title="Reconnect — a lapsed connection, inline"
              hint="tool.auth_needed → a clean card: self-hosted logo (or monogram), one human line, a Reconnect button."
            >
              {/* In the app the logo URL comes from our own catalog assets; here
                  a fixture resolver serves one provider (logo) and lets the other
                  fall back to its monogram — both states in one shot. */}
              <MessageTimeline
                events={authNeededEvents()}
                onReconnect={() => new Promise(() => {})}
                resolveProviderLogo={(domain) => DEMO_PROVIDER_LOGOS[domain] ?? null}
                className="max-h-none"
              />
            </Section>

            <Section title="Interrupted turn — cancelled mid-run">
              <MessageTimeline events={cancelledTurnEvents()} className="max-h-none" />
            </Section>

            <Section
              title="Live turn — streaming in (never folds mid-run)"
              hint="Running rows render directly: shimmer + inline pulse, a skeleton thumb, a streaming caret."
            >
              <MessageTimeline events={liveTurnEvents()} status="running" className="max-h-none" />
            </Section>
          </div>
        </LightboxProvider>
      </div>
    </div>
  );

  // When ?expand=all is set, seed every collapsible open through the real
  // DisclosureDefaultsProvider context. Absent otherwise — zero app-side change.
  return FORCE_EXPAND_ALL ? <DisclosureDefaultsProvider defaultOpen>{tree}</DisclosureDefaultsProvider> : tree;
}

/**
 * Render a fixture run as the real timeline: activity clusters defer to
 * `ActivityRail`, every other item defers to the real `TimelineRow`. No forked
 * bubble or goal-pill markup — the demo and the live app draw identical rows.
 */
function RawRail({ events }: { events: ReturnType<typeof tourEvents> }) {
  const groups = useMemo(() => groupTimeline(buildTimeline(events)), [events]);
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <RawGroup key={rawGroupKey(group)} group={group} />
      ))}
    </div>
  );
}

function RawGroup({ group, insideTurn = false }: { group: TimelineGroup; insideTurn?: boolean }) {
  switch (group.kind) {
    case "activity":
      return group.outcome ? (
        <TurnSummary
          items={group.items}
          outcome={group.outcome}
          failureText={insideTurn ? undefined : group.failureText}
          defaultOpen={!insideTurn && group.outcome === "failed" ? true : undefined}
          bare={insideTurn}
        >
          <ActivityRail items={group.items} onOpenSession={(id) => window.alert(`Open session ${id}`)} bare={insideTurn} />
        </TurnSummary>
      ) : (
        <ActivityRail items={group.items} onOpenSession={(id) => window.alert(`Open session ${id}`)} bare={insideTurn} />
      );
    case "turn": {
      const body = group.groups.map((child) => <RawGroup key={rawGroupKey(child)} group={child} insideTurn />);
      return (
        <TurnSummary
          items={flattenActivities(group.groups)}
          outcome={group.outcome}
          failureText={group.failureText}
          durationMs={durationBetween(group.startedAt, group.endedAt)}
          defaultOpen={!insideTurn && group.outcome === "failed" ? true : undefined}
          bare={insideTurn}
        >
          {insideTurn ? (
            <div className="flex flex-col gap-4">{body}</div>
          ) : (
            <div className="flex flex-col gap-4 border-l-2 border-og-border pl-3 sm:pl-4">{body}</div>
          )}
        </TurnSummary>
      );
    }
    case "item":
      return <TimelineRow item={group.item} onOpenSession={(id) => window.alert(`Open session ${id}`)} />;
  }
}

function rawGroupKey(group: TimelineGroup): string {
  switch (group.kind) {
    case "activity":
      return group.id;
    case "turn":
      return group.id;
    case "item":
      return group.item.id;
  }
}

function flattenActivities(groups: TimelineGroup[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const group of groups) {
    if (group.kind === "activity") {
      items.push(...group.items);
    } else if (group.kind === "turn") {
      items.push(...flattenActivities(group.groups));
    }
  }
  return items;
}

function durationBetween(startedAt: string, endedAt: string): number | undefined {
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : undefined;
}

createRoot(document.getElementById("root")!).render(<Harness />);
