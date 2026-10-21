#!/usr/bin/env bun
import { writeFileSync } from "node:fs";

export async function retryOnce(run: (attempt: number) => Promise<number>): Promise<number> {
  const first = await run(1);
  // A cancellation or deadline is not evidence of a flaky assertion. Preserve
  // the existing per-attempt deadline and never restart cancelled work.
  if (first === 0 || first === 70 || first === 124 || first >= 128) return first;
  console.log(`[retry-once] attempt 1 failed (${first}); retrying unchanged inputs once`);
  const second = await run(2);
  console.log(
    second === 0
      ? "::warning::[retry-once] recovered on unchanged retry; inspect both attempt profiles"
      : `[retry-once] retry failed (${second})`,
  );
  return second;
}

export function attemptCommand(command: string[], attempt: number): string[] {
  return command.map((argument) => argument.replaceAll("{attempt}", String(attempt)));
}

if (import.meta.main) {
  const split = process.argv.indexOf("--");
  const command = split < 0 ? [] : process.argv.slice(split + 1);
  if (!command.length) throw new Error("usage: retry-once.ts -- <command> [args...]");
  let cancelled = false;
  const reportIndex = process.argv.indexOf("--report");
  const reportPath =
    reportIndex >= 0 && reportIndex < split ? process.argv[reportIndex + 1] : undefined;
  const attempts: { attempt: number; startedAt: string; finishedAt: string; exitCode: number }[] =
    [];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cancelled = true;
      child?.kill(signal);
    });
  }
  const result = await retryOnce(async (attempt) => {
    if (cancelled) return 130;
    const startedAt = new Date().toISOString();
    child = Bun.spawn(attemptCommand(command, attempt), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    const status = await child.exited;
    const exitCode = cancelled ? 130 : status;
    attempts.push({ attempt, startedAt, finishedAt: new Date().toISOString(), exitCode });
    return exitCode;
  });
  if (reportPath)
    writeFileSync(
      reportPath,
      JSON.stringify({ schemaVersion: 1, attempts, exitCode: result }, null, 2) + "\n",
    );
  process.exit(result);
}
