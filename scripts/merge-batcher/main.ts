import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Controller, LiveReader, type StepResult } from "./controller";
import { GitStore } from "./git";
import { GitHubAuth, GitHubReader, githubCapabilities, requireActiveCapabilities } from "./github";
import { assertSha, config, type Config } from "./model";

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
  if (!["shadow", "run"].includes(command)) throw new Error("Expected inspect, shadow, or run");
  const settings = config({ ...env, ...(command === "shadow" ? { BATCHER_MODE: "shadow" } : {}) });
  // Fail before auth, observation or any write if provider cannot meet fencing.
  if (settings.mode === "active") requireActiveCapabilities(githubCapabilities);
  const auth = new GitHubAuth({ ...env, BATCHER_MODE: settings.mode });
  const git = new GitStore(settings.gitDir, await auth.gitEnv());
  await git.init();
  const reader = new LiveReader(new GitHubReader(settings, auth), git, settings);
  const controller = new Controller(settings, reader, git, randomUUID());
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
        const result = await controller.step();
        ready = true;
        lastSuccess = Date.now();
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
        // Provider bodies, URLs and arbitrary Git stderr are deliberately absent.
        if (once) throw error;
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
        }, settings.pollSeconds * 1000);
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
    // Errors originating in adapters have sanitized messages. Avoid dumping stacks/env.
    console.error(error instanceof Error ? error.message : "Batcher failed");
    process.exitCode = 1;
  });
