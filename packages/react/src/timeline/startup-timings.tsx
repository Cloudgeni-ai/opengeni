import type { StartupPhaseItem } from "./types";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";

const LABELS = (t: OpenGeniText): Record<StartupPhaseItem["phase"], string> => ({
  queue: t("timeline.startupTimings.workerQueue"),
  sandbox: t("timeline.startupTimings.sandbox"),
  rig: t("timeline.startupTimings.sandboxEnvironment"),
  repository: t("timeline.startupTimings.repository"),
  files: t("timeline.startupTimings.files"),
  tools: t("timeline.startupTimings.tools"),
  history: t("timeline.startupTimings.conversationHistory"),
  model_preparation: t("timeline.startupTimings.runtimeModelRequest"),
  provider_first_byte: t("timeline.startupTimings.firstModelResponse"),
});

export function StartupTimings({ phases }: { phases: StartupPhaseItem[] }) {
  const t = useOpenGeniText();
  if (!phases.length)
    return (
      <p className="text-og-sm text-og-fg-subtle">
        {t("timeline.startupTimings.noStartupTimingsRecordedYet")}
      </p>
    );
  const byTurn = new Map<string | null, StartupPhaseItem[]>();
  for (const phase of phases) {
    const group = byTurn.get(phase.turnId) ?? [];
    group.push(phase);
    byTurn.set(phase.turnId, group);
  }
  const turns = [...byTurn.entries()]
    .map(([turnId, turnPhases]) => ({
      turnId,
      phases: turnPhases,
      startedAt: turnPhases.reduce(
        (earliest, phase) => (phase.startedAt < earliest ? phase.startedAt : earliest),
        turnPhases[0]!.startedAt,
      ),
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    <div className="space-y-3">
      <p className="text-og-xs text-og-fg-subtle">
        {t("timeline.startupTimings.eachTurnHasItsOwn")}
      </p>
      {turns.map((turn, index) => (
        <StartupTurn
          key={turn.turnId ?? "unassigned"}
          {...turn}
          latest={index === 0 && turn.turnId !== null}
        />
      ))}
    </div>
  );
}

function StartupTurn({
  turnId,
  phases,
  startedAt,
  latest,
}: {
  turnId: string | null;
  phases: StartupPhaseItem[];
  startedAt: string;
  latest: boolean;
}) {
  const t = useOpenGeniText();
  const failed = phases.some((phase) => phase.status === "failed");
  const status = failed
    ? t("timeline.startupTimings.failed")
    : phases.some((phase) => phase.status === "running")
      ? t("timeline.startupTimings.inProgress")
      : phases.some((phase) => phase.status === "cancelled")
        ? t("timeline.startupTimings.interrupted")
        : t("timeline.startupTimings.ready");
  return (
    <details open={latest} className="group border-b border-og-border pb-3">
      <summary className="cursor-pointer rounded py-3 text-og-sm text-og-fg-muted focus-visible:outline-2 focus-visible:outline-og-accent">
        <span className="font-medium">
          {turnId === null
            ? t("timeline.startupTimings.unassignedEvents")
            : latest
              ? t("timeline.startupTimings.latestTurn")
              : t("timeline.startupTimings.earlierTurn")}
        </span>
        <span className="ml-2 text-og-xs text-og-fg-subtle">
          {new Date(startedAt).toLocaleTimeString(t.locale, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
        <span
          className={
            failed ? "ml-2 text-og-xs text-og-status-failed" : "ml-2 text-og-xs text-og-fg-subtle"
          }
        >
          {status}
        </span>
        <span className="mt-1 block break-all pl-4 font-og-mono text-og-xs text-og-fg-subtle">
          {turnId ?? t("timeline.startupTimings.noTurnIdRecorded")}
        </span>
      </summary>
      <div className="pb-2">
        <p className="text-og-xs text-og-fg-subtle">
          {t("timeline.startupTimings.started")}{" "}
          <time dateTime={startedAt}>{new Date(startedAt).toLocaleString(t.locale)}</time>
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-og-xs">
            <caption className="sr-only">
              {t("timeline.startupTimings.startupPhasesFor")}{" "}
              {turnId ?? t("timeline.startupTimings.unassignedEvents2")}
            </caption>
            <thead>
              <tr className="border-b border-og-border text-og-fg-subtle">
                <th scope="col" className="py-2 font-medium">
                  {t("timeline.startupTimings.phase")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("timeline.startupTimings.status")}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t("timeline.startupTimings.duration")}
                </th>
              </tr>
            </thead>
            <tbody>
              {phases.map((phase) => (
                <tr
                  key={phase.id}
                  className="border-b border-og-border/40"
                  title={t("timeline.startupTimings.turnTurnidStartedStartedat", {
                    turnId: phase.turnId ?? t("timeline.startupTimings.unknownTurn"),
                    startedAt: phase.startedAt,
                  })}
                >
                  <th scope="row" className="py-2.5 font-normal text-og-fg-muted">
                    {LABELS(t)[phase.phase]}
                  </th>
                  <td
                    className={`px-3 py-2.5 ${phase.status === "failed" ? "text-og-status-failed" : "text-og-fg-subtle"}`}
                  >
                    {phase.status === "running"
                      ? t("timeline.startupTimings.inProgress")
                      : phase.status}
                  </td>
                  <td className="py-2.5 text-right font-og-mono tabular-nums text-og-fg-muted">
                    {phase.durationMs === null
                      ? "—"
                      : phase.durationMs < 1000
                        ? t("timeline.startupTimings.roundMs", {
                            round: Math.round(phase.durationMs),
                          })
                        : `${(phase.durationMs / 1000).toFixed(1)} s`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
