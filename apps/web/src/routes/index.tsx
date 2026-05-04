import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GitBranchIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Composer } from "@/components/app/Composer";
import { TopBar } from "@/components/app/TopBar";
import { RecentRunsList } from "@/components/home/RecentRunsList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createRun } from "@/lib/api";
import { rememberRun } from "@/lib/known-runs";
import { runQueryOptions } from "@/lib/queries";
import type { ResourceRef } from "@/lib/types";

const EXAMPLES = [
  "Summarize the top-level structure of /workspace.",
  "Read README.md and list the sections.",
  "Run `wc -l` on every Python file under packages/.",
] as const;

interface RepoDraft {
  id: number;
  url: string;
  ref: string;
}

interface CreateRunInput {
  prompt: string;
  resources: ResourceRef[];
}

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [repos, setRepos] = useState<RepoDraft[]>([]);
  const [nextRepoId, setNextRepoId] = useState(1);

  const mutation = useMutation({
    mutationFn: ({ prompt, resources }: CreateRunInput) => createRun(prompt, resources),
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

  function addRepo() {
    setRepos((current) => [...current, { id: nextRepoId, url: "", ref: "main" }]);
    setNextRepoId((value) => value + 1);
  }

  function updateRepo(id: number, patch: Partial<RepoDraft>) {
    setRepos((current) =>
      current.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo)),
    );
  }

  function removeRepo(id: number) {
    setRepos((current) => current.filter((repo) => repo.id !== id));
  }

  function buildResources(): ResourceRef[] {
    const resources = repos
      .map((repo) => ({
        url: repo.url.trim(),
        ref: repo.ref.trim(),
      }))
      .filter((repo) => repo.url.length > 0);
    const mountPaths = new Set<string>();
    return resources.map((repo) => {
      if (repo.ref.length === 0) {
        throw new Error("Repository ref is required.");
      }
      const parsed = normalizeRepositoryUrl(repo.url);
      const mountPath = "repos/" + parsed.repo;
      if (mountPaths.has(mountPath)) {
        throw new Error(`Duplicate repository mount path: ${mountPath}`);
      }
      mountPaths.add(mountPath);
      return {
        kind: "repository",
        uri: `https://${parsed.host}/${parsed.repo}.git`,
        metadata: {
          host: parsed.host,
          repo: parsed.repo,
          ref: repo.ref,
          subpath: null,
          mount_path: mountPath,
        },
      };
    });
  }

  function submitRun(prompt: string) {
    let resources: ResourceRef[];
    try {
      resources = buildResources();
    } catch (error) {
      toast.error("Repository input is invalid", {
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    mutation.mutate({ prompt, resources });
  }

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
          <div className="mb-4 space-y-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-xs uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
                Repositories
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={addRepo}
                disabled={pending}
                className="h-7 gap-1.5 px-2 text-xs"
              >
                <PlusIcon className="size-3.5" />
                Add repo
              </Button>
            </div>
            {repos.length === 0 ? (
              <p className="text-xs text-[color:var(--color-fg-subtle)]">
                Optional. Public HTTPS Git repositories are mounted under /workspace/repos.
              </p>
            ) : (
              <div className="space-y-2">
                {repos.map((repo) => (
                  <div
                    key={repo.id}
                    className="grid grid-cols-[1fr_7.5rem_auto] gap-2 max-sm:grid-cols-[1fr_auto]"
                  >
                    <Input
                      value={repo.url}
                      onChange={(event) => updateRepo(repo.id, { url: event.target.value })}
                      disabled={pending}
                      placeholder="https://github.com/org/repo"
                      aria-label="Repository URL"
                      className="h-8 text-xs"
                    />
                    <div className="relative max-sm:col-start-1">
                      <GitBranchIcon className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-[color:var(--color-fg-subtle)]" />
                      <Input
                        value={repo.ref}
                        onChange={(event) => updateRepo(repo.id, { ref: event.target.value })}
                        disabled={pending}
                        placeholder="main"
                        aria-label="Repository ref"
                        className="h-8 pl-7 text-xs"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeRepo(repo.id)}
                      disabled={pending}
                      aria-label="Remove repository"
                      className="size-8 text-[color:var(--color-fg-muted)]"
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <Composer
            autoFocus
            pending={pending}
            placeholder="Describe a task for the agent..."
            submitLabel={pending ? "Starting" : "Send"}
            examples={EXAMPLES}
            onSubmit={submitRun}
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

function normalizeRepositoryUrl(input: string): { host: string; repo: string } {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Repository URL must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0) {
    throw new Error("Repository URL must use https://.");
  }
  let path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (path.endsWith(".git")) {
    path = path.slice(0, -4);
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Repository URL must include an owner/path and repository name.");
  }
  return {
    host: parsed.host.toLowerCase(),
    repo: parts.join("/"),
  };
}
