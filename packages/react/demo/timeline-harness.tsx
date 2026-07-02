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
} from "../src/index";
import {
  cancelledTurnEvents,
  completedTurnEvents,
  failedTurnEvents,
  liveTurnEvents,
  tourEvents,
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
              title="Completed turn — folded to a summary chip"
              hint="A settled turn folds behind one quiet chip. Click to expand."
            >
              <MessageTimeline events={completedTurnEvents()} className="max-h-none" />
            </Section>

            <Section title="Failed turn — folds, but the error is never hidden">
              <MessageTimeline events={failedTurnEvents()} className="max-h-none" />
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
      {groups.map((group) =>
        group.kind === "activity" ? (
          <ActivityRail key={group.id} items={group.items} onOpenSession={(id) => window.alert(`Open session ${id}`)} />
        ) : (
          <TimelineRow key={group.item.id} item={group.item} />
        ),
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
