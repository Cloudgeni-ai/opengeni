import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { createRun } from "../lib/api";
import { rememberRun } from "../lib/known-runs";

export function CreateRunForm() {
  const [prompt, setPrompt] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: (nextPrompt: string) => createRun(nextPrompt),
    onSuccess: async (run) => {
      rememberRun({ id: run.id, prompt: run.prompt, createdAt: run.created_at });
      queryClient.setQueryData(["runs", run.id], run);
      setPrompt("");
      setErrorMessage(null);
      await navigate({ to: "/runs/$runId", params: { runId: run.id } });
    },
    onError: (error: unknown) => {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    },
  });

  return (
    <form
      className="prompt-form"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = prompt.trim();
        if (!trimmed) {
          setErrorMessage("Prompt is required");
          return;
        }
        mutation.mutate(trimmed);
      }}
    >
      <label htmlFor="prompt" className="muted">
        Prompt
      </label>
      <textarea
        id="prompt"
        name="prompt"
        placeholder="Describe what the agent should do..."
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        disabled={mutation.isPending}
      />
      {errorMessage ? <div className="notice">{errorMessage}</div> : null}
      <div>
        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Starting..." : "Start run"}
        </button>
      </div>
    </form>
  );
}
