#!/usr/bin/env bun
// One merge batcher pass, run by .github/workflows/merge-batcher.yml.
// `--dry-run` prints what it would do with read-only calls.
import { parseArgs } from "node:util";
import { RestGitHub } from "./github";
import { DEFAULT_SETTINGS, type Settings } from "./model";
import { run } from "./pass";

function settings(env: Record<string, string | undefined>): Settings {
  const seconds = (name: string, fallback: number) => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a number`);
    return parsed * 1000;
  };
  const maxBatch = Number(env.BATCHER_MAX_BATCH || DEFAULT_SETTINGS.maxBatch);
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1) throw new Error("BATCHER_MAX_BATCH");
  return {
    windowMs: seconds("BATCHER_WINDOW_SECONDS", DEFAULT_SETTINGS.windowMs / 1000),
    maxBatch,
    startTimeoutMs: seconds(
      "BATCHER_START_TIMEOUT_SECONDS",
      DEFAULT_SETTINGS.startTimeoutMs / 1000,
    ),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean" },
      "max-minutes": { type: "string" },
    },
  });
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const repository = process.env.GITHUB_REPOSITORY ?? "Cloudgeni-ai/opengeni";
  const minutes = Number(values["max-minutes"] ?? 8);
  await run(new RestGitHub(repository, token), {
    settings: settings(process.env),
    deadline: Date.now() + minutes * 60_000,
    dryRun: values["dry-run"] === true,
  });
}

export { settings };
