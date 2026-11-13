// Operator CLI for Nango-backed integrations. See docs/nango.md.
//
//   bun scripts/operator/nango.ts show
//   bun scripts/operator/nango.ts set --key gmail --backend nango --provider-config-key google-mail \
//     [--definition definition.json] [--disabled] --operator <name> --reason <reason>
//   bun scripts/operator/nango.ts affected --key gmail [--out affected.csv]
//   bun scripts/operator/nango.ts usage [--since 2026-11-01] [--until 2026-12-01] [--account <uuid>] [--out usage.csv]
//   bun scripts/operator/nango.ts orphans [--key gmail] [--out orphans.csv] [--delete [--include-untagged] --operator <name> --reason <reason>]
import { parseArgs } from "node:util";
import { dbSearchPath, getSettings } from "@opengeni/config";
import { NangoClient, planNangoOrphans } from "@opengeni/capabilities";
import { NANGO_TAG } from "@opengeni/contracts";
import { createDb, listNangoAffectedConnections, summarizeNangoUsage } from "@opengeni/db";
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
    delete: { type: "boolean" },
    "include-untagged": { type: "boolean" },
  },
});

const usage = "Usage: nango.ts show | set | affected | usage | orphans (see docs/nango.md)";
if (!command || !["show", "set", "affected", "usage", "orphans"].includes(command))
  throw new Error(usage);

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
      "nango_connection_id",
    ]);
  } else if (command === "orphans") {
    // Nango connections no live Opengeni connection stands for (left behind by
    // a workspace, organization or member removal, a flip back, or made
    // outside Opengeni). Nango bills them until they are deleted.
    if (!settings.nangoSecretKey) throw new Error("Set OPENGENI_NANGO_SECRET_KEY");
    if (
      values.delete &&
      (!values.operator?.trim() || !values.reason || values.reason.trim().length < 6)
    )
      throw new Error("--delete needs --operator and --reason (at least six characters)");
    const nango = new NangoClient({
      secretKey: settings.nangoSecretKey,
      ...(settings.nangoApiBaseUrl ? { baseUrl: settings.nangoApiBaseUrl } : {}),
    });
    const remote = await nango.listAllConnections();
    const revisions = (await client.db.execute(
      sql`select integration_key, nango_provider_config_key from integration_backend_revisions`,
    )) as unknown as Array<{ integration_key: string; nango_provider_config_key: string | null }>;
    const keys = new Set<string>(revisions.map((row) => row.integration_key));
    for (const connection of remote) {
      const tagged = connection.tags[NANGO_TAG.integrationKey];
      if (tagged) keys.add(tagged);
    }
    if (values.key) {
      keys.clear();
      keys.add(values.key);
    }
    const live = new Set<string>();
    for (const key of keys)
      for (const row of await listNangoAffectedConnections(client.db, key))
        if (row.backend === "nango" && row.status !== "revoked" && row.nangoConnectionId)
          live.add(row.nangoConnectionId);
    const orphans = planNangoOrphans({
      remote,
      liveNangoConnectionIds: live,
      integration: values.key
        ? {
            key: values.key,
            providerConfigKeys: new Set(
              revisions
                .filter((row) => row.integration_key === values.key)
                .flatMap((row) =>
                  row.nango_provider_config_key ? [row.nango_provider_config_key] : [],
                ),
            ),
          }
        : undefined,
      now: Date.now(),
      includeUntagged: values["include-untagged"] === true,
    });
    const deleted = new Set<string>();
    if (values.delete)
      for (const orphan of orphans) {
        if (orphan.action !== "delete") continue;
        await nango.deleteConnection(orphan.connectionId, orphan.providerConfigKey);
        deleted.add(orphan.connectionId);
      }
    await emit(
      orphans.map((orphan) => ({
        nango_connection_id: orphan.connectionId,
        provider_config_key: orphan.providerConfigKey,
        integration_key: orphan.tags[NANGO_TAG.integrationKey] ?? null,
        organization_id: orphan.tags[NANGO_TAG.organizationId] ?? null,
        workspace_id: orphan.tags[NANGO_TAG.workspaceId] ?? null,
        user_id: orphan.tags[NANGO_TAG.endUserId] ?? null,
        created_at: orphan.createdAt,
        opengeni_tagged: Boolean(orphan.tags[NANGO_TAG.attemptId]),
        action: values.delete ? orphan.action : `would_${orphan.action}`,
        deleted: deleted.has(orphan.connectionId),
      })),
      [
        "nango_connection_id",
        "provider_config_key",
        "integration_key",
        "organization_id",
        "workspace_id",
        "user_id",
        "created_at",
        "opengeni_tagged",
        "action",
        "deleted",
      ],
    );
    if (values.delete)
      console.error(
        JSON.stringify({
          deleted: deleted.size,
          operator: values.operator!.trim(),
          reason: values.reason!.trim(),
        }),
      );
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
