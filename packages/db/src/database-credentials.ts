import { readFile } from "node:fs/promises";
import type { Settings } from "@opengeni/config";

/**
 * File-mounted password for the runtime database login, so the password can be
 * rotated while pods keep running, without a restart.
 *
 * PostgreSQL keeps one password per role, and every pool opens new connections
 * all the time (idle timeout, maximum lifetime, growth under load). A password
 * fixed in the connection URL at process start therefore breaks every new
 * connection the moment the role's password changes. With these files the pool
 * reads the password on every connection attempt instead, and during a rotation
 * it holds two candidates: the previous password (still valid until the role
 * changes) and the current one (valid afterwards).
 *
 * Rotation contract for operators (in this order; docs/deployment.md):
 * 1. write previous = old password and current = new password, and confirm
 *    kubelet refreshed the mounted Secret files on every pod (no restart);
 * 2. in one step, change the role's password and update the role
 *    provisioning password and the URL password; each pool switches to the
 *    current password on the first 28P01 of a login that used the previous
 *    one, and logins that were already authenticating with it are refused
 *    without moving the pool again;
 * 3. clear the previous file.
 */
export type DatabasePasswordFiles = {
  /** File holding the current password. Missing or empty: the URL password. */
  currentPasswordFile?: string;
  /** File holding the previous password during a rotation. Missing or empty: none. */
  previousPasswordFile?: string;
};

/**
 * Content-free credential events. They carry candidate indexes and counts only,
 * never a password, a password length or a file's contents.
 */
export type DatabaseCredentialEvent =
  | {
      /** The files changed, so the candidate order starts again at the first. */
      type: "candidates_reloaded";
      candidates: number;
    }
  | {
      /**
       * A login that used candidate `index` was refused with 28P01. `stale`:
       * the pool had already selected another password since that login read
       * its own, so the refusal neither moves the pool nor uses up an
       * operation's attempts.
       */
      type: "candidate_refused";
      index: number;
      candidates: number;
      stale: boolean;
    }
  | {
      /** A 28P01 of a login that used the selected candidate moved the pool to the next one. */
      type: "candidate_switched";
      fromIndex: number;
      toIndex: number;
      candidates: number;
    }
  | {
      /** An operation was refused on every candidate; its 28P01 surfaces. */
      type: "candidates_exhausted";
      index: number;
      candidates: number;
    }
  | {
      /** A configured file exists but could not be read; it is treated as missing. */
      type: "password_file_unreadable";
      file: "current" | "previous";
      code: string;
    };

/**
 * Receives a pool's credential events. `createDb` also says which of its
 * connections the event is about: the query pool or its session-list LISTEN
 * connection (each keeps its own candidate index).
 */
export type DatabaseCredentialEventListener = (
  event: DatabaseCredentialEvent,
  connection?: "pool" | "notifications",
) => void;

type PasswordFileSettings = Partial<
  Pick<Settings, "databasePasswordFile" | "databasePreviousPasswordFile">
>;

/**
 * The runtime login's password files from deployment settings
 * (`OPENGENI_DATABASE_PASSWORD_FILE`, `OPENGENI_DATABASE_PREVIOUS_PASSWORD_FILE`),
 * shaped as `createDb` options. Use only for pools that log in as the runtime
 * role (`OPENGENI_DATABASE_URL`): the files hold that login's password, never a
 * dedicated service role's. Neither setting → `{}` (the URL password, as before).
 */
export function databasePasswordFileOptions(settings: PasswordFileSettings): {
  passwordFiles?: DatabasePasswordFiles;
} {
  const currentPasswordFile = settings.databasePasswordFile?.trim() || undefined;
  const previousPasswordFile = settings.databasePreviousPasswordFile?.trim() || undefined;
  if (!currentPasswordFile && !previousPasswordFile) return {};
  return {
    passwordFiles: {
      ...(currentPasswordFile ? { currentPasswordFile } : {}),
      ...(previousPasswordFile ? { previousPasswordFile } : {}),
    },
  };
}

/** Same as {@link databasePasswordFileOptions} for env-only entry points (CLIs). */
export function databasePasswordFileOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): { passwordFiles?: DatabasePasswordFiles } {
  return databasePasswordFileOptions({
    databasePasswordFile: environment.OPENGENI_DATABASE_PASSWORD_FILE,
    databasePreviousPasswordFile: environment.OPENGENI_DATABASE_PREVIOUS_PASSWORD_FILE,
  });
}

/** A pool's file-backed password source, or undefined for today's URL password. */
export function rotatingDatabasePasswordFor(
  databaseUrl: string,
  passwordFiles: DatabasePasswordFiles | undefined,
  onEvent: DatabaseCredentialEventListener | undefined,
): RotatingDatabasePassword | undefined {
  if (!passwordFiles?.currentPasswordFile && !passwordFiles?.previousPasswordFile) return undefined;
  return new RotatingDatabasePassword({
    files: passwordFiles,
    fallbackPassword: databaseUrlPassword(databaseUrl),
    ...(onEvent ? { onEvent } : {}),
  });
}

/** PostgreSQL `invalid_password`. Raised only while authenticating a new connection. */
export const DATABASE_AUTHENTICATION_FAILURE_SQLSTATE = "28P01";

/**
 * The property under which an error raised while a connection was logging in
 * carries that login attempt's identity: the object the driver also passed to
 * the password function for that attempt. Our postgres.js patch sets it on
 * errors raised before any query ran; the managed-auth `pg` client sets it
 * with {@link tagDatabaseLoginAttempt}.
 */
export const DATABASE_LOGIN_ATTEMPT = Symbol.for("postgres.login");

/** Mark `error` as raised by the login attempt `login`; never throws. */
export function tagDatabaseLoginAttempt(error: unknown, login: object): void {
  if (!error || typeof error !== "object") return;
  try {
    Object.defineProperty(error, DATABASE_LOGIN_ATTEMPT, { value: login, configurable: true });
  } catch {
    // A frozen error simply stays untagged.
  }
}

/** The error and its nested causes, breadth first (bounded, cycle-safe). */
function* errorChain(error: unknown): Generator<Record<PropertyKey, unknown>> {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<PropertyKey, unknown>;
    yield record;
    for (const key of ["cause", "original", "driverError", "error", "errors"] as const) {
      const nested = record[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested !== undefined) queue.push(nested);
    }
  }
}

/** The login attempt that raised `error` (or a nested cause), when the driver tagged it. */
export function databaseLoginAttemptOf(error: unknown): object | undefined {
  for (const record of errorChain(error)) {
    const login = record[DATABASE_LOGIN_ATTEMPT];
    if (login && typeof login === "object") return login;
  }
  return undefined;
}

/** The event's one-line, content-free log message. */
export function databaseCredentialEventMessage(event: DatabaseCredentialEvent): string {
  switch (event.type) {
    case "candidates_reloaded":
      return "reloaded database credential candidates";
    case "candidate_refused":
      return "database credential candidate refused";
    case "candidate_switched":
      return "switched database credential candidate";
    case "candidates_exhausted":
      return "every database credential candidate was rejected";
    case "password_file_unreadable":
      return "database password file unreadable; treating it as missing";
  }
}

/**
 * The log attributes of a credential event: the pool's name and the event's
 * index, count and stale facts, never a password. These names (and their
 * value grammars) are reviewed for the public telemetry boundary in
 * `@opengeni/observability`, which drops any other key from external logs.
 */
export function databaseCredentialEventAttributes(
  pool: string,
  event: DatabaseCredentialEvent,
  connection?: "pool" | "notifications",
): Record<string, string | number | boolean> {
  const databasePool = connection === "notifications" ? `${pool}-notifications` : pool;
  switch (event.type) {
    case "candidates_reloaded":
      return { databasePool, credentialCandidates: event.candidates };
    case "candidate_refused":
      return {
        databasePool,
        credentialIndex: event.index,
        credentialCandidates: event.candidates,
        credentialStale: event.stale,
      };
    case "candidate_switched":
      return {
        databasePool,
        credentialFromIndex: event.fromIndex,
        credentialToIndex: event.toIndex,
        credentialCandidates: event.candidates,
      };
    case "candidates_exhausted":
      return {
        databasePool,
        credentialIndex: event.index,
        credentialCandidates: event.candidates,
      };
    case "password_file_unreadable":
      return { databasePool, credentialFile: event.file, credentialFileErrorCode: event.code };
  }
}

/**
 * One content-free log line per event: the message and
 * {@link databaseCredentialEventAttributes}. Refusals are logged too (their
 * number is bounded by the logins in flight when the password changes).
 * Defaults to `console.warn`, for processes without structured logging (CLIs,
 * scripts).
 */
export function logDatabaseCredentialEvent(
  pool: string,
  log: (message: string, attributes: Record<string, string | number | boolean>) => void = (
    message,
    attributes,
  ) => console.warn(`[database] ${message}`, attributes),
): DatabaseCredentialEventListener {
  return (event, connection) => {
    log(
      databaseCredentialEventMessage(event),
      databaseCredentialEventAttributes(pool, event, connection),
    );
  };
}

/**
 * Prometheus counters of credential events, labelled by pool (`pool`, with a
 * `-notifications` suffix for a LISTEN connection) and candidate index, never
 * by a password. Indexes are positions in the candidate list: 0 is the current
 * file (or the URL password), 1 the previous file.
 */
export const DATABASE_CREDENTIAL_METRICS = {
  /** Labels: pool, index (the refused login's candidate), refusal ("stale" | "fresh"). */
  refusals: {
    name: "opengeni_database_credential_refusals_total",
    help: "Database logins refused with 28P01, by pool, the login's candidate index and whether the pool had already moved past it (stale).",
  },
  /** Labels: pool, from_index, to_index. */
  switches: {
    name: "opengeni_database_credential_switches_total",
    help: "Database pools that moved to the next password candidate after a fresh 28P01, by pool.",
  },
  /** Labels: pool, index (the selected candidate when the operation gave up). */
  exhaustions: {
    name: "opengeni_database_credential_exhaustions_total",
    help: "Database operations whose 28P01 surfaced after every password candidate was refused, by pool.",
  },
  /** Labels: pool, candidates (how many passwords the reloaded files offer). */
  reloads: {
    name: "opengeni_database_credential_reloads_total",
    help: "Database password file changes a pool picked up, by pool and candidate count.",
  },
} as const;

/** The part of an `Observability` that {@link observeDatabaseCredentialEvents} uses. */
export type DatabaseCredentialObserver = {
  warn(message: string, attributes: Record<string, string | number | boolean>): void;
  incrementCounter(input: { name: string; help?: string; labels?: Record<string, string> }): void;
};

function databaseCredentialEventCounter(
  pool: string,
  event: DatabaseCredentialEvent,
): { name: string; help: string; labels: Record<string, string> } | null {
  switch (event.type) {
    case "candidate_refused":
      return {
        ...DATABASE_CREDENTIAL_METRICS.refusals,
        labels: { pool, index: String(event.index), refusal: event.stale ? "stale" : "fresh" },
      };
    case "candidate_switched":
      return {
        ...DATABASE_CREDENTIAL_METRICS.switches,
        labels: { pool, from_index: String(event.fromIndex), to_index: String(event.toIndex) },
      };
    case "candidates_exhausted":
      return {
        ...DATABASE_CREDENTIAL_METRICS.exhaustions,
        labels: { pool, index: String(event.index) },
      };
    case "candidates_reloaded":
      return {
        ...DATABASE_CREDENTIAL_METRICS.reloads,
        labels: { pool, candidates: String(event.candidates) },
      };
    case "password_file_unreadable":
      return null;
  }
}

/**
 * Logs every credential event through `observability.warn` (see
 * {@link logDatabaseCredentialEvent}) and counts refusals, switches,
 * exhaustions and reloads ({@link DATABASE_CREDENTIAL_METRICS}). An observer
 * failure never reaches the pool.
 */
export function observeDatabaseCredentialEvents(
  pool: string,
  observability: DatabaseCredentialObserver,
): DatabaseCredentialEventListener {
  const log = logDatabaseCredentialEvent(pool, (message, attributes) =>
    observability.warn(message, attributes),
  );
  return (event, connection) => {
    try {
      const counter = databaseCredentialEventCounter(
        connection === "notifications" ? `${pool}-notifications` : pool,
        event,
      );
      if (counter) observability.incrementCounter(counter);
    } catch {
      // Metrics are best effort.
    }
    try {
      log(event, connection);
    } catch {
      // Logging is best effort.
    }
  };
}

/** The URL's user and password exactly as postgres.js parses them (`parseUrl`). */
function databaseUrlCredentials(databaseUrl: string): { user: string; password: string } | null {
  if (!databaseUrl.includes("://")) return null;
  try {
    let host = databaseUrl.slice(databaseUrl.indexOf("://") + 3).split(/[?/]/)[0] ?? "";
    host = decodeURIComponent(host.slice(host.indexOf("@") + 1));
    const url = new URL(databaseUrl.replace(host, host.split(",")[0] ?? ""));
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    return null;
  }
}

/**
 * The password postgres.js would use for this URL when no `pass` option is
 * given: the URL's (percent-decoded) password, then `PGPASSWORD`, then empty.
 */
export function databaseUrlPassword(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return databaseUrlCredentials(databaseUrl)?.password || environment.PGPASSWORD || "";
}

/** The login name in a connection URL, percent-decoded; null when absent. */
export function databaseUrlUser(databaseUrl: string): string | null {
  return databaseUrlCredentials(databaseUrl)?.user || null;
}

/** True for a PostgreSQL authentication failure, including under nested causes. */
export function isDatabaseAuthenticationFailure(error: unknown): boolean {
  for (const record of errorChain(error)) {
    for (const key of ["code", "sqlState", "sqlstate"] as const) {
      if (record[key] === DATABASE_AUTHENTICATION_FAILURE_SQLSTATE) return true;
    }
    const details = record.details;
    if (
      details &&
      typeof details === "object" &&
      (details as Record<string, unknown>).sqlState === DATABASE_AUTHENTICATION_FAILURE_SQLSTATE
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Hard cap on the attempts of one operation, stale refusals included. An
 * operation normally needs at most one attempt per distinct password; stale
 * refusals (logins that read a password the pool has since replaced) are
 * retried without counting, and this bounds them.
 */
export const DATABASE_AUTHENTICATION_MAX_ATTEMPTS = 5;

/**
 * Which candidate a login used. `generation` counts changes of the files'
 * contents (the candidate list); `selection` counts every change of the
 * selected candidate (a reload that changed the list, or a switch), so a
 * login refused after the pool moved on is recognized as stale even when the
 * pool has since come back to the same index.
 */
export type DatabaseCredentialPosition = {
  readonly generation: number;
  readonly selection: number;
  readonly index: number;
};

/**
 * What a reported 28P01 did: `stale` (the login used a password the pool no
 * longer selects; nothing changed), `switched` (the pool moved to the next
 * candidate) or `unchanged` (the selected candidate was refused and no other
 * exists).
 */
export type DatabaseAuthenticationRefusal = "stale" | "switched" | "unchanged";

export type RotatingDatabasePasswordOptions = {
  files: DatabasePasswordFiles;
  /** Used when the current file is missing or empty (normally the URL password). */
  fallbackPassword: string;
  onEvent?: DatabaseCredentialEventListener;
  /** Test seam; defaults to reading the file as UTF-8. */
  readPasswordFile?: (path: string) => Promise<string>;
};

type FileRead = { value: string } | { missing: true } | { unreadable: string };

/**
 * One pool's password source: candidates `[previous, current]` (previous only
 * when non-empty and different) with a sticky index.
 *
 * - Every connection attempt calls {@link password}, which re-reads both files,
 *   so kubelet Secret updates apply without a restart. Only a change in the
 *   files' contents resets the order to the first candidate (a new
 *   "generation"); concurrent reads apply in the order they started.
 * - {@link password} records, per login attempt, the position it handed out.
 *   A 28P01 is attributed to the refused login's own position
 *   ({@link refusedPosition}), never to what the pool selects by the time the
 *   refusal arrives.
 * - The index moves to the next candidate only after a 28P01 of a login that
 *   used the currently selected candidate ({@link reportAuthenticationFailure}),
 *   and then stays there. Logins that read an earlier selection are stale:
 *   their refusals never move the pool, so concurrent refusals of one
 *   candidate move it once, and a refusal of the newly selected candidate
 *   moves it on at once, wrapping from the last to the first (for example
 *   when a rollback reset the role to the old password). There is no
 *   time-based grace.
 *
 * Passwords stay in memory only and never reach an event, an error or a log.
 */
export class RotatingDatabasePassword {
  readonly #files: DatabasePasswordFiles;
  readonly #fallbackPassword: string;
  readonly #onEvent: DatabaseCredentialEventListener | undefined;
  readonly #read: (path: string) => Promise<string>;
  /** The position each login attempt was handed, by the driver's login identity. */
  readonly #logins = new WeakMap<object, DatabaseCredentialPosition>();
  #candidates: string[];
  #index = 0;
  #generation = 0;
  #selection = 0;
  #loaded = false;
  #readsStarted = 0;
  #readApplied = 0;
  readonly #unreadable: { current?: string; previous?: string } = {};

  constructor(options: RotatingDatabasePasswordOptions) {
    this.#files = { ...options.files };
    this.#fallbackPassword = options.fallbackPassword;
    this.#onEvent = options.onEvent;
    this.#read = options.readPasswordFile ?? ((path) => readFile(path, "utf8"));
    this.#candidates = [options.fallbackPassword];
  }

  /** How many distinct passwords the last read produced (at least one). */
  get candidateCount(): number {
    return this.#candidates.length;
  }

  /** The selected candidate's position; for diagnostics and tests. */
  get candidateIndex(): number {
    return this.#index;
  }

  /** The selected candidate's position now. */
  position(): DatabaseCredentialPosition {
    return { generation: this.#generation, selection: this.#selection, index: this.#index };
  }

  /**
   * The password for a connection attempt. Re-reads the files first. Pass the
   * driver's identity for this login attempt (`login`) so a 28P01 it raises
   * is attributed to exactly the password handed out here.
   */
  async password(login?: object): Promise<string> {
    await this.reload();
    const position = this.position();
    if (login && typeof login === "object") this.#logins.set(login, position);
    return this.#candidates[position.index] ?? this.#fallbackPassword;
  }

  /**
   * The position the refused login used, from the login identity the driver
   * tagged `error` with; undefined when the error carries none (an untagged
   * driver) or the login was not handed a password by this source.
   */
  refusedPosition(error: unknown): DatabaseCredentialPosition | undefined {
    const login = databaseLoginAttemptOf(error);
    return login ? this.#logins.get(login) : undefined;
  }

  /** Re-read the files; reset the order only when their contents changed. */
  async reload(): Promise<void> {
    const read = ++this.#readsStarted;
    // Current first, then previous, one after the other. kubelet switches a
    // Secret volume's files together and only forward, so this order never
    // pairs a new current with an older, still missing previous (which would
    // leave only the new password while the role still has the old one). The
    // worst mix is the older state, or one extra refusal and a switch.
    const current = await this.#readOne("current", this.#files.currentPasswordFile);
    const previous = await this.#readOne("previous", this.#files.previousPasswordFile);
    // A slower read that started earlier must not undo a newer one.
    if (read < this.#readApplied) return;
    this.#readApplied = read;
    const currentPassword = current || this.#fallbackPassword;
    const next =
      previous && previous !== currentPassword ? [previous, currentPassword] : [currentPassword];
    const changed =
      next.length !== this.#candidates.length ||
      next.some((candidate, index) => candidate !== this.#candidates[index]);
    const initial = !this.#loaded;
    this.#loaded = true;
    if (!changed) return;
    this.#candidates = next;
    this.#index = 0;
    // The first read only replaces the placeholder: attempts that started
    // before it still refer to the same first candidate.
    if (!initial) {
      this.#generation += 1;
      this.#selection += 1;
    }
    if (!initial || next.length > 1) {
      this.#emit({ type: "candidates_reloaded", candidates: next.length });
    }
  }

  /**
   * Record a 28P01 of a login that used `refused` (see {@link refusedPosition}).
   * Moves to the next candidate only when that login used the current
   * selection and another distinct candidate exists. A stale refusal (the
   * selection changed since the login read its password) changes nothing.
   */
  reportAuthenticationFailure(refused: DatabaseCredentialPosition): DatabaseAuthenticationRefusal {
    const stale = refused.selection !== this.#selection;
    this.#emit({
      type: "candidate_refused",
      index: refused.index,
      candidates: this.#candidates.length,
      stale,
    });
    if (stale) return "stale";
    if (this.#candidates.length < 2) return "unchanged";
    const fromIndex = this.#index;
    this.#index = (this.#index + 1) % this.#candidates.length;
    this.#selection += 1;
    this.#emit({
      type: "candidate_switched",
      fromIndex,
      toIndex: this.#index,
      candidates: this.#candidates.length,
    });
    return "switched";
  }

  /** Record that an operation was refused on every attempt it was allowed. */
  reportExhausted(): void {
    this.#emit({
      type: "candidates_exhausted",
      index: this.#index,
      candidates: this.#candidates.length,
    });
  }

  async #readOne(file: "current" | "previous", path: string | undefined): Promise<string> {
    if (!path) return "";
    const result = await this.#readFile(path);
    if ("unreadable" in result) {
      // Once per change of state, not on every connection attempt.
      if (this.#unreadable[file] !== result.unreadable) {
        this.#unreadable[file] = result.unreadable;
        this.#emit({ type: "password_file_unreadable", file, code: result.unreadable });
      }
      return "";
    }
    delete this.#unreadable[file];
    return "value" in result ? result.value : "";
  }

  async #readFile(path: string): Promise<FileRead> {
    try {
      // A Secret created from a file often ends in a newline; a password never does.
      return { value: (await this.#read(path)).replace(/[\r\n]+$/, "") };
    } catch (error) {
      const code =
        error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "UNKNOWN";
      // Absent keys of an optional Secret volume are simply missing files.
      return code === "ENOENT" ? { missing: true } : { unreadable: code };
    }
  }

  #emit(event: DatabaseCredentialEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // A failing observer must never fail a connection attempt.
    }
  }
}

/**
 * Run `attempt` again after a 28P01, on the candidate the pool then selects.
 * The budget follows the refused login's own password, not the operation's:
 * - a stale refusal (the pool already selects another password than the one
 *   the refused login used) is retried without counting;
 * - otherwise each distinct password gets one attempt: once every candidate
 *   was refused for this operation, its last 28P01 surfaces;
 * - and never more than {@link DATABASE_AUTHENTICATION_MAX_ATTEMPTS} attempts.
 * Without a credential (no password files), or with a single candidate, this
 * is just `attempt()`: a wrong password fails fast, as before.
 *
 * The refused login is identified by the driver's login tag
 * ({@link DATABASE_LOGIN_ATTEMPT}); an untagged 28P01 is attributed to the
 * candidate selected when the attempt started.
 *
 * Callers must only pass operations whose 28P01 proves that nothing ran:
 * PostgreSQL raises 28P01 only while authenticating a new connection, before
 * the server has accepted any statement on it, so running such an operation
 * again cannot apply anything twice. `canRetry` lets a caller veto a retry
 * when the operation got past that point (a transaction whose callback ran).
 * The last 28P01 surfaces unchanged.
 */
export async function withDatabaseAuthenticationRetry<T>(
  credential: RotatingDatabasePassword | undefined,
  attempt: () => Promise<T>,
  canRetry: () => boolean = () => true,
): Promise<T> {
  if (!credential) return attempt();
  // Candidate indexes of the current generation this operation was refused
  // on while they were selected (fresh refusals).
  const refusedCandidates = new Set<number>();
  let refusedGeneration: number | undefined;
  for (let attempts = 1; ; attempts += 1) {
    const started = credential.position();
    try {
      return await attempt();
    } catch (error) {
      if (!isDatabaseAuthenticationFailure(error) || !canRetry()) throw error;
      const refused = credential.refusedPosition(error) ?? started;
      const outcome = credential.reportAuthenticationFailure(refused);
      // A single password: nothing else to try, so fail fast.
      if (credential.candidateCount < 2) throw error;
      if (outcome !== "stale") {
        if (refused.generation !== refusedGeneration) refusedCandidates.clear();
        refusedGeneration = refused.generation;
        refusedCandidates.add(refused.index);
      }
      if (
        refusedCandidates.size >= credential.candidateCount ||
        attempts >= DATABASE_AUTHENTICATION_MAX_ATTEMPTS
      ) {
        credential.reportExhausted();
        throw error;
      }
    }
  }
}
