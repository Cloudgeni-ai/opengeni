import {
  EditableArtifactLiveOutboxDispatcher,
  MathEditableArtifactOutboxRandom,
  SystemEditableArtifactLiveClock,
  SystemEditableArtifactLiveScheduler,
  type EditableArtifactOutboxDispatcherOptions,
  type EditableArtifactOutboxLoggerPort,
  type EditableArtifactOutboxMetricsPort,
  type EditableArtifactOutboxDispatcherStorePort,
  type EditableArtifactLiveOutboxRecord,
} from "@opengeni/core";
import {
  PostgresEditableArtifactStore,
  createDb,
  dbSql,
  type Database,
  type DbClient,
} from "@opengeni/db";

import {
  connectEditableArtifactHintBroker,
  type ConfirmedNatsEditableArtifactHintBroker,
  type EditableArtifactHintNatsAuth,
} from "./editable-artifact-hint-broker";
import {
  UnsafeDatabaseRolePostureError,
  settleReadinessCheck,
  type ReadinessCheckResult,
} from "./readiness-checks";

export const EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE =
  "opengeni_artifact_outbox_dispatcher";
export const EDITABLE_ARTIFACT_OUTBOX_DATABASE_URL_ENV = "OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL";

/** Independent readiness probes; each names its own failure. */
export type EditableArtifactOutboxReadinessChecks = Readonly<{
  databaseRole: ReadinessCheckResult;
  nats: ReadinessCheckResult;
}>;

export type EditableArtifactOutboxWorkerOptions = Readonly<{
  /** Must authenticate as the dedicated dispatcher role, never the generic app role. */
  dispatcherDatabaseUrl: string;
  databaseSearchPath?: string;
  databasePoolSize?: number;
  /** Unset → decided from the URL; see `CreateDbOptions.preparedStatements`. */
  databasePreparedStatements?: boolean;
  natsUrl: string;
  natsAuth: EditableArtifactHintNatsAuth;
  owner?: string;
  dispatcher?: Omit<EditableArtifactOutboxDispatcherOptions, "owner">;
  metrics?: EditableArtifactOutboxMetricsPort;
  logger?: EditableArtifactOutboxLoggerPort;
}>;

/** Explicit lifecycle handle; hosts supervise `start()` and await `stop()` on drain. */
export class EditableArtifactOutboxWorkerRuntime {
  private readonly abort = new AbortController();
  private running: Promise<void> | null = null;
  private closing: Promise<void> | null = null;

  constructor(
    readonly dispatcher: EditableArtifactLiveOutboxDispatcher,
    private readonly broker: ConfirmedNatsEditableArtifactHintBroker,
    private readonly database: DbClient,
  ) {}

  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Artifact outbox worker is stopping"));
    this.running ??= this.dispatcher.run(this.abort.signal);
    return this.running;
  }

  drain(): boolean {
    if (this.abort.signal.aborted) return false;
    this.abort.abort();
    return true;
  }

  async check(signal?: AbortSignal): Promise<EditableArtifactOutboxReadinessChecks> {
    if (this.abort.signal.aborted || this.closing) {
      throw new Error("Artifact outbox worker is stopping");
    }
    const [databaseRole, nats] = await Promise.all([
      settleReadinessCheck(
        () => assertDedicatedOutboxDispatcherDatabaseRole(this.database.db),
        signal,
      ),
      settleReadinessCheck(() => this.broker.check(signal), signal),
    ]);
    return { databaseRole, nats };
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.stopOnce();
    return this.closing;
  }

  private async stopOnce(): Promise<void> {
    this.drain();
    const running = this.running ? await Promise.allSettled([this.running]) : [];
    const cleanup = await Promise.allSettled([this.broker.close(), this.database.close()]);
    const failure = [...running, ...cleanup].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }
}

/**
 * Production composition. DB grants make the role a narrow capability: it can
 * execute only lease-fenced dispatcher functions and cannot read artifact rows.
 */
export async function createEditableArtifactOutboxWorker(
  options: EditableArtifactOutboxWorkerOptions,
): Promise<EditableArtifactOutboxWorkerRuntime> {
  const dispatcherDatabaseUrl = dedicatedDispatcherDatabaseUrl(options.dispatcherDatabaseUrl);
  const databasePoolSize = options.databasePoolSize ?? 2;
  if (!Number.isSafeInteger(databasePoolSize) || databasePoolSize < 1 || databasePoolSize > 8) {
    throw new TypeError("Artifact outbox dispatcher DB pool size must be 1-8");
  }
  const database = createDb(dispatcherDatabaseUrl, {
    max: databasePoolSize,
    ...(options.databaseSearchPath ? { searchPath: options.databaseSearchPath } : {}),
    ...(options.databasePreparedStatements === undefined
      ? {}
      : { preparedStatements: options.databasePreparedStatements }),
  });
  let broker: ConfirmedNatsEditableArtifactHintBroker;
  try {
    await assertDedicatedOutboxDispatcherDatabaseRole(database.db);
    broker = await connectEditableArtifactHintBroker({
      natsUrl: options.natsUrl,
      auth: options.natsAuth,
    });
  } catch (error) {
    await database.close();
    throw error;
  }
  const persistence = new PostgresEditableArtifactStore(database.db);
  const store = dispatcherStore(persistence);
  const dispatcher = new EditableArtifactLiveOutboxDispatcher(
    {
      store,
      broker,
      clock: new SystemEditableArtifactLiveClock(),
      scheduler: new SystemEditableArtifactLiveScheduler(),
      random: new MathEditableArtifactOutboxRandom(),
      ...(options.metrics ? { metrics: options.metrics } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    },
    {
      owner: options.owner ?? `artifact-outbox:${crypto.randomUUID()}`,
      ...options.dispatcher,
    },
  );
  return new EditableArtifactOutboxWorkerRuntime(dispatcher, broker, database);
}

/**
 * Verify the database identity and its negative capability at runtime. A DSN
 * username check alone is insufficient because PostgreSQL role inheritance,
 * SET ROLE, or a mis-provisioned grant could otherwise widen this worker.
 *
 * Relations owned by an installed extension (for example the PUBLIC-readable
 * pg_stat_statements views) are not Opengeni data and do not count; any other
 * accessible relation or sequence is named in the error so an operator can
 * revoke the grant without guessing.
 */
export async function assertDedicatedOutboxDispatcherDatabaseRole(db: Database): Promise<void> {
  const raw = await db.execute<{
    current_role: string;
    session_role: string;
    accessible_relations: string[];
  }>(dbSql`
    select
      current_user::text as current_role,
      session_user::text as session_role,
      coalesce(
        (
          select array_agg(accessible.name order by accessible.name)
          from (
            select format('%I.%I', namespace_row.nspname, relation_row.relname) as name
            from pg_catalog.pg_class relation_row
            join pg_catalog.pg_namespace namespace_row
              on namespace_row.oid = relation_row.relnamespace
            where namespace_row.nspname = current_schema()
              and relation_row.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
              and not exists (
                select 1
                from pg_catalog.pg_depend extension_member
                where extension_member.classid = 'pg_catalog.pg_class'::regclass
                  and extension_member.objid = relation_row.oid
                  and extension_member.refclassid = 'pg_catalog.pg_extension'::regclass
                  and extension_member.deptype = 'e'
              )
              and (
                (
                  relation_row.relkind <> 'S'
                  and (
                    has_table_privilege(current_user, relation_row.oid, 'SELECT')
                    or has_table_privilege(current_user, relation_row.oid, 'INSERT')
                    or has_table_privilege(current_user, relation_row.oid, 'UPDATE')
                    or has_table_privilege(current_user, relation_row.oid, 'DELETE')
                    or has_table_privilege(current_user, relation_row.oid, 'TRUNCATE')
                    or has_table_privilege(current_user, relation_row.oid, 'REFERENCES')
                    or has_table_privilege(current_user, relation_row.oid, 'TRIGGER')
                    or has_any_column_privilege(current_user, relation_row.oid, 'SELECT')
                    or has_any_column_privilege(current_user, relation_row.oid, 'INSERT')
                    or has_any_column_privilege(current_user, relation_row.oid, 'UPDATE')
                    or has_any_column_privilege(current_user, relation_row.oid, 'REFERENCES')
                  )
                )
                or (
                  relation_row.relkind = 'S'
                  and (
                    has_sequence_privilege(current_user, relation_row.oid, 'USAGE')
                    or has_sequence_privilege(current_user, relation_row.oid, 'SELECT')
                    or has_sequence_privilege(current_user, relation_row.oid, 'UPDATE')
                  )
                )
              )
            order by 1
            limit ${MAX_REPORTED_RELATIONS + 1}
          ) accessible
        ),
        '{}'::text[]
      ) as accessible_relations
  `);
  const rows = Array.isArray(raw) ? raw : ((raw as unknown as { rows?: unknown[] }).rows ?? []);
  const row = rows[0] as
    | {
        current_role?: unknown;
        session_role?: unknown;
        accessible_relations?: unknown;
      }
    | undefined;
  const violations: string[] = [];
  if (
    row?.current_role !== EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE ||
    row.session_role !== EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE
  ) {
    violations.push(
      `connected as role ${describeRole(row?.current_role)} (session role ${describeRole(row?.session_role)}), expected ${EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE}`,
    );
  }
  const accessible = textArray(row?.accessible_relations);
  if (accessible === null) {
    violations.push("relation access could not be verified");
  } else if (accessible.length > 0) {
    const named = accessible.slice(0, MAX_REPORTED_RELATIONS).join(", ");
    const more = accessible.length > MAX_REPORTED_RELATIONS ? " and more" : "";
    violations.push(
      `it can directly access ${named}${more}; revoke those privileges (including grants to PUBLIC) or move the relations out of the dispatcher's schema`,
    );
  }
  if (violations.length > 0) {
    throw new UnsafeDatabaseRolePostureError("Artifact outbox dispatcher", violations);
  }
}

const MAX_REPORTED_RELATIONS = 5;

function describeRole(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function textArray(value: unknown): string[] | null {
  // Anything other than a decoded text[] fails closed as "could not be verified".
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

function dispatcherStore(
  persistence: PostgresEditableArtifactStore,
): EditableArtifactOutboxDispatcherStorePort {
  return {
    claimLiveOutbox: async (input) =>
      (await persistence.claimLiveOutbox(
        input,
      )) as unknown as readonly EditableArtifactLiveOutboxRecord[],
    renewLiveOutbox: async (input) => await persistence.renewLiveOutbox(input),
    markLiveOutboxPublished: async (input) => await persistence.markLiveOutboxPublished(input),
    retryLiveOutbox: async (input) => await persistence.retryLiveOutbox(input),
    deadLetterLiveOutbox: async (input) => await persistence.deadLetterLiveOutbox(input),
  };
}

export function dedicatedDispatcherDatabaseUrl(raw: string): string {
  if (typeof raw !== "string" || raw.length > 8_192 || raw.trim() !== raw) {
    throw new TypeError(`${EDITABLE_ARTIFACT_OUTBOX_DATABASE_URL_ENV} is malformed`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new TypeError(`${EDITABLE_ARTIFACT_OUTBOX_DATABASE_URL_ENV} is malformed`, { cause });
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    decodeURIComponent(url.username) !== EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE
  ) {
    throw new TypeError(
      `${EDITABLE_ARTIFACT_OUTBOX_DATABASE_URL_ENV} must authenticate as ${EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE}`,
    );
  }
  return raw;
}
