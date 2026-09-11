import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageTimeline } from "../src/components/message-timeline";
import { buildTimeline } from "../src/timeline/projection";
import { StartupTimings } from "../src/timeline/startup-timings";
import { setStartupDetails, useStartupDetails } from "../src/timeline/startup-preference";
import type { SessionEvent } from "@opengeni/sdk";
import "./styles.css";

type Scenario = "Unhurried" | "Quick" | "Long wait" | "Failure";
const BUTTON =
  "rounded-lg border border-og-border px-3 py-2 text-og-sm text-og-fg-muted transition hover:bg-og-surface-2 focus-visible:outline-2 focus-visible:outline-og-accent";
function App() {
  const [scenario, setScenario] = useState<Scenario>("Unhurried");
  const [run, setRun] = useState(0);
  const [dark, setDark] = useState(true);
  const [inspect, setInspect] = useState(false);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const debug = useStartupDetails();
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    const history: SessionEvent[] = [];
    const timers: number[] = [];
    const emit = (type: string, payload: unknown) => {
      history.push({
        id: `demo-${run}-${history.length}`,
        sequence: history.length + 1,
        workspaceId: "demo",
        sessionId: "genie",
        turnId: "wish",
        type,
        payload,
        occurredAt: new Date().toISOString(),
      });
      setEvents([...history]);
    };
    const schedule = (ms: number, type: string, payload: unknown) =>
      timers.push(window.setTimeout(() => emit(type, payload), ms));
    emit("user.message", { text: "Help me turn this idea into something wonderful." });
    emit("turn.queued", { turnId: "wish", triggerEventId: `demo-${run}-0` });
    const duration = scenario === "Quick" ? 2000 : scenario === "Long wait" ? 60000 : 16000;
    schedule(300, "turn.started", { triggerEventId: `demo-${run}-0` });
    schedule(350, "turn.startup.phase.started", { phase: "model_preparation" });
    schedule(400, "sandbox.operation.started", { name: "sandbox.provision" });
    if (scenario === "Failure") {
      schedule(6000, "sandbox.operation.failed", {
        name: "sandbox.provision",
        error: "Could not start your workspace. Try again.",
      });
      schedule(6050, "turn.failed", { error: "Could not start your workspace. Try again." });
    } else {
      schedule(duration * 0.4, "sandbox.operation.completed", {
        name: "sandbox.provision",
        origin: "restored",
        durationMs: duration * 0.4 - 400,
      });
      schedule(duration * 0.4 + 10, "turn.startup.phase.started", { phase: "tools" });
      schedule(duration * 0.7, "turn.startup.phase.completed", {
        phase: "tools",
        durationMs: duration * 0.3,
      });
      schedule(duration * 0.75, "turn.startup.phase.completed", {
        phase: "model_preparation",
        durationMs: duration * 0.75 - 350,
      });
      schedule(duration * 0.75 + 10, "agent.model.request", { phase: "started" });
      schedule(duration, "agent.model.request", {
        phase: "first_byte",
        durationMs: duration * 0.25,
      });
      schedule(duration + 50, "agent.message.completed", {
        text: "Every good idea starts with a little possibility. Let's make yours real.",
        messageId: "answer",
      });
      schedule(duration + 100, "turn.completed", {});
    }
    return () => timers.forEach(window.clearTimeout);
  }, [scenario, run]);
  const phases = useMemo(
    () => buildTimeline(events).filter((item) => item.kind === "startup-phase"),
    [events],
  );
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-8 sm:px-12">
      <header className="flex items-center justify-between border-b border-og-border pb-6">
        <div className="text-og-sm font-medium tracking-wide">
          ✦ OpenGeni <span className="ml-2 font-normal text-og-fg-subtle">/ Loading studio</span>
        </div>
        <button className={BUTTON} onClick={() => setDark(!dark)}>
          {dark ? "Light mode" : "Dark mode"}
        </button>
      </header>
      <main className="py-12 sm:py-20">
        <p className="text-og-xs uppercase tracking-[.2em] text-og-fg-subtle">
          A moment of possibility
        </p>
        <h1 className="mt-4 text-4xl font-medium tracking-tight sm:text-5xl">
          Good things take a little magic.
        </h1>
        <p className="mt-5 max-w-lg text-og-base leading-7 text-og-fg-muted">
          A quieter beginning. A little personality. Then, straight to your work.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-2" aria-label="Loading scenarios">
          {(["Unhurried", "Quick", "Long wait", "Failure"] as Scenario[]).map((value) => (
            <button
              key={value}
              className={BUTTON}
              aria-pressed={scenario === value}
              style={scenario === value ? { background: "var(--og-color-surface-2)" } : undefined}
              onClick={() => {
                setScenario(value);
                setRun((v) => v + 1);
              }}
            >
              {value}
            </button>
          ))}
          <button className={BUTTON} onClick={() => setRun((v) => v + 1)}>
            Replay ↻
          </button>
        </div>
        <section
          aria-label="Live conversation preview"
          className="mt-8 min-h-64 rounded-2xl border border-og-border bg-og-surface-1/30 p-5 sm:p-8"
        >
          <MessageTimeline key={`${run}-${scenario}`} events={events} />
        </section>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-og-xs text-og-fg-subtle">Live components · Simulated startup events</p>
          <button className={BUTTON} onClick={() => setInspect(!inspect)} aria-expanded={inspect}>
            {inspect ? "Close diagnostics" : "Open diagnostics"}
          </button>
        </div>
        {inspect ? (
          <section className="mt-6 rounded-xl border border-og-border p-5">
            <label className="mb-5 flex cursor-pointer items-center gap-3 text-og-sm">
              <input
                type="checkbox"
                checked={debug}
                onChange={(event) => setStartupDetails(event.target.checked)}
              />
              Show startup details in chat
            </label>
            <StartupTimings phases={phases} />
          </section>
        ) : null}
      </main>
      <footer className="mt-auto border-t border-og-border pt-5 text-og-xs text-og-fg-subtle">
        Less machinery. More imagination.
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
