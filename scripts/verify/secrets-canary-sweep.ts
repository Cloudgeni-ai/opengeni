#!/usr/bin/env bun
/**
 * Leaked-value sweep (dossier SEC-1, SEC-2, SEC-3, SEC-5, OB-3; gate scenario E2E-11).
 *
 * Searches every place a secret could come to rest for known test values and
 * reports locations and counts only (never the value):
 *   - every text-like, json/jsonb, array and bytea column of every table in every
 *     database of the stack's Postgres (application DB, Temporal history and
 *     visibility DBs; interaction rows, envelopes, leases, snapshots, events);
 *   - Temporal histories through `temporal workflow show -o json`, with base64
 *     payloads decoded (catches payloads the raw bytea scan cannot see);
 *   - log files and the journald output of the stack's systemd units;
 *   - object storage (sandbox snapshots, artifacts), gzip/zstd decompressed;
 *   - any extra directories or files (event dumps, span exports).
 *
 *   bun --no-env-file scripts/verify/secrets-canary-sweep.ts --stack sv-w7 \
 *     --canaries .agent/evidence/canaries.json [--allow 'Save Canary=db:opengeni/public\.session_events\.'] \
 *     [--dir <path>]... [--log <file>]... [--no-temporal] [--no-object-storage] \
 *     [--key-name secretAnswers] [--out report.json] [--expect-hits]
 *
 * Known values come from --canaries <file> and/or SECRETS_SWEEP_CANARIES_JSON
 * ([{label, value}] or {values:[...]}). Exit 0 when clean (or, with --expect-hits,
 * when every value was found at least once: the detection self-test), 1 on
 * unexpected hits, 2 on usage or infrastructure errors.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import {
  type AllowRule,
  type Hit,
  type KnownValue,
  type Needle,
  isAllowed,
  loadKnownValues,
  maybeDecompress,
  needlesFor,
  parseAllowRule,
  scanBuffer,
} from "./secrets-e2e/scan";
import { type StackState, loadStack, localstackDir, readEnvFile } from "./secrets-e2e/stack";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

export type SweepOptions = {
  values: KnownValue[];
  keyNames: string[];
  dbUrls: string[];
  allDatabases: boolean;
  logs: string[];
  journalUnits: string[];
  dirs: string[];
  temporalContainer?: string | undefined;
  temporalLimit: number;
  objectStorageEnv?: string | undefined;
  allow: AllowRule[];
  log: (line: string) => void;
};

export type SweepReport = {
  startedAt: string;
  finishedAt: string;
  labels: string[];
  keyNames: string[];
  coverage: Record<string, number | string>;
  errors: string[];
  hits: Hit[];
  allowed: (Hit & { reason: string })[];
  clean: boolean;
  missingLabels: string[];
};

export async function runSweep(options: SweepOptions): Promise<SweepReport> {
  const startedAt = new Date().toISOString();
  const needles: Needle[] = [
    ...needlesFor(options.values),
    ...options.keyNames.map((name) => ({
      label: `key:${name}`,
      encoding: "raw",
      bytes: Buffer.from(name),
    })),
  ];
  const hits: Hit[] = [];
  const errors: string[] = [];
  const coverage: Record<string, number | string> = {};

  for (const url of await expandDatabases(options.dbUrls, options.allDatabases, errors)) {
    const result = await scanDatabase(url, needles, errors);
    hits.push(...result.hits);
    coverage[`db:${databaseName(url)} columns`] = result.columns;
    coverage[`db:${databaseName(url)} rows`] = result.rows;
    options.log(
      `db ${databaseName(url)}: ${result.columns} columns, ${result.hits.length} hit groups`,
    );
  }

  if (options.temporalContainer) {
    const result = scanTemporal(options.temporalContainer, options.temporalLimit, needles, errors);
    hits.push(...result.hits);
    coverage["temporal workflows"] = result.workflows;
    options.log(`temporal: ${result.workflows} workflow histories`);
  }

  let logBytes = 0;
  for (const file of options.logs) {
    if (!existsSync(file)) continue;
    const data = readFileSync(file);
    logBytes += data.length;
    hits.push(...scanBuffer(`log:${file}`, data, needles));
  }
  for (const unit of options.journalUnits) {
    const result = Bun.spawnSync(["journalctl", "--user", "-u", unit, "--no-pager", "-o", "cat"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    logBytes += result.stdout.length;
    hits.push(...scanBuffer(`journal:${unit}`, Buffer.from(result.stdout), needles));
  }
  coverage["log files"] = options.logs.filter((file) => existsSync(file)).length;
  coverage["journal units"] = options.journalUnits.length;
  coverage["log bytes"] = logBytes;
  options.log(`logs: ${coverage["log files"]} files, ${options.journalUnits.length} units`);

  let fileCount = 0;
  for (const root of options.dirs) {
    for (const file of walk(root)) {
      fileCount += 1;
      const size = statSync(file).size;
      if (size > MAX_FILE_BYTES) {
        errors.push(`skipped ${file}: ${size} bytes is over the per-file cap`);
        continue;
      }
      hits.push(...scanBuffer(`file:${file}`, maybeDecompress(readFileSync(file)), needles));
    }
  }
  coverage["files"] = fileCount;

  if (options.objectStorageEnv) {
    const result = await scanObjectStorage(options.objectStorageEnv, needles, errors);
    hits.push(...result.hits);
    coverage["objects"] = result.objects;
    options.log(`object storage: ${result.objects} objects`);
  }

  const unexpected: Hit[] = [];
  const allowed: (Hit & { reason: string })[] = [];
  for (const hit of hits) {
    const rule = isAllowed(hit, options.allow);
    if (rule) allowed.push({ ...hit, reason: rule.reason });
    else unexpected.push(hit);
  }
  const labels = [...new Set(needles.map((needle) => needle.label))];
  const foundLabels = new Set(hits.map((hit) => hit.label));
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    labels,
    keyNames: options.keyNames,
    coverage,
    errors,
    hits: unexpected,
    allowed,
    clean: unexpected.length === 0,
    missingLabels: labels.filter((label) => !foundLabels.has(label)),
  };
}

function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//u, "") || "postgres";
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function expandDatabases(urls: string[], all: boolean, errors: string[]): Promise<string[]> {
  if (!all) return urls;
  const expanded = new Set<string>();
  for (const url of urls) {
    const sql = new Bun.SQL(url);
    try {
      const rows =
        (await sql`select datname from pg_database where datallowconn and not datistemplate order by datname`) as {
          datname: string;
        }[];
      for (const row of rows) expanded.add(withDatabase(url, row.datname));
    } catch (error) {
      errors.push(`list databases at ${databaseName(url)}: ${(error as Error).message}`);
      expanded.add(url);
    } finally {
      await sql.close();
    }
  }
  return [...expanded];
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function scanDatabase(
  url: string,
  needles: Needle[],
  errors: string[],
): Promise<{ hits: Hit[]; columns: number; rows: number }> {
  const sql = new Bun.SQL(url, { max: 2 });
  const hits: Hit[] = [];
  let columns = 0;
  let rows = 0;
  try {
    const catalog = (await sql`
      select n.nspname as schema, c.relname as table, a.attname as column, t.typname as type,
             t.typcategory as category, c.reltuples::bigint as estimate
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_type t on t.oid = a.atttypid
       where c.relkind in ('r', 'm')
         and a.attnum > 0 and not a.attisdropped
         and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
         and (t.typcategory in ('S', 'A') or t.typname in ('json', 'jsonb', 'bytea', 'xml'))
       order by 1, 2, 3`) as {
      schema: string;
      table: string;
      column: string;
      type: string;
      category: string;
      estimate: number;
    }[];
    const byTable = new Map<string, typeof catalog>();
    for (const row of catalog) {
      const key = `${row.schema}.${row.table}`;
      byTable.set(key, [...(byTable.get(key) ?? []), row]);
    }
    const params = needles.map((needle) => needle.bytes.toString());
    for (const [table, tableColumns] of byTable) {
      const [first] = tableColumns;
      const relation = `${quoteIdent(first!.schema)}.${quoteIdent(first!.table)}`;
      const selects: string[] = ["count(*)::bigint as total"];
      tableColumns.forEach((column, columnIndex) => {
        const ident = quoteIdent(column.column);
        needles.forEach((_needle, needleIndex) => {
          const param = `$${needleIndex + 1}`;
          const condition =
            column.type === "bytea"
              ? `position(convert_to(${param}, 'UTF8') in ${ident}) > 0`
              : `strpos(${ident}::text, ${param}) > 0`;
          selects.push(
            `count(*) filter (where ${condition})::bigint as c${columnIndex}_${needleIndex}`,
          );
        });
      });
      try {
        const [result] = (await sql.unsafe(
          `select ${selects.join(", ")} from ${relation}`,
          params,
        )) as Record<string, number | bigint>[];
        columns += tableColumns.length;
        rows += Number(result?.total ?? 0);
        tableColumns.forEach((column, columnIndex) => {
          needles.forEach((needle, needleIndex) => {
            const count = Number(result?.[`c${columnIndex}_${needleIndex}`] ?? 0);
            if (count > 0) {
              hits.push({
                location: `db:${databaseName(url)}/${table}.${column.column}`,
                label: needle.label,
                encoding: needle.encoding,
                count,
              });
            }
          });
        });
      } catch (error) {
        errors.push(
          `scan ${databaseName(url)}/${table}: ${(error as Error).message.slice(0, 200)}`,
        );
      }
    }
  } catch (error) {
    errors.push(`catalog ${databaseName(url)}: ${(error as Error).message}`);
  } finally {
    await sql.close();
  }
  return { hits, columns, rows };
}

function decodePayloads(value: unknown, sink: Buffer[]): void {
  if (Array.isArray(value)) {
    for (const item of value) decodePayloads(item, sink);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "data" && typeof child === "string" && /^[A-Za-z0-9+/=]+$/u.test(child)) {
      sink.push(maybeDecompress(Buffer.from(child, "base64")));
    } else {
      decodePayloads(child, sink);
    }
  }
}

function scanTemporal(
  container: string,
  limit: number,
  needles: Needle[],
  errors: string[],
): { hits: Hit[]; workflows: number } {
  const temporal = (args: string[]) =>
    Bun.spawnSync(
      ["docker", "exec", container, "temporal", ...args, "--address", "127.0.0.1:7233"],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      },
    );
  const listed = temporal(["workflow", "list", "-o", "json", "--limit", String(limit)]);
  if (listed.exitCode !== 0) {
    errors.push(`temporal workflow list: ${listed.stderr.toString().slice(0, 300)}`);
    return { hits: [], workflows: 0 };
  }
  let executions: { execution?: { workflowId?: string; runId?: string } }[] = [];
  try {
    const text = listed.stdout.toString().trim();
    executions = text.startsWith("[")
      ? JSON.parse(text)
      : text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
  } catch (error) {
    errors.push(`temporal workflow list output: ${(error as Error).message}`);
  }
  const hits: Hit[] = [];
  let workflows = 0;
  for (const row of executions) {
    const workflowId = row.execution?.workflowId;
    const runId = row.execution?.runId;
    if (!workflowId) continue;
    const shown = temporal([
      "workflow",
      "show",
      "-w",
      workflowId,
      ...(runId ? ["-r", runId] : []),
      "-o",
      "json",
    ]);
    if (shown.exitCode !== 0) {
      errors.push(`temporal workflow show ${workflowId}: ${shown.stderr.toString().slice(0, 200)}`);
      continue;
    }
    workflows += 1;
    const raw = Buffer.from(shown.stdout);
    const decoded: Buffer[] = [raw];
    try {
      decodePayloads(JSON.parse(raw.toString()), decoded);
    } catch {}
    hits.push(...scanBuffer(`temporal:${workflowId}`, Buffer.concat(decoded), needles));
  }
  return { hits, workflows };
}

function* walk(root: string): Generator<string> {
  if (!existsSync(root)) return;
  const stat = statSync(root);
  if (stat.isFile()) {
    yield root;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

async function scanObjectStorage(
  envFile: string,
  needles: Needle[],
  errors: string[],
): Promise<{ hits: Hit[]; objects: number }> {
  const env = readEnvFile(envFile);
  const endpoint = env.OPENGENI_OBJECT_STORAGE_ENDPOINT;
  const bucket = env.OPENGENI_OBJECT_STORAGE_BUCKET;
  if (!endpoint || !bucket || !env.OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID) {
    errors.push(`object storage: ${envFile} has no OPENGENI_OBJECT_STORAGE_* settings`);
    return { hits: [], objects: 0 };
  }
  const client = new Bun.S3Client({
    endpoint,
    bucket,
    region: env.OPENGENI_OBJECT_STORAGE_REGION || "garage",
    accessKeyId: env.OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY ?? "",
    virtualHostedStyle: env.OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE === "false",
  });
  const hits: Hit[] = [];
  let objects = 0;
  let continuationToken: string | undefined;
  try {
    do {
      const page = await client.list({
        maxKeys: 1000,
        ...(continuationToken ? { continuationToken } : {}),
      });
      for (const object of page.contents ?? []) {
        objects += 1;
        if ((object.size ?? 0) > MAX_OBJECT_BYTES) {
          errors.push(`skipped object ${object.key}: ${object.size} bytes is over the cap`);
          continue;
        }
        const data = Buffer.from(await client.file(object.key).arrayBuffer());
        hits.push(...scanBuffer(`object:${bucket}/${object.key}`, maybeDecompress(data), needles));
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
  } catch (error) {
    errors.push(`object storage: ${(error as Error).message.slice(0, 300)}`);
  }
  return { hits, objects };
}

/** Sweep sources of one localstack stack: its Postgres, logs, units, Temporal and storage. */
export function stackSweepSources(
  stack: StackState,
): Pick<
  SweepOptions,
  "dbUrls" | "logs" | "journalUnits" | "temporalContainer" | "objectStorageEnv"
> {
  const logs = [stack.log];
  const logDir = join(localstackDir(), "logs");
  for (const file of existsSync(logDir) ? readdirSync(logDir) : []) {
    if (file.startsWith(`${stack.name}-`)) logs.push(join(logDir, file));
  }
  return {
    dbUrls: stack.pgUrl ? [stack.pgUrl] : [],
    logs,
    journalUnits: stackJournalUnits(stack.name),
    temporalContainer: `${stack.composeProject}-temporal-1`,
    objectStorageEnv: join(stack.worktree, ".env"),
  };
}

function stackJournalUnits(name: string): string[] {
  const result = Bun.spawnSync(
    ["systemctl", "--user", "list-units", "--all", "--plain", "--no-legend", `f598-*${name}*`],
    { stdout: "pipe", stderr: "ignore" },
  );
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u)[0] ?? "")
    .filter((unit) => unit.endsWith(".service"));
}

async function main(): Promise<number> {
  const { values: flags } = parseArgs({
    options: {
      stack: { type: "string" },
      db: { type: "string", multiple: true },
      "only-db": { type: "boolean", default: false },
      canaries: { type: "string" },
      allow: { type: "string", multiple: true },
      log: { type: "string", multiple: true },
      dir: { type: "string", multiple: true },
      "key-name": { type: "string", multiple: true },
      "temporal-container": { type: "string" },
      "temporal-limit": { type: "string", default: "200" },
      "no-temporal": { type: "boolean", default: false },
      "object-storage-env": { type: "string" },
      "no-object-storage": { type: "boolean", default: false },
      out: { type: "string" },
      "expect-hits": { type: "boolean", default: false },
    },
  });
  const values = loadKnownValues({
    file: flags.canaries,
    json: process.env.SECRETS_SWEEP_CANARIES_JSON,
  });
  if (values.length === 0) {
    console.error("no known values: pass --canaries <file> or SECRETS_SWEEP_CANARIES_JSON");
    return 2;
  }
  const dbUrls = [...(flags.db ?? [])];
  const logs = [...(flags.log ?? [])];
  const journalUnits: string[] = [];
  let temporalContainer = flags["temporal-container"];
  let objectStorageEnv = flags["object-storage-env"];
  if (flags.stack) {
    const stack = loadStack(flags.stack);
    if (!stack) {
      console.error(`stack ${flags.stack} has no state file under ${localstackDir()}/run`);
      return 2;
    }
    const sources = stackSweepSources(stack);
    dbUrls.push(...sources.dbUrls);
    logs.push(...sources.logs);
    journalUnits.push(...sources.journalUnits);
    temporalContainer ??= sources.temporalContainer;
    objectStorageEnv ??= sources.objectStorageEnv;
  }
  if (flags["no-temporal"]) temporalContainer = undefined;
  if (flags["no-object-storage"]) objectStorageEnv = undefined;
  const report = await runSweep({
    values,
    keyNames: flags["key-name"] ?? [],
    dbUrls,
    allDatabases: !flags["only-db"],
    logs,
    journalUnits,
    dirs: flags.dir ?? [],
    temporalContainer,
    temporalLimit: Number(flags["temporal-limit"]),
    objectStorageEnv,
    allow: (flags.allow ?? []).map(parseAllowRule),
    log: (line) => console.log(line),
  });
  if (flags.out) {
    mkdirSync(dirname(flags.out), { recursive: true });
    writeFileSync(flags.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  for (const hit of report.hits) {
    console.log(`HIT ${hit.label} (${hit.encoding}) x${hit.count} at ${hit.location}`);
  }
  for (const hit of report.allowed) {
    console.log(
      `allowed ${hit.label} (${hit.encoding}) x${hit.count} at ${hit.location}: ${hit.reason}`,
    );
  }
  for (const error of report.errors) console.log(`error: ${error}`);
  console.log(
    `sweep: ${report.labels.length} labels, ${report.hits.length} unexpected hit groups, ${report.allowed.length} allowed; coverage ${JSON.stringify(report.coverage)}`,
  );
  if (flags["expect-hits"]) {
    const ok = report.missingLabels.length === 0;
    console.log(
      ok
        ? "detection self-test: every planted value was found"
        : `detection self-test FAILED: not found: ${report.missingLabels.join(", ")}`,
    );
    return ok ? 0 : 1;
  }
  console.log(report.clean ? "sweep CLEAN" : "sweep FOUND LEAKS");
  return report.clean ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`sweep error: ${(error as Error).message}`);
    process.exit(2);
  }
}
