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

export const EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE =
  "opengeni_artifact_outbox_dispatcher";
export const EDITABLE_ARTIFACT_OUTBOX_DATABASE_URL_ENV = "OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL";

export type EditableArtifactOutboxWorkerOptions = Readonly<{
  /** Must authenticate as the dedicated dispatcher role, never the generic app role. */
  dispatcherDatabaseUrl: string;
  databaseSearchPath?: string;
  databasePoolSize?: number;
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

  async check(signal?: AbortSignal): Promise<void> {
    if (this.abort.signal.aborted || this.closing) {
      throw new Error("Artifact outbox worker is stopping");
    }
    await Promise.all([
      assertDedicatedOutboxDispatcherDatabaseRole(this.database.db),
      this.broker.check(signal),
    ]);
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
 */
export async function assertDedicatedOutboxDispatcherDatabaseRole(db: Database): Promise<void> {
  const raw = await db.execute<{
    current_role: string;
    session_role: string;
    can_access_any_relation: boolean;
    can_access_any_sequence: boolean;
  }>(dbSql`
    select
      current_user::text as current_role,
      session_user::text as session_role,
      exists (
        select 1
        from pg_catalog.pg_class relation_row
        join pg_catalog.pg_namespace namespace_row
          on namespace_row.oid = relation_row.relnamespace
        where namespace_row.nspname = current_schema()
          and relation_row.relkind in ('r', 'p', 'v', 'm', 'f')
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
      ) as can_access_any_relation,
      exists (
        select 1
        from pg_catalog.pg_class sequence_row
        join pg_catalog.pg_namespace namespace_row
          on namespace_row.oid = sequence_row.relnamespace
        where namespace_row.nspname = current_schema()
          and sequence_row.relkind = 'S'
          and (
            has_sequence_privilege(current_user, sequence_row.oid, 'USAGE')
            or has_sequence_privilege(current_user, sequence_row.oid, 'SELECT')
            or has_sequence_privilege(current_user, sequence_row.oid, 'UPDATE')
          )
      ) as can_access_any_sequence
  `);
  const rows = Array.isArray(raw) ? raw : ((raw as unknown as { rows?: unknown[] }).rows ?? []);
  const row = rows[0] as
    | {
        current_role?: unknown;
        session_role?: unknown;
        can_access_any_relation?: unknown;
        can_access_any_sequence?: unknown;
      }
    | undefined;
  if (
    row?.current_role !== EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE ||
    row.session_role !== EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE ||
    row.can_access_any_relation !== false ||
    row.can_access_any_sequence !== false
  ) {
    throw new Error("Artifact outbox dispatcher database connection has an unsafe role posture");
  }
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
