import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Model credentials for the behavior eval.
 *
 * Harnesses never inherit an ambient `.env` (Bun test/scripts in this repo run
 * with `--no-env-file`), so the eval reads ONE explicit env file and copies only
 * the model-provider keys into the settings it builds. Values are never logged.
 */
const MODEL_ENV_KEY = /^OPENGENI_(OPENAI|AZURE_OPENAI)_[A-Z0-9_]+$/u;

export type ModelEnv = Record<string, string>;

export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match as unknown as [string, string, string];
    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.search(/\s+#/u);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    // Last assignment wins, matching dotenv semantics for duplicated keys.
    values[key] = value;
  }
  return values;
}

/** Candidate env files: explicit flag → OPENGENI_EVAL_ENV_FILE → worktree .env → main checkout .env. */
export function candidateEnvFiles(explicit: string | undefined, cwd = process.cwd()): string[] {
  const candidates: string[] = [];
  if (explicit) candidates.push(resolve(explicit));
  const fromEnv = process.env.OPENGENI_EVAL_ENV_FILE;
  if (fromEnv) candidates.push(resolve(fromEnv));
  candidates.push(join(cwd, ".env"));
  const commonDir = gitCommonDir(cwd);
  if (commonDir) candidates.push(join(dirname(commonDir), ".env"));
  return [...new Set(candidates)];
}

function gitCommonDir(cwd: string): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  const path = result.stdout.toString().trim();
  return path.length > 0 ? path : null;
}

export function loadModelEnv(explicit: string | undefined): { path: string; env: ModelEnv } {
  for (const path of candidateEnvFiles(explicit)) {
    if (!existsSync(path)) continue;
    const parsed = parseDotenv(readFileSync(path, "utf8"));
    const env: ModelEnv = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (MODEL_ENV_KEY.test(key) && value.length > 0) env[key] = value;
    }
    const hasCredential =
      env.OPENGENI_OPENAI_API_KEY !== undefined || env.OPENGENI_AZURE_OPENAI_API_KEY !== undefined;
    if (hasCredential) return { path, env };
    if (explicit && resolve(explicit) === path) {
      throw new Error(`${path} has no OPENGENI_OPENAI_API_KEY or OPENGENI_AZURE_OPENAI_API_KEY`);
    }
  }
  throw new Error(
    "No model credentials found. Pass --env-file <path> (or OPENGENI_EVAL_ENV_FILE) pointing at a .env with OpenAI/Azure OpenAI keys.",
  );
}
