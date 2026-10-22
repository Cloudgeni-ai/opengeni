import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SIMPLE_SERVER_PORT = Number(process.env.OPENGENI_SIMPLE_SERVER_PORT ?? 5191);
export const SIMPLE_WEB_PORT = Number(process.env.OPENGENI_SIMPLE_WEB_PORT ?? 5190);

const repositoryRoot = resolve(import.meta.dirname, "../../..");

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
  return values;
}

/**
 * The Opengeni API this app fronts. An explicit `OPENGENI_SIMPLE_API_URL` wins;
 * otherwise the worktree's running dev stack (`.env.runtime`, then `.env`).
 */
export function opengeniApiUrl(): string {
  if (process.env.OPENGENI_SIMPLE_API_URL) return process.env.OPENGENI_SIMPLE_API_URL;
  const runtime = readEnvFile(join(repositoryRoot, ".env.runtime"));
  const env = readEnvFile(join(repositoryRoot, ".env"));
  const port = runtime.OPENGENI_API_PORT ?? env.OPENGENI_API_PORT ?? "8000";
  return `http://127.0.0.1:${port}`;
}

/** The Opengeni web console, for the "Open in full app" escape hatch. */
export function opengeniWebUrl(): string | null {
  if (process.env.OPENGENI_SIMPLE_FULL_APP_URL) return process.env.OPENGENI_SIMPLE_FULL_APP_URL;
  return null;
}

export const dataDirectory = resolve(
  process.env.OPENGENI_SIMPLE_DATA_DIR ?? join(import.meta.dirname, "../data"),
);
