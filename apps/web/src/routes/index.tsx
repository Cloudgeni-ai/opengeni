import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Composer } from "@/components/app/Composer";
import { TopBar } from "@/components/app/TopBar";
import { RecentRunsList } from "@/components/home/RecentRunsList";
import { createRun } from "@/lib/api";
import { rememberRun } from "@/lib/known-runs";
import { runQueryOptions } from "@/lib/queries";

const EXAMPLES = [
  "Summarize the top-level structure of /workspace.",
  "Read README.md and list the sections.",
  "Run `wc -l` on every Python file under packages/.",
] as const;

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);

  const mutation = useMutation({
    mutationFn: (prompt: string) => createRun(prompt),
    onMutate: () => setPending(true),
    onSuccess: async (run) => {
      rememberRun({ id: run.id, prompt: run.prompt, createdAt: run.created_at });
      queryClient.setQueryData(runQueryOptions(run.id).queryKey, run);
      await navigate({ to: "/runs/$runId", params: { runId: run.id } });
    },
    onError: (error: unknown) => {
      toast.error("Failed to start run", {
        description: error instanceof Error ? error.message : String(error),
      });
      setPending(false);
    },
  });

  return (
    <>
      <TopBar />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
        <section className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
            What should the agent do?
          </h1>
          <p className="max-w-md text-sm text-[color:var(--color-fg-muted)]">
            Start a durable run in a sandbox. Follow-ups and cancels are live.
          </p>
        </section>

        <section className="mt-8">
          <Composer
            autoFocus
            pending={pending}
            placeholder="Describe a task for the agent..."
            submitLabel={pending ? "Starting" : "Send"}
            examples={EXAMPLES}
            onSubmit={(prompt) => mutation.mutate(prompt)}
          />
        </section>

        <section className="mt-12">
          <h2 className="text-xs font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
            Recent runs
          </h2>
          <RecentRunsList />
        </section>
      </main>
    </>
  );
}
