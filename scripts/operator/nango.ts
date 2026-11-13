// Operator CLI for Nango-backed integrations. See docs/nango.md.
//
//   bun scripts/operator/nango.ts show
//   bun scripts/operator/nango.ts set --key gmail --backend nango --provider-config-key google-mail \
//     [--definition definition.json] [--disabled] --operator <name> --reason <reason>
//   bun scripts/operator/nango.ts affected --key gmail [--out affected.csv]
//   bun scripts/operator/nango.ts usage [--since 2026-11-01] [--until 2026-12-01] [--account <uuid>] [--out usage.csv]
import { parseArgs } from "node:util";
import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb, summarizeNangoUsage } from "@opengeni/db";
import { sql } from "drizzle-orm";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  strict: true,
  options: {
    key: { type: "string" },
    backend: { type: "string" },
    "provider-config-key": { type: "string" },
    definition: { type: "string" },
    disabled: { type: "boolean" },
    operator: { type: "string" },
    reason: { type: "string" },
    out: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    account: { type: "string" },
  },
});

const usage = "Usage: nango.ts show | set | affected | usage (see docs/nango.md)";
if (!command || !["show", "set", "affected", "usage"].includes(command)) throw new Error(usage);

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: Record<string, unknown>[], headers: string[]): string {
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
}

async function emit(rows: Record<string, unknown>[], headers: string[]) {
  const csv = toCsv(rows, headers);
  if (values.out) {
    await Bun.write(values.out, `${csv}\n`);
    console.log(JSON.stringify({ wrote: values.out, rows: rows.length }));
  } else {
    console.log(csv);
  }
}

function requiredKey(): string {
  const key = values.key?.trim();
  if (!key) throw new Error("Provide --key <integration key>, for example gmail");
  return key;
}

function monthStart(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

const settings = getSettings();
const url = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_ADMIN_URL;
if (!url) throw new Error("Set OPENGENI_MIGRATIONS_DATABASE_URL or OPENGENI_DATABASE_ADMIN_URL");
const searchPath = dbSearchPath(settings);
const client = createDb(url, { max: 1, ...(searchPath ? { searchPath } : {}) });
try {
  if (command === "show") {
    const rows = await client.db.execute(
      sql`select * from integration_backends_effective order by integration_key`,
    );
    console.log(JSON.stringify(rows, null, 2));
  } else if (command === "set") {
    const key = requiredKey();
    const backend = values.backend?.trim();
    if (backend !== "native" && backend !== "nango") {
      throw new Error("Provide --backend native or --backend nango");
    }
    if (!values.operator?.trim() || !values.reason || values.reason.trim().length < 6) {
      throw new Error("Provide --operator and --reason (at least six characters)");
    }
    const definition = values.definition ? await Bun.file(values.definition).json() : null;
    const [row] = await client.db.execute(
      sql`select set_integration_backend(
        ${key}, ${backend}, ${values["provider-config-key"] ?? null},
        ${!values.disabled}, ${definition === null ? null : JSON.stringify(definition)}::jsonb,
        ${values.operator.trim()}, ${values.reason.trim()}
      ) as revision`,
    );
    console.log(JSON.stringify({ applied: true, revision: row?.revision }));
  } else if (command === "affected") {
    const key = requiredKey();
    const rows = await client.db.transaction(async (tx) =>
      tx.execute(sql`select * from nango_affected_connections(${key})`),
    );
    await emit(rows as unknown as Record<string, unknown>[], [
      "organization_id",
      "organization_name",
      "workspace_id",
      "workspace_name",
      "user_id",
      "user_email",
      "connection_id",
      "backend",
      "provider_domain",
      "status",
      "account_label",
      "created_at",
      "last_used_at",
    ]);
  } else {
    const until = values.until ? new Date(values.until) : new Date();
    const since = values.since ? new Date(values.since) : monthStart(until);
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
      throw new Error("Provide valid --since < --until dates");
    }
    const summary = await summarizeNangoUsage(client.db, {
      since,
      until,
      ...(values.account ? { accountId: values.account } : {}),
    });
    const usageRows = summary.rows.map((row) => ({
      account_id: row.accountId,
      workspace_id: row.workspaceId,
      integration_key: row.integrationKey,
      subject_id: row.subjectId,
      connection_days: row.connectionDays,
      proxy_requests: row.proxyRequests,
      tool_calls: row.toolCalls,
      request_bytes: row.requestBytes,
      response_bytes: row.responseBytes,
      compute_seconds: row.computeSeconds,
      est_connection_usd: row.estimatedCostUsd.connections,
      est_transfer_usd: row.estimatedCostUsd.transfer,
      est_compute_usd: row.estimatedCostUsd.compute,
      est_total_usd: row.estimatedCostUsd.total,
    }));
    await emit(usageRows, [
      "account_id",
      "workspace_id",
      "integration_key",
      "subject_id",
      "connection_days",
      "proxy_requests",
      "tool_calls",
      "request_bytes",
      "response_bytes",
      "compute_seconds",
      "est_connection_usd",
      "est_transfer_usd",
      "est_compute_usd",
      "est_total_usd",
    ]);
    console.error(
      JSON.stringify({
        since: summary.since,
        until: summary.until,
        totals: summary.totals,
      }),
    );
  }
} finally {
  await client.close();
}
