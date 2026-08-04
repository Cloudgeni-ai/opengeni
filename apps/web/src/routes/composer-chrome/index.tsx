// DEV-only session chrome harness for the production SessionChrome dock.
// Open: http://127.0.0.1:3000/dev/composer-chrome
// Mobile phone stage is the default — tweak SessionChrome and refresh this page.
import { useMemo, useState } from "react";

import { idleComposer, type ChromeScenarioId } from "@/dev/composer-chrome-fixtures";

import { PhoneFrame } from "./phone-frame";
import { ScenarioFilter, useGalleryScenarios } from "./scenario-matrix";
import { ScenarioStack } from "./scenario-stack";

type ViewMode = "phone" | "gallery";

export function ComposerChromeGalleryRoute() {
  const composer = useMemo(() => idleComposer(), []);
  const scenarios = useGalleryScenarios();
  const [mode, setMode] = useState<ViewMode>("phone");
  const [phoneScenarioId, setPhoneScenarioId] = useState<ChromeScenarioId>("crowded-mobile");
  const [galleryFilter, setGalleryFilter] = useState<"all" | ChromeScenarioId>("all");

  const phoneScenario = scenarios.find((row) => row.id === phoneScenarioId) ?? scenarios[0] ?? null;
  const galleryVisible =
    galleryFilter === "all" ? scenarios : scenarios.filter((row) => row.id === galleryFilter);

  return (
    <main className="min-h-dvh overflow-y-auto bg-bg text-fg">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
        <header className="space-y-3">
          <p className="text-2xs font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Dev harness · session chrome
          </p>
          <h1 className="text-xl font-semibold tracking-tight">Session chrome</h1>
          <p className="max-w-2xl text-sm leading-relaxed text-fg-muted">
            Interactive gallery of the production{" "}
            <code className="font-mono text-xs text-fg">SessionChrome</code> dock (the bar above the
            composer). Edits to that component show up here immediately — same code as the live
            session route.
          </p>
          <code className="block rounded-lg border border-border bg-surface-2/60 px-3 py-2 font-mono text-xs text-fg-muted">
            http://127.0.0.1:3000/dev/composer-chrome
          </code>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
              <button
                type="button"
                className={
                  mode === "phone"
                    ? "rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-bg"
                    : "rounded-md px-3 py-1.5 text-xs font-medium text-fg-muted hover:text-fg"
                }
                onClick={() => setMode("phone")}
              >
                iPhone 12 Pro
              </button>
              <button
                type="button"
                className={
                  mode === "gallery"
                    ? "rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-bg"
                    : "rounded-md px-3 py-1.5 text-xs font-medium text-fg-muted hover:text-fg"
                }
                onClick={() => setMode("gallery")}
              >
                All scenarios
              </button>
            </div>
            {mode === "gallery" ? (
              <ScenarioFilter
                scenarios={scenarios}
                filter={galleryFilter}
                onChange={setGalleryFilter}
              />
            ) : null}
          </div>
        </header>

        {mode === "phone" && phoneScenario ? (
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-8">
            <aside className="w-full shrink-0 space-y-2 lg:w-64">
              <p className="text-2xs font-medium uppercase tracking-[0.12em] text-fg-subtle">
                States
              </p>
              <ul className="flex max-h-[min(70dvh,40rem)] flex-col gap-1 overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface/40 p-1.5">
                {scenarios.map((scenario) => {
                  const selected = scenario.id === phoneScenario.id;
                  return (
                    <li key={scenario.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        className={
                          selected
                            ? "w-full rounded-lg bg-fg px-3 py-2 text-left text-xs font-medium text-bg"
                            : "w-full rounded-lg px-3 py-2 text-left text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
                        }
                        onClick={() => setPhoneScenarioId(scenario.id)}
                      >
                        <span className="block">{scenario.title}</span>
                        <span
                          className={
                            selected
                              ? "mt-0.5 block text-2xs font-normal text-bg/70"
                              : "mt-0.5 block text-2xs text-fg-subtle"
                          }
                        >
                          {scenario.id}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="rounded-lg border border-border bg-surface-2/40 px-3 py-2 text-xs text-fg-muted">
                <p className="font-medium text-fg">{phoneScenario.title}</p>
                <p className="mt-1 leading-relaxed">{phoneScenario.description}</p>
                <p className="mt-2 text-2xs text-fg-subtle">
                  Tap chips to expand. Queue edit/steer/delete and goal pause/resume/clear are live
                  in the mock.
                </p>
              </div>
            </aside>

            <PhoneFrame>
              <ScenarioStack
                key={phoneScenario.id}
                scenario={phoneScenario}
                composer={composer}
                variant="phone"
              />
            </PhoneFrame>
          </div>
        ) : (
          <div className="flex flex-col gap-10" data-session-chrome-harness="">
            {galleryVisible.map((scenario, index) => (
              <section
                key={scenario.id}
                aria-labelledby={`session-chrome-scenario-${scenario.id}`}
                className="overflow-hidden rounded-xl border border-border bg-surface/30"
              >
                <header className="space-y-1 border-b border-border bg-surface-2/50 px-4 py-3 sm:px-5">
                  <p className="text-2xs font-medium uppercase tracking-[0.14em] text-fg-subtle">
                    Scenario {index + 1}
                    <span className="mx-1.5 text-border">·</span>
                    <span className="font-mono normal-case tracking-normal text-fg-muted">
                      {scenario.id}
                    </span>
                  </p>
                  <h2
                    id={`session-chrome-scenario-${scenario.id}`}
                    className="text-sm font-semibold text-fg"
                  >
                    {scenario.title}
                  </h2>
                  <p className="text-xs text-fg-muted">{scenario.description}</p>
                </header>
                <div className="p-3 sm:p-4">
                  <ScenarioStack scenario={scenario} composer={composer} />
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
