import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";

import { RunControls } from "../components/RunControls";
import { RunStream } from "../components/RunStream";
import { StatusPill } from "../components/StatusPill";
import {
  runEventsQueryOptions,
  runQueryOptions,
} from "../lib/queries";

export const Route = createFileRoute("/runs/$runId")({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(runQueryOptions(params.runId)),
      context.queryClient.ensureQueryData(runEventsQueryOptions(params.runId)),
    ]);
  },
  component: RunDetailPage,
});

function RunDetailPage() {
  const { runId } = Route.useParams();
  const { data: run } = useSuspenseQuery(runQueryOptions(runId));
  const { data: events } = useSuspenseQuery(runEventsQueryOptions(runId));

  return (
    <>
      <section className="card">
        <div className="card-header">
          <div>
            <h2>{run.prompt}</h2>
            <div className="muted">
              Run {run.id.slice(0, 8)} · created {new Date(run.created_at).toLocaleString()}
            </div>
          </div>
          <StatusPill status={run.status} />
        </div>
        {run.temporal_workflow_id ? (
          <p className="muted">
            Temporal workflow: <code>{run.temporal_workflow_id}</code>
          </p>
        ) : (
          <p className="muted">Not yet dispatched to Temporal.</p>
        )}
      </section>

      <RunControls run={run} />
      <RunStream run={run} initialEvents={events} />
    </>
  );
}
