import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { cancelRun, submitFollowUp } from "../lib/api";
import { TERMINAL_STATUSES, type AgentRun } from "../lib/types";
import { runEventsQueryOptions, runQueryOptions } from "../lib/queries";

interface RunControlsProps {
  run: AgentRun;
}

export function RunControls({ run }: RunControlsProps) {
  const queryClient = useQueryClient();
  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [controlError, setControlError] = useState<string | null>(null);

  const terminal = TERMINAL_STATUSES.has(run.status);

  const followUpMutation = useMutation({
    mutationFn: (prompt: string) => submitFollowUp(run.id, prompt),
    onSuccess: async (updated) => {
      queryClient.setQueryData(runQueryOptions(run.id).queryKey, updated);
      setFollowUpPrompt("");
      setControlError(null);
      await queryClient.invalidateQueries({
        queryKey: runEventsQueryOptions(run.id).queryKey,
      });
    },
    onError: (error: unknown) => {
      setControlError(error instanceof Error ? error.message : String(error));
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (reason: string | null) => cancelRun(run.id, reason),
    onSuccess: async (updated) => {
      queryClient.setQueryData(runQueryOptions(run.id).queryKey, updated);
      setCancelReason("");
      setControlError(null);
      await queryClient.invalidateQueries({
        queryKey: runEventsQueryOptions(run.id).queryKey,
      });
    },
    onError: (error: unknown) => {
      setControlError(error instanceof Error ? error.message : String(error));
    },
  });

  return (
    <div className="card">
      <div className="card-header">
        <h2>Steer</h2>
      </div>
      {controlError ? <div className="notice">{controlError}</div> : null}
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = followUpPrompt.trim();
          if (!trimmed) {
            setControlError("Follow-up prompt is required");
            return;
          }
          followUpMutation.mutate(trimmed);
        }}
      >
        <input
          type="text"
          placeholder="Follow-up prompt"
          value={followUpPrompt}
          onChange={(event) => setFollowUpPrompt(event.target.value)}
          disabled={terminal || followUpMutation.isPending}
        />
        <button
          type="submit"
          className="action-button"
          disabled={terminal || followUpMutation.isPending}
        >
          {followUpMutation.isPending ? "Sending..." : "Follow up"}
        </button>
      </form>

      <form
        className="inline-form"
        style={{ marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          const reason = cancelReason.trim() || null;
          cancelMutation.mutate(reason);
        }}
      >
        <input
          type="text"
          placeholder="Cancel reason (optional)"
          value={cancelReason}
          onChange={(event) => setCancelReason(event.target.value)}
          disabled={terminal || cancelMutation.isPending}
        />
        <button
          type="submit"
          className="action-button danger"
          disabled={terminal || cancelMutation.isPending}
        >
          {cancelMutation.isPending ? "Cancelling..." : "Cancel run"}
        </button>
      </form>

      {terminal ? (
        <p className="muted" style={{ marginTop: 12 }}>
          Run is terminal ({run.status}). No further actions can be taken.
        </p>
      ) : null}
    </div>
  );
}
