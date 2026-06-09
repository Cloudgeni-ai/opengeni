import { writeFileSync } from "node:fs";
import { createDb, dbSql } from "@opengeni/db";

const syntheticSessionLabels = [
  "Synthetic historical Modal failure for UI verification",
  "Synthetic archived failed session for web verification",
  "Synthetic terminal-session banner smoke failure",
  "Synthetic failed session for terminal banner verification",
] as const;

const modalFailurePatterns = [
  "%RESOURCE_EXHAUSTED%",
  "%Failed to apply a Modal sandbox manifest%",
  "%ContainerFilesystemExec%",
  "%SandboxTerminate%",
] as const;

type Args = {
  databaseUrl: string;
  outFile: string;
  environment: string;
  modalFailureSince: string | null;
};

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.log([
    "Usage: bun scripts/check-staging-data-hygiene.ts [options]",
    "",
    "Options:",
    "  --database-url <url>             Database URL. Defaults to OPENGENI_DATA_HYGIENE_DATABASE_URL, OPENGENI_MIGRATIONS_DATABASE_URL, or OPENGENI_DATABASE_URL.",
    "  --out-file <path>                Evidence JSON path. Defaults to .agent/generated/staging/data-hygiene.json.",
    "  --environment <name>             Evidence environment label. Defaults to staging.",
    "  --modal-failure-since <iso-time> Fail if Modal resource-exhaustion events exist after this timestamp.",
  ].join("\n"));
  process.exit(0);
}

const args = parseArgs(rawArgs, process.env);
const client = createDb(args.databaseUrl);

try {
  const syntheticRows = await client.db.execute(dbSql`
    select id, workspace_id, initial_message, created_at
    from sessions
    where initial_message = ${syntheticSessionLabels[0]}
      or initial_message = ${syntheticSessionLabels[1]}
      or initial_message = ${syntheticSessionLabels[2]}
      or initial_message = ${syntheticSessionLabels[3]}
    order by created_at desc
  `);
  const modalRows = args.modalFailureSince
    ? await client.db.execute(dbSql`
      select session_id, workspace_id, sequence, type, created_at
      from session_events
      where created_at > ${args.modalFailureSince}::timestamptz
        and (
          payload::text ilike ${modalFailurePatterns[0]}
          or payload::text ilike ${modalFailurePatterns[1]}
          or payload::text ilike ${modalFailurePatterns[2]}
          or payload::text ilike ${modalFailurePatterns[3]}
        )
      order by created_at desc
    `)
    : [];
  const synthetic = rows(syntheticRows);
  const modalFailuresSince = rows(modalRows);
  const failures = [
    ...(synthetic.length > 0 ? [`found ${synthetic.length} synthetic staging fixture session(s)`] : []),
    ...(modalFailuresSince.length > 0 ? [`found ${modalFailuresSince.length} Modal resource-exhaustion event(s) after ${args.modalFailureSince}`] : []),
  ];
  const out = {
    ok: failures.length === 0,
    environment: args.environment,
    checkedAt: new Date().toISOString(),
    syntheticSessionLabels,
    syntheticSessionCount: synthetic.length,
    syntheticSessions: synthetic,
    modalFailureSince: args.modalFailureSince,
    modalFailureCountSince: modalFailuresSince.length,
    modalFailuresSince,
    failures,
  };
  writeFileSync(args.outFile, `${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) {
    console.error(JSON.stringify(out, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(out, null, 2));
} finally {
  await client.close();
}

function rows(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    return result;
  }
  if (result && typeof result === "object" && "rows" in result && Array.isArray((result as { rows: unknown[] }).rows)) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    databaseUrl: env.OPENGENI_DATA_HYGIENE_DATABASE_URL ?? env.OPENGENI_MIGRATIONS_DATABASE_URL ?? env.OPENGENI_DATABASE_URL ?? "",
    outFile: env.OPENGENI_DATA_HYGIENE_OUT_FILE ?? ".agent/generated/staging/data-hygiene.json",
    environment: env.OPENGENI_DATA_HYGIENE_ENVIRONMENT ?? "staging",
    modalFailureSince: env.OPENGENI_DATA_HYGIENE_MODAL_FAILURE_SINCE ?? null,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--database-url") {
      out.databaseUrl = requiredNext(values, ++index, value);
    } else if (value === "--out-file") {
      out.outFile = requiredNext(values, ++index, value);
    } else if (value === "--environment") {
      out.environment = requiredNext(values, ++index, value);
    } else if (value === "--modal-failure-since") {
      out.modalFailureSince = requiredNext(values, ++index, value);
    } else if (value.startsWith("--database-url=")) {
      out.databaseUrl = value.slice("--database-url=".length);
    } else if (value.startsWith("--out-file=")) {
      out.outFile = value.slice("--out-file=".length);
    } else if (value.startsWith("--environment=")) {
      out.environment = value.slice("--environment=".length);
    } else if (value.startsWith("--modal-failure-since=")) {
      out.modalFailureSince = value.slice("--modal-failure-since=".length);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!out.databaseUrl) {
    throw new Error("Set OPENGENI_DATA_HYGIENE_DATABASE_URL, OPENGENI_MIGRATIONS_DATABASE_URL, OPENGENI_DATABASE_URL, or --database-url");
  }
  return out;
}

function requiredNext(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
