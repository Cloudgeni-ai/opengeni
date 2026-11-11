import net from "node:net";

/**
 * How long a database client keeps retrying a refused first connection.
 *
 * A brand-new pod is often refused for a moment after it starts: on clusters
 * that enforce NetworkPolicy the pod's rules are still being programmed (about
 * 0.5 to 1 s), and DNS or the database itself may still be coming up. Without a
 * retry, the first query of a one-shot job (migrations, catalog import) fails
 * the rollout and long-running processes restart once. The window only applies
 * until the client has reached the server once; after that a refused
 * connection fails exactly as before so real outages surface immediately.
 */
export const DATABASE_BOOT_CONNECT_GRACE_MS = 15_000;

/** Connect failures that are expected while a fresh pod's network settles. */
const BOOT_TRANSIENT_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

/** The subset of postgres.js connection options a custom socket factory receives. */
export type DatabaseSocketTarget = {
  host: readonly string[];
  port: readonly number[];
  path?: string | false | undefined;
  connect_timeout?: number | undefined;
};

export type DatabaseConnectEndpoint =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "path"; path: string };

export type BootGraceSocketDependencies = {
  graceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  connect?: (endpoint: DatabaseConnectEndpoint, timeoutMs: number | null) => Promise<net.Socket>;
  open?: (endpoint: DatabaseConnectEndpoint) => net.Socket;
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function isDatabaseBootTransientConnectError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && BOOT_TRANSIENT_CONNECT_CODES.has(code);
}

/** Jittered delay before the next boot connect attempt: 100 ms doubling to 1 s. */
export function databaseBootConnectRetryDelayMs(attempt: number, random = Math.random): number {
  const base = Math.min(100 * 2 ** attempt, 1_000);
  return Math.round(base * (0.5 + random() / 2));
}

function connectTimeoutError(endpoint: DatabaseConnectEndpoint): Error {
  const where = endpoint.kind === "tcp" ? `${endpoint.host}:${endpoint.port}` : endpoint.path;
  return Object.assign(new Error(`write CONNECT_TIMEOUT ${where}`), { code: "CONNECT_TIMEOUT" });
}

/**
 * Starts connecting and returns the socket at once, like postgres.js's own
 * connection path: a failure arrives as the socket's `error` and `close`
 * events, which postgres.js handles by failing the waiting query and putting
 * the connection back in its pool to reconnect later.
 */
export function openDatabaseSocket(endpoint: DatabaseConnectEndpoint): net.Socket {
  return endpoint.kind === "tcp"
    ? net.connect({ host: endpoint.host, port: endpoint.port })
    : net.connect({ path: endpoint.path });
}

/** Opens one connected socket, failing on the first socket error or timeout. */
export function connectDatabaseSocket(
  endpoint: DatabaseConnectEndpoint,
  timeoutMs: number | null,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = openDatabaseSocket(endpoint);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: unknown) => {
      if (timer) clearTimeout(timer);
      socket.off("connect", succeed);
      socket.destroy();
      reject(error);
    };
    const succeed = () => {
      if (timer) clearTimeout(timer);
      socket.off("error", fail);
      resolve(socket);
    };
    if (timeoutMs !== null && timeoutMs > 0) {
      timer = setTimeout(() => fail(connectTimeoutError(endpoint)), timeoutMs);
    }
    socket.once("error", fail);
    socket.once("connect", succeed);
  });
}

/**
 * A postgres.js `socket` factory that retries a refused or reset connection
 * while the client is still booting (see {@link DATABASE_BOOT_CONNECT_GRACE_MS}).
 * One factory belongs to one client: every pooled connection shares the "has
 * reached the server" state, so the grace ends at the first success or when the
 * window since client creation has elapsed, whichever comes first. Each attempt
 * keeps the client's own `connect_timeout`.
 *
 * The factory never rejects. postgres.js does not recover a pooled connection
 * whose socket factory rejects: it fails the waiting query but never returns
 * the connection to its pool, so after a database restart every connection
 * leaked one by one and the client hung for good, even once the database was
 * back. Outside the grace, and when the grace gives up, the factory instead
 * returns a socket that is still connecting, so a failure reaches postgres.js
 * as socket events and the connection reconnects like any other.
 */
export function createBootGraceDatabaseSocket(
  dependencies: BootGraceSocketDependencies = {},
): (target: DatabaseSocketTarget) => Promise<net.Socket> {
  const graceMs = dependencies.graceMs ?? DATABASE_BOOT_CONNECT_GRACE_MS;
  const now = dependencies.now ?? (() => performance.now());
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const connect = dependencies.connect ?? connectDatabaseSocket;
  const open = dependencies.open ?? openDatabaseSocket;
  const createdAt = now();
  let reachedServer = false;

  return async (target) => {
    const endpoint: DatabaseConnectEndpoint = target.path
      ? { kind: "path", path: target.path }
      : { kind: "tcp", host: target.host[0] ?? "localhost", port: target.port[0] ?? 5432 };
    const timeoutMs =
      typeof target.connect_timeout === "number" && target.connect_timeout > 0
        ? target.connect_timeout * 1_000
        : null;
    const withTarget = (socket: net.Socket): net.Socket => {
      if (endpoint.kind === "tcp") {
        // postgres.js reads these for TLS SNI and error messages.
        Object.assign(socket, { host: endpoint.host, port: endpoint.port });
      }
      return socket;
    };
    for (let attempt = 0; ; attempt += 1) {
      if (reachedServer || graceMs - (now() - createdAt) <= 0) return withTarget(open(endpoint));
      try {
        const socket = await connect(endpoint, timeoutMs);
        reachedServer = true;
        return withTarget(socket);
      } catch (error) {
        const remainingMs = graceMs - (now() - createdAt);
        if (reachedServer || remainingMs <= 0 || !isDatabaseBootTransientConnectError(error)) {
          // One more attempt that fails, if it still fails, the way postgres.js expects.
          return withTarget(open(endpoint));
        }
        await sleep(Math.min(remainingMs, databaseBootConnectRetryDelayMs(attempt)));
      }
    }
  };
}

/**
 * postgres.js options that add the boot connect grace to a client for
 * `databaseUrl`. A multi-host URL keeps postgres.js's own host failover, which
 * a custom socket would replace, so it gets no factory. A `graceMs` of 0
 * disables the grace: the first refused connection fails immediately.
 */
export function databaseBootConnectOptions(
  databaseUrl: string,
  graceMs: number = DATABASE_BOOT_CONNECT_GRACE_MS,
): {
  socket?: (target: DatabaseSocketTarget) => Promise<net.Socket>;
} {
  if (graceMs <= 0) return {};
  const authority = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]*)/i.exec(databaseUrl)?.[1] ?? "";
  if (authority.includes(",")) return {};
  return { socket: createBootGraceDatabaseSocket({ graceMs }) };
}
