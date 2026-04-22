import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { loadKnownRuns, type KnownRun } from "../lib/known-runs";

export function KnownRunsList() {
  const [runs, setRuns] = useState<KnownRun[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setRuns(loadKnownRuns());
  }, []);

  if (!mounted) {
    return <p className="muted">Loading recent runs...</p>;
  }

  if (runs.length === 0) {
    return (
      <p className="muted">
        No runs yet in this browser. Start one above to see it here.
      </p>
    );
  }

  return (
    <div className="run-table">
      {runs.map((run) => (
        <div className="run-row" key={run.id}>
          <div className="run-prompt" title={run.prompt}>
            {run.prompt}
          </div>
          <div className="muted">{new Date(run.createdAt).toLocaleString()}</div>
          <code className="muted">{run.id.slice(0, 8)}</code>
          <Link
            className="run-link"
            to="/runs/$runId"
            params={{ runId: run.id }}
          >
            Open →
          </Link>
        </div>
      ))}
    </div>
  );
}
