import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const requiredChecks = [
  "load-soak",
  "backup-restore",
  "rollback",
  "observability-alerts",
  "private-ops-boundary",
] as const;

interface Args {
  outFile: string;
  environment: string;
  baseUrl: string;
  checkFiles: string[];
}

const args = parseArgs(process.argv.slice(2), process.env);
const checks: Record<string, unknown>[] = [];
const failures: string[] = [];

for (const file of args.checkFiles) {
  if (!existsSync(file)) {
    failures.push(`check file does not exist: ${file}`);
    continue;
  }
  const parsed = parseJson(file, failures);
  if (!parsed) {
    continue;
  }
  const extracted = extractChecks(parsed, file, failures);
  checks.push(...extracted);
}

const seen = new Set<string>();
for (const check of checks) {
  const id = stringField(check, "id");
  if (!id) {
    failures.push("check is missing id");
    continue;
  }
  if (seen.has(id)) {
    failures.push(`duplicate operational check ${id}`);
  }
  seen.add(id);
}

for (const required of requiredChecks) {
  if (!seen.has(required)) {
    failures.push(`missing required operational check ${required}`);
  }
}

const ok = failures.length === 0 && checks.every((check) => stringField(check, "status") === "passed");
const output = {
  ok,
  environment: args.environment,
  baseUrl: args.baseUrl,
  generatedAt: new Date().toISOString(),
  sourceFiles: args.checkFiles,
  checks,
  ...(failures.length > 0 ? { failures } : {}),
};

await mkdir(dirname(args.outFile), { recursive: true });
await Bun.write(args.outFile, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));

if (!ok) {
  process.exit(1);
}
process.exit(0);

function extractChecks(parsed: Record<string, unknown>, file: string, failures: string[]): Record<string, unknown>[] {
  if (parsed.ok === false) {
    failures.push(`source ${file} has top-level ok=false`);
  }
  if (Array.isArray(parsed.checks)) {
    return parsed.checks.flatMap((check) => {
      if (!check || typeof check !== "object" || Array.isArray(check)) {
        failures.push(`source ${file} contains an invalid check`);
        return [];
      }
      return [check as Record<string, unknown>];
    });
  }
  const check = parsed.check;
  if (check && typeof check === "object" && !Array.isArray(check)) {
    return [check as Record<string, unknown>];
  }
  if (stringField(parsed, "id") && stringField(parsed, "status")) {
    return [parsed];
  }
  failures.push(`source ${file} does not contain checks, check, or a single check object`);
  return [];
}

function parseJson(file: string, failures: string[]): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      failures.push(`source ${file} must be a JSON object`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    failures.push(`source ${file} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    outFile: env.OPENGENI_OPERATIONAL_READINESS_OUT_FILE ?? ".agent/generated/staging/operational-readiness.json",
    environment: env.OPENGENI_OPERATIONAL_READINESS_ENVIRONMENT ?? "staging",
    baseUrl: env.OPENGENI_OPERATIONAL_READINESS_BASE_URL ?? env.OPENGENI_CONFORMANCE_BASE_URL ?? "",
    checkFiles: parseList(env.OPENGENI_OPERATIONAL_READINESS_CHECK_FILES ?? ""),
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--out") {
      out.outFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--environment") {
      out.environment = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--base-url") {
      out.baseUrl = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--check") {
      out.checkFiles.push(requiredNext(values, ++index, value));
      continue;
    }
    if (value.startsWith("--out=")) {
      out.outFile = value.slice("--out=".length);
      continue;
    }
    if (value.startsWith("--environment=")) {
      out.environment = value.slice("--environment=".length);
      continue;
    }
    if (value.startsWith("--base-url=")) {
      out.baseUrl = value.slice("--base-url=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!out.baseUrl) {
    throw new Error("Set --base-url or OPENGENI_OPERATIONAL_READINESS_BASE_URL");
  }
  if (out.checkFiles.length === 0) {
    throw new Error("Provide at least one --check file");
  }
  return out;
}

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}
