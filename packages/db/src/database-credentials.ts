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
 *    provisioning password and the URL password; each pool meets one 28P01
 *    and switches to the current password;
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
       * A new connection that started on candidate `index` was refused with
       * 28P01. For counters and tests; not logged (a switch is).
       */
      type: "candidate_refused";
      index: number;
      candidates: number;
    }
  | {
      /** A 28P01 on the selected candidate moved the pool to the next one. */
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
 * One content-free log line per event except single refusals (a switch is
 * logged instead): the message and the event's index and count facts, tagged
 * with the pool's name. Defaults to `console.warn`, for processes without
 * structured logging (CLIs, scripts).
 */
export function logDatabaseCredentialEvent(
  pool: string,
  log: (message: string, attributes: Record<string, string | number>) => void = (
    message,
    attributes,
  ) => console.warn(`[database] ${message}`, attributes),
): DatabaseCredentialEventListener {
  return (event, connection) => {
    if (event.type === "candidate_refused") return;
    const { type: _type, ...facts } = event;
    log(databaseCredentialEventMessage(event), {
      pool: connection === "notifications" ? `${pool}-notifications` : pool,
      ...facts,
    });
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
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
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
    for (const key of ["cause", "original", "driverError", "error", "errors"] as const) {
      const nested = record[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested !== undefined) queue.push(nested);
    }
  }
  return false;
}

/**
 * How long after a switch a 28P01 on the newly selected candidate is treated
 * as a straggler: a connection that read the previous candidate just before
 * the switch can still be refused moments after it. Such a report does not
 * move the pool again; the operation simply retries on the selected candidate.
 */
export const DATABASE_CREDENTIAL_STALE_FAILURE_GRACE_MS = 5_000;

/** Which candidate an attempt started on; pass it back with its 28P01. */
export type DatabaseCredentialPosition = { readonly generation: number; readonly index: number };

export type RotatingDatabasePasswordOptions = {
  files: DatabasePasswordFiles;
  /** Used when the current file is missing or empty (normally the URL password). */
  fallbackPassword: string;
  onEvent?: DatabaseCredentialEventListener;
  /** Defaults to {@link DATABASE_CREDENTIAL_STALE_FAILURE_GRACE_MS}. */
  staleFailureGraceMs?: number;
  /** Test seam; defaults to reading the file as UTF-8. */
  readPasswordFile?: (path: string) => Promise<string>;
  /** Test seam. */
  now?: () => number;
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
 * - The index moves to the next candidate only after a 28P01 reported for the
 *   selected candidate of the current generation
 *   ({@link reportAuthenticationFailure}), and then stays there. Concurrent
 *   refusals of one candidate move it once. A refusal of the newly selected
 *   candidate within the straggler grace does not move it again; after that,
 *   a refusal of the last candidate wraps to the first (for example when a
 *   release reset the role to the old password).
 *
 * Passwords stay in memory only and never reach an event, an error or a log.
 */
export class RotatingDatabasePassword {
  readonly #files: DatabasePasswordFiles;
  readonly #fallbackPassword: string;
  readonly #onEvent: DatabaseCredentialEventListener | undefined;
  readonly #read: (path: string) => Promise<string>;
  readonly #graceMs: number;
  readonly #now: () => number;
  #candidates: string[];
  #index = 0;
  #generation = 0;
  /** When the selected candidate was switched to; undefined for the first. */
  #selectedAt: number | undefined;
  #loaded = false;
  #readsStarted = 0;
  #readApplied = 0;
  readonly #unreadable: { current?: string; previous?: string } = {};

  constructor(options: RotatingDatabasePasswordOptions) {
    this.#files = { ...options.files };
    this.#fallbackPassword = options.fallbackPassword;
    this.#onEvent = options.onEvent;
    this.#read = options.readPasswordFile ?? ((path) => readFile(path, "utf8"));
    this.#graceMs = options.staleFailureGraceMs ?? DATABASE_CREDENTIAL_STALE_FAILURE_GRACE_MS;
    this.#now = options.now ?? Date.now;
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

  /** The selected candidate; capture it before an attempt. */
  position(): DatabaseCredentialPosition {
    return { generation: this.#generation, index: this.#index };
  }

  /** The password for the next connection attempt. Re-reads the files first. */
  async password(): Promise<string> {
    await this.reload();
    return this.#candidates[this.#index] ?? this.#fallbackPassword;
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
    this.#selectedAt = undefined;
    // The first read only replaces the placeholder: attempts that started
    // before it still refer to the same first candidate.
    if (!initial) this.#generation += 1;
    if (!initial || next.length > 1) {
      this.#emit({ type: "candidates_reloaded", candidates: next.length });
    }
  }

  /**
   * Record a 28P01 for an attempt that started at `observed`. Moves to the
   * next candidate only when that is still the selected one, another distinct
   * candidate exists, and it was not selected moments ago (straggler grace).
   */
  reportAuthenticationFailure(observed: DatabaseCredentialPosition): void {
    this.#emit({
      type: "candidate_refused",
      index: observed.index,
      candidates: this.#candidates.length,
    });
    if (observed.generation !== this.#generation || observed.index !== this.#index) return;
    if (this.#candidates.length < 2) return;
    const now = this.#now();
    if (this.#selectedAt !== undefined && now - this.#selectedAt < this.#graceMs) return;
    const fromIndex = this.#index;
    this.#index = (this.#index + 1) % this.#candidates.length;
    this.#selectedAt = now;
    this.#emit({
      type: "candidate_switched",
      fromIndex,
      toIndex: this.#index,
      candidates: this.#candidates.length,
    });
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
 * Run `attempt` again after a 28P01, on the candidate the pool then selects,
 * but only while another distinct candidate exists, and at most once per
 * candidate in total. Without a credential (no password files), or with a
 * single candidate, this is just `attempt()`: a wrong password fails fast, as
 * before.
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
  for (let attempts = 1; ; attempts += 1) {
    const observed = credential.position();
    try {
      return await attempt();
    } catch (error) {
      if (!isDatabaseAuthenticationFailure(error) || !canRetry()) throw error;
      credential.reportAuthenticationFailure(observed);
      // A single password: nothing else to try, so fail fast.
      if (credential.candidateCount < 2) throw error;
      if (attempts >= credential.candidateCount) {
        credential.reportExhausted();
        throw error;
      }
    }
  }
}
