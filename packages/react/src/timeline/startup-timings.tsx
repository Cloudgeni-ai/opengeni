import type { StartupPhaseItem } from "./types";

const LABELS: Record<StartupPhaseItem["phase"], string> = {
  queue: "Worker queue",
  sandbox: "Sandbox",
  rig: "Rig",
  repository: "Repository",
  files: "Files",
  tools: "Tools",
  model_preparation: "Runtime & model request",
  provider_first_byte: "First model response",
};

export function StartupTimings({ phases }: { phases: StartupPhaseItem[] }) {
  if (!phases.length)
    return <p className="text-og-sm text-og-fg-subtle">No startup timings recorded yet.</p>;
  const byTurn = new Map<string | null, StartupPhaseItem[]>();
  for (const phase of phases) {
    const group = byTurn.get(phase.turnId) ?? [];
    group.push(phase);
    byTurn.set(phase.turnId, group);
  }
  const turns = [...byTurn.entries()]
    .map(([turnId, phases]) => ({
      turnId,
      phases,
      startedAt: phases.reduce(
        (earliest, phase) => (phase.startedAt < earliest ? phase.startedAt : earliest),
        phases[0]!.startedAt,
      ),
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    <div className="space-y-3">
      <p className="text-og-xs text-og-fg-subtle">
        Each turn has its own startup. Phases can overlap; durations are not additive.
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
  const status = phases.some((phase) => phase.status === "failed")
    ? "Failed"
    : phases.some((phase) => phase.status === "running")
      ? "In progress"
      : phases.some((phase) => phase.status === "cancelled")
        ? "Interrupted"
        : "Ready";
  return (
    <details open={latest} className="group border-b border-og-border pb-3">
      <summary className="cursor-pointer rounded py-3 text-og-sm text-og-fg-muted focus-visible:outline-2 focus-visible:outline-og-accent">
        <span className="font-medium">
          {turnId === null ? "Unassigned events" : latest ? "Latest turn" : "Earlier turn"}
        </span>
        <span className="ml-2 text-og-xs text-og-fg-subtle">
          {new Date(startedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
        <span
          className={
            status === "Failed"
              ? "ml-2 text-og-xs text-og-status-failed"
              : "ml-2 text-og-xs text-og-fg-subtle"
          }
        >
          {status}
        </span>
        <span className="mt-1 block break-all pl-4 font-og-mono text-og-xs text-og-fg-subtle">
          {turnId ?? "No turn ID recorded"}
        </span>
      </summary>
      <div className="pb-2">
        <p className="text-og-xs text-og-fg-subtle">
          Started <time dateTime={startedAt}>{new Date(startedAt).toLocaleString()}</time>
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-og-xs">
            <caption className="sr-only">
              Startup phases for {turnId ?? "unassigned events"}
            </caption>
            <thead>
              <tr className="border-b border-og-border text-og-fg-subtle">
                <th scope="col" className="py-2 font-medium">
                  Phase
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Duration
                </th>
              </tr>
            </thead>
            <tbody>
              {phases.map((phase, index) => (
                <tr
                  key={`${phase.id}:${index}`}
                  className="border-b border-og-border/40"
                  title={`Turn: ${phase.turnId ?? "unknown"} · Started: ${phase.startedAt}`}
                >
                  <th scope="row" className="py-2.5 font-normal text-og-fg-muted">
                    {LABELS[phase.phase]}
                  </th>
                  <td
                    className={`px-3 py-2.5 ${phase.status === "failed" ? "text-og-status-failed" : "text-og-fg-subtle"}`}
                  >
                    {phase.status === "running" ? "In progress" : phase.status}
                  </td>
                  <td className="py-2.5 text-right font-og-mono tabular-nums text-og-fg-muted">
                    {phase.durationMs === null
                      ? "—"
                      : phase.durationMs < 1000
                        ? `${Math.round(phase.durationMs)} ms`
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
