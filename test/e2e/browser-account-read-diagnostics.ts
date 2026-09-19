type Source = "browser" | "server";
type Terminal = "pending" | "finished" | "failed" | "handler-resolved" | "handler-rejected";
type ReadEvidence = {
  ordinal: number;
  method: "GET" | "POST";
  route:
    | "billing"
    | "workspaces"
    | "session-set"
    | "knowledge-search"
    | "workspace-read"
    | "other-api-read";
  startedMs: number;
  responseMs: number | null;
  status: number | null;
  terminal: Terminal;
  terminalMs: number | null;
  intentionallyHeld: boolean;
};

/** No request headers, bodies, URL/query values, errors or cross-stream identity claims. */
export function createAccountReadDiagnostics(now = () => performance.now()) {
  const started = now();
  const records: Record<Source, ReadEvidence[]> = { browser: [], server: [] };
  const keys: Record<Source, WeakMap<object, ReadEvidence>> = {
    browser: new WeakMap(),
    server: new WeakMap(),
  };
  const dropped: Record<Source, number> = { browser: 0, server: 0 };
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const statusCode = (status: number) =>
    Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  return {
    start(source: Source, key: object, method: string, pathname: string) {
      const search = /^\/v1\/workspaces\/[^/]+\/knowledge\/entries\/search$/u.test(pathname);
      if (
        (method !== "GET" && !(method === "POST" && search)) ||
        !pathname.startsWith("/v1/") ||
        pathname.endsWith("/stream") ||
        pathname.includes("/live-events/stream")
      )
        return;
      if (keys[source].has(key)) return;
      if (records[source].length === 32) {
        dropped[source] += 1;
        return;
      }
      const entry: ReadEvidence = {
        ordinal: records[source].length + 1,
        method,
        route:
          pathname === "/v1/billing"
            ? "billing"
            : pathname === "/v1/workspaces"
              ? "workspaces"
              : pathname === "/v1/auth/session-set"
                ? "session-set"
                : search
                  ? "knowledge-search"
                  : pathname.startsWith("/v1/workspaces/")
                    ? "workspace-read"
                    : "other-api-read",
        startedMs: elapsed(),
        responseMs: null,
        status: null,
        terminal: "pending",
        terminalMs: null,
        intentionallyHeld: false,
      };
      records[source].push(entry);
      keys[source].set(key, entry);
    },
    response(source: Source, key: object, status: number) {
      const entry = keys[source].get(key);
      if (!entry) return;
      entry.responseMs = elapsed();
      entry.status = statusCode(status);
    },
    finish(source: Source, key: object, terminal: Exclude<Terminal, "pending">) {
      const entry = keys[source].get(key);
      if (!entry) return;
      entry.terminal = terminal;
      entry.terminalMs = elapsed();
    },
    markHeld(key: object) {
      const entry = keys.browser.get(key);
      if (entry) entry.intentionallyHeld = true;
    },
    snapshot() {
      return {
        // api.fetch resolution is not body delivery or socket completion. The
        // server sees all tabs; route/time similarity is not exact correlation.
        serverScope: "all-local-api-requests" as const,
        browserScope: "reloading-tab" as const,
        correlation: "independent-streams" as const,
        elapsedMs: elapsed(),
        dropped: { ...dropped },
        browser: records.browser.map((entry) => ({ ...entry })),
        server: records.server.map((entry) => ({ ...entry })),
      };
    },
  };
}
