#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDevelopmentPrerequisites } from "./check-development-prerequisites";
import { acquireDevelopmentStackLock } from "./dev-stack-lock";
import {
  readDevelopmentLaunchEnvironment,
  resolveDevelopmentLaunchBackend,
} from "./development-launch-environment";

export async function runDevelopmentStack(
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  options: { checkOnly?: boolean; checkPrerequisites?: typeof checkDevelopmentPrerequisites } = {},
): Promise<number> {
  process.chdir(repositoryRoot);
  const snapshot = readDevelopmentLaunchEnvironment(repositoryRoot);
  const environment = resolveDevelopmentLaunchBackend(
    repositoryRoot,
    snapshot.environment,
    snapshot.project,
  );
  await (options.checkPrerequisites ?? checkDevelopmentPrerequisites)({
    repositoryRoot,
    environment,
    artifactRuntime: "resolve",
  });
  if (options.checkOnly) {
    console.log("OpenGeni startup prerequisites are satisfied; no services started.");
    return 0;
  }
  // Read the same project authority as the shell, before creating .env or
  // touching generated environment, database roles, ports, or infrastructure.
  const project = snapshot.project;
  const token = randomUUID();
  const release = acquireDevelopmentStackLock(project, { token, repositoryRoot });
  try {
    const child = Bun.spawn(
      [
        "bash",
        "scripts/dev-stack.sh",
        `--opengeni-dev-stack-token=${token}`,
        ...process.argv.slice(2),
      ],
      {
        env: environment,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        detached: true,
      },
    );
    // Include foreground builds and grandchildren, not only the waiting shell.
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const terminate = () => signalGroup("SIGTERM");
    const interrupt = () => signalGroup("SIGINT");
    process.on("SIGTERM", terminate);
    process.on("SIGINT", interrupt);
    try {
      return await child.exited;
    } finally {
      process.off("SIGTERM", terminate);
      process.off("SIGINT", interrupt);
    }
  } finally {
    release();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runDevelopmentStack(undefined, {
      checkOnly: process.argv.includes("--check"),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
