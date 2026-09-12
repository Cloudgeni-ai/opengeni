import { createHmac, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { stableJson } from "@opengeni/contracts";
import {
  HostMcpResolver,
  HostMcpResolverSource,
  PutHostMcpResolverRequest,
  RevokeHostMcpResolverRequest,
} from "@opengeni/contracts/host-mcp-resolvers";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { encryptEnvironmentValue, decryptEnvironmentValue } from "./environment-crypto";

export class HostMcpResolverError extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
type Actor = { accountId: string; subjectId: string };
type Row = {
  id: string;
  account_id: string;
  external_source: string;
  url: string;
  secret_encrypted: string;
  timeout_ms: number;
  generation: number | string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
};
const project = (row: Row): HostMcpResolver =>
  HostMcpResolver.parse({
    id: row.id,
    organizationId: row.account_id,
    externalSource: row.external_source,
    url: row.url,
    timeoutMs: row.timeout_ms,
    generation: Number(row.generation),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });

/** Caller proves service-key provenance at the public authentication boundary.
 * Recheck the exact live key under lock, including receipt replay. */
async function administered<T>(
  db: Database,
  actor: Actor,
  use: (tx: Database) => Promise<T>,
): Promise<T> {
  return withRlsContext(db, { accountId: actor.accountId, workspaceId: null }, async (tx) => {
    await setSubjectRlsContext(tx, actor.subjectId);
    const [key] = await rawRows(
      tx,
      sql`select id from api_keys where account_id = ${actor.accountId}::uuid
      and 'api_key:' || id::text = ${actor.subjectId} and workspace_id is null and credential_kind = 'organization'
      and revoked_at is null and (expires_at is null or expires_at > clock_timestamp())
      and permissions ? 'account:admin' for share`,
    );
    if (!key) throw new HostMcpResolverError(403, "organization service administration required");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`host-mcp-resolvers:${actor.accountId}`}, 0))`,
    );
    return use(tx);
  });
}

export async function getHostMcpResolver(
  db: Database,
  actor: Actor,
  source: string,
): Promise<HostMcpResolver> {
  const externalSource = HostMcpResolverSource.parse(source);
  return administered(db, actor, async (tx) => {
    const [row] = await rawRows<Row>(
      tx,
      sql`select * from host_mcp_resolvers where account_id = ${actor.accountId}::uuid and external_source = ${externalSource}`,
    );
    if (!row) throw new HostMcpResolverError(404, "resolver unavailable");
    return project(row);
  });
}

export async function mutateHostMcpResolver(
  db: Database,
  actor: Actor,
  input: {
    externalSource: string;
    encryptionKey: Uint8Array;
    legacyConfigured: boolean;
  } & (
    | { kind: "put"; request: PutHostMcpResolverRequest }
    | { kind: "revoke"; request: RevokeHostMcpResolverRequest }
  ),
): Promise<HostMcpResolver> {
  const externalSource = HostMcpResolverSource.parse(input.externalSource);
  const putRequest = input.kind === "put" ? PutHostMcpResolverRequest.parse(input.request) : null;
  const operation = putRequest ?? RevokeHostMcpResolverRequest.parse(input.request);
  const digest = createHmac("sha256", input.encryptionKey)
    .update("opengeni:host-mcp-resolver-operation:v1\0")
    .update(stableJson({ actor, externalSource, kind: input.kind, request: operation }))
    .digest("hex");
  return administered(db, actor, async (tx) => {
    const [receipt] = await rawRows<{ request_digest: string; result: unknown }>(
      tx,
      sql`select request_digest, result from host_mcp_resolver_operations
      where account_id = ${actor.accountId}::uuid and operation_id = ${operation.operationId}::uuid`,
    );
    if (receipt) {
      if (receipt.request_digest !== digest)
        throw new HostMcpResolverError(409, "resolver operation conflicts");
      // Return historical metadata only; never restore old configuration or secrets.
      return HostMcpResolver.parse(receipt.result);
    }
    const [current] = await rawRows<Row>(
      tx,
      sql`select * from host_mcp_resolvers where account_id = ${actor.accountId}::uuid and external_source = ${externalSource} for update`,
    );
    if ((current ? Number(current.generation) : 0) !== operation.expectedGeneration)
      throw new HostMcpResolverError(409, "resolver generation changed");
    let row: Row | undefined;
    if (putRequest) {
      const request = putRequest;
      const [existing] = await rawRows(
        tx,
        sql`select id from host_mcp_resolvers where account_id = ${actor.accountId}::uuid limit 1`,
      );
      if (!existing && input.legacyConfigured && !request.acknowledgeLegacyRoutingReplacement)
        throw new HostMcpResolverError(
          409,
          "first registration requires explicit legacy routing replacement acknowledgement",
        );
      const id = current?.id ?? randomUUID();
      const generation = request.expectedGeneration + 1;
      const encrypted = encryptEnvironmentValue(
        input.encryptionKey,
        JSON.stringify({
          version: 1,
          id,
          accountId: actor.accountId,
          externalSource,
          generation,
          url: request.url,
          bearerToken: request.bearerToken,
        }),
      );
      [row] = current
        ? await rawRows<Row>(
            tx,
            sql`update host_mcp_resolvers set url = ${request.url}, secret_encrypted = ${encrypted}, timeout_ms = ${request.timeoutMs}, generation = ${generation}, status = 'active', updated_at = clock_timestamp() where id = ${id}::uuid returning *`,
          )
        : await rawRows<Row>(
            tx,
            sql`insert into host_mcp_resolvers (id, account_id, external_source, url, secret_encrypted, timeout_ms, generation, status) values (${id}::uuid, ${actor.accountId}::uuid, ${externalSource}, ${request.url}, ${encrypted}, ${request.timeoutMs}, 1, 'active') returning *`,
          );
    } else {
      if (!current) throw new HostMcpResolverError(404, "resolver unavailable");
      [row] = await rawRows<Row>(
        tx,
        sql`update host_mcp_resolvers set status = 'revoked', generation = generation + 1, updated_at = clock_timestamp() where id = ${current.id}::uuid returning *`,
      );
    }
    if (!row) throw new Error("resolver mutation unavailable");
    const result = project(row);
    await tx.execute(sql`insert into host_mcp_resolver_operations (account_id, operation_id, actor_subject_id, request_digest, result)
      values (${actor.accountId}::uuid, ${operation.operationId}::uuid, ${actor.subjectId}, ${digest}, ${JSON.stringify(result)}::jsonb)`);
    return result;
  });
}

export type HostMcpResolverRoute =
  | { mode: "legacy" }
  | { mode: "denied" }
  | {
      mode: "namespace";
      id: string;
      generation: number;
      accountId: string;
      workspaceId: string;
      externalSource: string;
      url: string;
      bearerToken: string;
      timeoutMs: number;
    };
/** Runtime lookup, not tool authority. Failure must never be interpreted as legacy. */
export async function resolveHostMcpResolverRoute(
  db: Database,
  input: { accountId: string; workspaceId: string },
  encryptionKey: Uint8Array | null,
): Promise<HostMcpResolverRoute> {
  return withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const [workspace] = await rawRows<{ external_source: string | null }>(
        tx,
        sql`select external_source from workspaces where id = ${input.workspaceId}::uuid and account_id = ${input.accountId}::uuid`,
      );
      if (!workspace) return { mode: "denied" };
      const [any] = await rawRows(
        tx,
        sql`select id from host_mcp_resolvers where account_id = ${input.accountId}::uuid limit 1`,
      );
      if (!any) return { mode: "legacy" };
      if (!workspace.external_source || !encryptionKey) return { mode: "denied" };
      const [row] = await rawRows<Row>(
        tx,
        sql`select * from host_mcp_resolvers where account_id = ${input.accountId}::uuid and external_source = ${workspace.external_source} and status = 'active'`,
      );
      if (!row) return { mode: "denied" };
      const bundle = JSON.parse(decryptEnvironmentValue(encryptionKey, row.secret_encrypted));
      if (
        bundle.version !== 1 ||
        bundle.id !== row.id ||
        bundle.accountId !== input.accountId ||
        bundle.externalSource !== workspace.external_source ||
        bundle.generation !== Number(row.generation) ||
        bundle.url !== row.url ||
        typeof bundle.bearerToken !== "string" ||
        !bundle.bearerToken ||
        /[\r\n]/u.test(bundle.bearerToken)
      )
        throw new Error("resolver secret binding invalid");
      return {
        mode: "namespace",
        id: row.id,
        generation: Number(row.generation),
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        externalSource: workspace.external_source,
        url: row.url,
        bearerToken: bundle.bearerToken,
        timeoutMs: row.timeout_ms,
      };
    },
  );
}

export async function hostMcpResolverRouteIsCurrent(
  db: Database,
  input: { accountId: string; workspaceId: string },
  route: HostMcpResolverRoute,
): Promise<boolean> {
  if (route.mode === "denied") return false;
  return withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const [row] =
        route.mode === "legacy"
          ? await rawRows(
              tx,
              sql`select w.id from workspaces w where w.id = ${input.workspaceId}::uuid and w.account_id = ${input.accountId}::uuid and not exists (select 1 from host_mcp_resolvers r where r.account_id = w.account_id)`,
            )
          : await rawRows(
              tx,
              sql`select r.id from host_mcp_resolvers r join workspaces w on w.account_id = r.account_id and w.external_source = r.external_source
        where w.id = ${input.workspaceId}::uuid and r.account_id = ${input.accountId}::uuid and r.external_source = ${route.externalSource} and r.id = ${route.id}::uuid and r.generation = ${route.generation} and r.status = 'active'`,
            );
      return Boolean(row);
    },
  );
}
