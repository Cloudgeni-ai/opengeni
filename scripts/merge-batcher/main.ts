import { randomUUID } from "node:crypto";
import { observeCycle, observationDeferred, OBSERVATION_DEFERRED_EXIT } from "./cycle-outcome";
import { errorDiagnostic, markFailurePhase } from "./diagnostics";
import { parseArgs } from "node:util";
import { Controller, LiveReader, type StepResult } from "./controller";
import { AtomicGitWriter, GitStore } from "./git";
import { QueueOnlyPublisher, ShadowCiController } from "./shadow-ci";
import { GitHubActiveExecutor } from "./active";
import { GitHubAuth, GitHubReader, GitHubMutations, ProviderError } from "./github";
import { ObservationJournal } from "./journal";
import { assertSha, config, type Config, type Observation } from "./model";

const OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Durable lease owner for this process. A supervisor that never runs two
 * children at once passes one BATCHER_OWNER_ID per control generation so each
 * sequential child can renew its predecessor's lease instead of waiting it out.
 * Every write still uses the state-ref CAS and epoch fence. Without the
 * variable each process keeps its own random owner.
 */
export function controllerOwner(env: Record<string, string | undefined>): string {
  const supplied = env.BATCHER_OWNER_ID?.trim().toLowerCase();
  if (!supplied) return randomUUID();
  if (!OWNER_ID.test(supplied)) throw new Error("BATCHER_OWNER_ID must be a UUID");
  return supplied;
}

export async function recoverLocalMissing(
  journal: ObservationJournal,
  observation: Observation,
  github: Pick<GitHubReader, "runs">,
  id: string,
): Promise<void> {
  const candidate = observation.candidates.find((item) => item.manifest.batchId === id);
  // Recovery bypasses historical sampling/cache, just like active recovery.
  // Provider errors abort; an unknown response must never become an empty list.
  if (candidate) candidate.runs = await github.runs(candidate.manifest, candidate.branch);
  await journal.recoverMissing(id, observation, true);
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tip: { type: "string" },
      "git-dir": { type: "string" },
      once: { type: "boolean" },
      "effect-id": { type: "string" },
      "state-sha": { type: "string" },
      "confirm-not-applied": { type: "boolean" },
      "batch-id": { type: "string" },
      "confirm-no-run": { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "shadow";
  if (positionals.length > 1) throw new Error("Unexpected arguments");
  if (command === "inspect") {
    if (!values.tip || !values["git-dir"]) throw new Error("inspect requires --tip and --git-dir");
    console.log(
      JSON.stringify(await new GitStore(values["git-dir"]).inspect(assertSha(values.tip))),
    );
    return;
  }
  if (!["shadow", "run", "recover-effect", "recover-missing-run"].includes(command))
    throw new Error("Expected inspect, shadow, run, recover-effect or recover-missing-run");
  const settings = config({ ...env, ...(command === "shadow" ? { BATCHER_MODE: "shadow" } : {}) });
  if (
    command === "recover-missing-run" &&
    (!values["confirm-no-run"] ||
      !/^[a-f0-9]{64}$/.test(values["batch-id"] ?? "") ||
      (settings.mode === "active" && !values["state-sha"]))
  )
    throw new Error(
      "recover-missing-run requires --batch-id, --confirm-no-run and --state-sha for active mode",
    );
  if (
    command === "recover-effect" &&
    (settings.mode !== "active" ||
      !values["confirm-not-applied"] ||
      !/^[a-f0-9]{64}$/.test(values["effect-id"] ?? "") ||
      !values["state-sha"])
  )
    throw new Error(
      "recover-effect requires active mode, --effect-id, --state-sha and --confirm-not-applied",
    );
  const auth = new GitHubAuth({ ...env, BATCHER_MODE: settings.mode });
  const git = new GitStore(settings.gitDir, await auth.gitEnv(), settings.fetchTimeoutSeconds);
  await git.init();
  const github = new GitHubReader(settings, auth);
  const reader = new LiveReader(github, git, settings);
  const owner = controllerOwner(env);
  const writer = new AtomicGitWriter(
    git,
    `https://github.com/${settings.repository}.git`,
    settings.stateRef,
    `refs/heads/${settings.baseBranch}`,
  );
  const executor =
    settings.mode === "active"
      ? new GitHubActiveExecutor(
          settings,
          git,
          writer,
          github,
          new GitHubMutations(github),
          owner,
          {
            refreshAuth: async () => {
              Object.assign(git.authEnv, await auth.gitEnv());
            },
          },
        )
      : undefined;
  if (command === "recover-effect") {
    await executor!.recoverEffect(values["effect-id"]!, assertSha(values["state-sha"]!), true);
    console.log(
      JSON.stringify({ effectId: values["effect-id"], status: "reconciled-or-requeued" }),
    );
    return;
  }
  if (command === "recover-missing-run") {
    if (executor)
      await executor.recoverMissingRun(values["batch-id"]!, assertSha(values["state-sha"]!), true);
    else {
      const journal = new ObservationJournal(settings);
      const observation = await journal.observe(await reader.observe());
      await recoverLocalMissing(journal, observation, github, values["batch-id"]!);
    }
    console.log(
      JSON.stringify({ batchId: values["batch-id"], status: "released-infrastructure-only" }),
    );
    return;
  }
  const controller =
    settings.mode === "shadow-ci"
      ? new ShadowCiController(
          settings,
          reader,
          git,
          new QueueOnlyPublisher(
            settings,
            new AtomicGitWriter(
              git,
              `https://github.com/${settings.repository}.git`,
              settings.stateRef,
              `refs/heads/${settings.baseBranch}`,
            ),
          ),
          owner,
          github,
        )
      : new Controller(settings, reader, git, owner, executor);
  await runService(settings, controller, values.once ?? false);
}

export async function runService(
  settings: Config,
  controller: { step(): Promise<StepResult> },
  once: boolean,
): Promise<void> {
  let stopping = false,
    ready = false,
    lastSuccess = 0;
  let failures = 0,
    delaySeconds = settings.pollSeconds;
  let wake: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const server = once
    ? null
    : Bun.serve({
        hostname: "0.0.0.0",
        port: settings.port,
        fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/healthz")
            return Response.json(
              { alive: !stopping, mode: settings.mode },
              { status: stopping ? 503 : 200 },
            );
          if (path === "/readyz") {
            const healthy =
              ready &&
              !stopping &&
              Date.now() - lastSuccess < Math.max(120_000, settings.pollSeconds * 3000);
            return Response.json(
              { ready: healthy, mode: settings.mode },
              { status: healthy ? 200 : 503 },
            );
          }
          return new Response("Not found", { status: 404 });
        },
      });
  try {
    for (;;) {
      try {
        const result = await observeCycle(() => controller.step());
        ready = true;
        lastSuccess = Date.now();
        failures = 0;
        delaySeconds = settings.pollSeconds;
        console.log(
          JSON.stringify({
            mode: result.mode,
            action: result.action.kind,
            batchId: result.manifest?.batchId ?? null,
            reason: result.reason,
          }),
        );
      } catch (error) {
        ready = false;
        failures++;
        delaySeconds = Math.max(
          settings.pollSeconds,
          Math.min(3600, 60 * 2 ** Math.min(failures - 1, 6)),
          error instanceof ProviderError ? error.retryAfterSeconds : 0,
        );
        // Provider bodies, URLs and arbitrary Git stderr are deliberately absent.
        if (once) throw markFailurePhase(error, "controller-step");
        console.error(
          JSON.stringify({
            status: "observation_failed",
            errorType: error instanceof Error ? error.name : "Error",
          }),
        );
      }
      if (once || stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, delaySeconds * 1000);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
        if (stopping) wake();
      });
      if (stopping) break;
    }
  } finally {
    await server?.stop();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
if (import.meta.main)
  main(process.argv.slice(2)).catch((error) => {
    // Retain bounded diagnostic text only after credential redaction.
    console.error(JSON.stringify(errorDiagnostic(error)));
    // Exit 75 means only that this cycle has no unresolved attempted write.
    // Supervisors must retain pre-existing unknown outcomes independently.
    process.exitCode = observationDeferred(error) ? OBSERVATION_DEFERRED_EXIT : 1;
  });
