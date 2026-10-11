import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { CodexFetch } from "@opengeni/codex";
import type { Settings } from "@opengeni/config";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "../src/database";
import { encryptEnvironmentValue, decryptEnvironmentValue } from "../src/environment-crypto";
import {
  readOrganizationCodexUsage,
  type OrganizationCodexUsageJoinedFetch,
} from "../src/organization-codex-usage";
import * as compatibility from "../src/subscription-core-codex-compat";
import * as repository from "../src/subscription-core-repository";

function joined<T extends CodexFetch>(
  fetch: T,
  abortAndJoin: OrganizationCodexUsageJoinedFetch["abortAndJoin"] = async () => {},
) {
  return Object.assign(fetch, { abortAndJoin });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function coreFixture() {
  const key = Buffer.alloc(32, 46);
  const organizationId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  let disconnected = false;
  let maintenance = false;
  let locked = false;
  let depth = 0;
  const queries: string[] = [];
  const row = {
    id: credentialId,
    version: 1,
    status: "active",
    last_error: null,
    plan_type: "pro",
    provider_account_id: "fixture-provider",
    is_fedramp: false,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    last_refresh_at: null,
    credential_encrypted: encryptEnvironmentValue(
      key,
      JSON.stringify({
        access_token: "fixture-secret-access",
        refresh_token: "fixture-secret-refresh",
        id_token: "fixture-id",
      }),
    ),
  };
  const hooks = { onLock: () => {}, onUnlock: () => {}, onCredentialRead: () => {} };
  const dialect = new PgDialect();
  const db = {
    execute: async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      queries.push(query.sql);
      if (query.sql.includes("pg_advisory_xact_lock")) {
        expect(query.params).toContain(`subscription-refresh:${credentialId}`);
        locked = true;
        hooks.onLock();
        return [];
      }
      if (/set local/.test(query.sql)) return [];
      if (/select id,/.test(query.sql)) {
        expect(query.sql).toContain("disconnected_at is null");
        const result = disconnected ? [] : [{ ...row }];
        if (locked) await hooks.onCredentialRead();
        return result;
      }
      throw new Error("Unexpected fixture query");
    },
  } as unknown as Database;
  const disposition = spyOn(compatibility, "readCodexCutoverDisposition").mockImplementation(
    async () => (maintenance ? "maintenance" : "core"),
  );
  const canonical = spyOn(repository, "resolveSubscriptionConnectionId").mockResolvedValue(
    credentialId,
  );
  restores.push(
    () => disposition.mockRestore(),
    () => canonical.mockRestore(),
  );
  const withAdministrator = async <T>(target: Database, use: (tx: Database) => Promise<T>) => {
    depth += 1;
    try {
      return await use(target);
    } finally {
      depth -= 1;
      if (!depth && locked) {
        hooks.onUnlock();
        locked = false;
      }
    }
  };
  const refresh = mock(async () => {
    throw new Error("Unexpected refresh");
  });
  return {
    db,
    queries,
    row,
    hooks,
    refresh,
    canonical,
    withAdministrator,
    settings: { environmentsEncryptionKey: key.toString("base64") } as Settings,
    input: { organizationId, credentialId, mode: "core" as const },
    isLocked: () => locked,
    disconnect: () => {
      disconnected = true;
    },
    replaceBearer: () => {
      row.version += 1;
      row.credential_encrypted = encryptEnvironmentValue(
        key,
        JSON.stringify({
          access_token: "replacement-access",
          refresh_token: "replacement-refresh",
          id_token: "fixture-id",
        }),
      );
    },
    maintenance: () => {
      maintenance = true;
    },
    read: (fetch: CodexFetch, options: { requestTimeoutMs?: number; signal?: AbortSignal } = {}) =>
      readOrganizationCodexUsage(
        db,
        { environmentsEncryptionKey: key.toString("base64") } as Settings,
        { organizationId, credentialId, mode: "core", ...options },
        withAdministrator,
        fetch,
        refresh,
      ),
  };
}

describe("organization core usage bounded request lock", () => {
  test("an unverified custom transport fails before receiving a credential or dispatching", async () => {
    const f = coreFixture();
    const fetch = mock(async () => new Response("{}"));
    expect((await f.read(fetch)).status).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
    expect(f.canonical).not.toHaveBeenCalled();
    expect(f.queries).toEqual([]);
  });

  test("disconnect wins the lock: a previously resolved bearer never dispatches", async () => {
    const f = coreFixture();
    f.hooks.onLock = f.disconnect;
    const fetch = joined(mock(async () => new Response("{}")));
    expect((await f.read(fetch)).status).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  test("an already-aborted probe neither loads a credential nor dispatches", async () => {
    const f = coreFixture();
    const fetch = joined(mock(async () => new Response("{}")));
    expect((await f.read(fetch, { signal: AbortSignal.abort() })).status).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
    expect(f.canonical).not.toHaveBeenCalled();
    expect(f.queries).toEqual([]);
  });

  for (const delayedStep of ["source lock", "credential load"] as const) {
    test(`expiry while awaiting ${delayedStep} cannot restart the budget and dispatch after disconnect`, async () => {
      const f = coreFixture();
      let now = 100;
      const clock = spyOn(performance, "now").mockImplementation(() => now);
      restores.push(() => clock.mockRestore());
      let reachedDelayedStep = false;
      const suspend = () => {
        reachedDelayedStep = true;
        // Simulate suspension longer than PostgreSQL's orphan lock timeout;
        // a credential row already returned by PG still contains the old bearer.
        now += 11_000;
        f.disconnect();
      };
      if (delayedStep === "source lock") f.hooks.onLock = suspend;
      else f.hooks.onCredentialRead = suspend;
      const fetch = joined(mock(async () => new Response("{}")));
      expect((await f.read(fetch)).status).toBe("error");
      expect(reachedDelayedStep).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(f.refresh).not.toHaveBeenCalled();
      expect(f.isLocked()).toBe(false);
    });
  }

  test("the GET receives only the admission budget remaining, not a fresh five seconds", async () => {
    const f = coreFixture();
    let now = 100;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    restores.push(() => clock.mockRestore());
    f.hooks.onCredentialRead = () => {
      now += 4_000;
    };
    const schedule = globalThis.setTimeout;
    const delays: number[] = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
    ) => {
      delays.push(delay ?? 0);
      return schedule(callback, delay);
    }) as typeof setTimeout);
    restores.push(() => timer.mockRestore());
    const fetch = joined(mock(async () => new Response("{}")));
    expect((await f.read(fetch)).status).toBe("no-data");
    expect(delays).toContain(1_000);
    expect(delays).not.toContain(5_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("admitted GET retains the lock through full body consumption with redirects disabled", async () => {
    const f = coreFixture();
    const started = deferred<void>();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = joined(
      mock(async (_url, init) => {
        expect(f.isLocked()).toBe(true);
        expect(init?.redirect).toBe("error");
        expect(init?.method).toBe("GET");
        started.resolve();
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              body = controller;
            },
          }),
        );
      }) as CodexFetch,
    );
    let finished = false;
    const result = f.read(fetch).then((value) => {
      finished = true;
      return value;
    });
    await started.promise;
    body.enqueue(new TextEncoder().encode('{"plan_type":"pro"}'));
    expect(f.isLocked()).toBe(true);
    expect(finished).toBe(false);
    body.close();
    expect((await result).status).toBe("no-data");
    expect(f.isLocked()).toBe(false);
    expect(
      f.queries.some((query) => query.includes("idle_in_transaction_session_timeout = '10s'")),
    ).toBe(true);
  });

  test("deadline cancels the body and joins local teardown before unlocking", async () => {
    const f = coreFixture();
    const joining = deferred<void>();
    const joinedGate = deferred<void>();
    let cancelled = false;
    let signal: AbortSignal | null | undefined;
    const fetch = joined(
      async (_url, init) => {
        signal = init?.signal;
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
      async () => {
        joining.resolve();
        await joinedGate.promise;
      },
    );
    const result = f.read(fetch, { requestTimeoutMs: 10 });
    await joining.promise;
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(f.isLocked()).toBe(true);
    joinedGate.resolve();
    expect((await result).status).toBe("error");
    expect(f.isLocked()).toBe(false);
  });

  test("abort joins a pending fetch before unlock and cannot dispatch its deferred work afterward", async () => {
    const f = coreFixture();
    const started = deferred<void>();
    const gate = deferred<void>();
    const controller = new AbortController();
    let reject!: (error: Error) => void;
    let cancelled = false;
    let sends = 0;
    const fetch = joined(
      async () => {
        started.resolve();
        return await new Promise<Response>((_resolve, fail) => {
          reject = fail;
          void gate.promise.then(() => {
            if (!cancelled) sends += 1;
          });
        });
      },
      async () => {
        cancelled = true;
        reject(new Error("local fetch joined"));
      },
    );
    const result = f.read(fetch, { signal: controller.signal });
    await started.promise;
    controller.abort();
    expect((await result).status).toBe("error");
    gate.resolve();
    await gate.promise;
    expect(sends).toBe(0);
    expect(f.isLocked()).toBe(false);
  });

  test("oversized and truncated bodies fail without refresh or replay", async () => {
    for (const oversized of [true, false]) {
      const f = coreFixture();
      const fetch = joined(
        mock(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  if (oversized) controller.enqueue(new Uint8Array(1024 * 1024 + 1));
                  else controller.error(new Error("fixture-secret-provider-body"));
                },
              }),
            ),
        ),
      );
      const result = await f.read(fetch);
      expect(result.status).toBe("error");
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(f.refresh).not.toHaveBeenCalled();
    }
  });

  test("maintenance after lock acquisition is rechecked before provider dispatch", async () => {
    const f = coreFixture();
    f.hooks.onLock = f.maintenance;
    const fetch = joined(mock(async () => new Response("{}")));
    expect((await f.read(fetch)).status).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a 401 followed by disconnect cannot refresh or send another usage request", async () => {
    const f = coreFixture();
    f.hooks.onUnlock = f.disconnect;
    const fetch = joined(mock(async () => new Response(null, { status: 401 })));
    expect((await f.read(fetch)).status).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  test("a generation change under the lock causes a fresh check, never a cached-bearer send", async () => {
    const f = coreFixture();
    let locks = 0;
    f.hooks.onLock = () => {
      if (++locks === 1) f.replaceBearer();
    };
    const fetch = joined(
      mock(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(f.isLocked()).toBe(true);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer replacement-access");
        return new Response("{}");
      }),
    );
    expect((await f.read(fetch)).status).toBe("no-data");
    expect(locks).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  test("revoked administration refuses before credential reads and never logs supplied secrets", async () => {
    const f = coreFixture();
    const logs = spyOn(console, "error").mockImplementation(() => {});
    restores.push(() => logs.mockRestore());
    const fetch = joined(mock(async () => new Response("{}")));
    const result = await readOrganizationCodexUsage(
      f.db,
      f.settings,
      f.input,
      async () => {
        throw new Error("fixture-secret-authority-error");
      },
      fetch,
    );
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(fetch).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
    expect(f.queries).toEqual([]);
  });
});

test("a concurrently replaced bearer cannot dispatch after its refresh enters maintenance", async () => {
  const key = Buffer.alloc(32, 47);
  const organizationId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  let maintenance = false;
  let reads = 0;
  const row = {
    id: credentialId,
    version: 1,
    status: "active",
    last_error: null,
    plan_type: "pro",
    provider_account_id: "synthetic-provider",
    is_fedramp: false,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    last_refresh_at: null,
    credential_encrypted: encryptEnvironmentValue(
      key,
      JSON.stringify({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        id_token: "synthetic-id",
      }),
    ),
  };
  const dialect = new PgDialect();
  const db = {
    execute: async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      if (/select id,/.test(query.sql)) {
        reads += 1;
        if (reads === 2) {
          row.version = 2;
          row.expires_at = new Date(0).toISOString();
        }
        // The other supported database-driver result shape is deliberate.
        return { rows: [{ ...row }] };
      }
      if (/update .* set credential_encrypted/.test(query.sql.trim())) {
        row.credential_encrypted = query.params.find(
          (value) => typeof value === "string" && value.startsWith("v2:"),
        ) as string;
        row.version += 1;
        return { rows: [{ id: credentialId }] };
      }
      if (/set local|select pg_advisory_xact_lock/.test(query.sql)) return { rows: [] };
      throw new Error("Unexpected database operation");
    },
  } as unknown as Database;
  const disposition = spyOn(compatibility, "readCodexCutoverDisposition").mockImplementation(
    async () => (maintenance ? "maintenance" : "core"),
  );
  const alias = spyOn(repository, "resolveSubscriptionConnectionId").mockResolvedValue(
    credentialId,
  );
  const provider = joined(mock(async () => new Response("{}")));
  const refresh = mock(async () => {
    maintenance = true;
    return {
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      idToken: "synthetic-id",
    };
  });
  try {
    const result = await readOrganizationCodexUsage(
      db,
      { environmentsEncryptionKey: key.toString("base64") } as Settings,
      { organizationId, credentialId, mode: "core" },
      async (target, use) => use(target),
      provider,
      refresh,
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("error");
    expect(provider).not.toHaveBeenCalled();
    expect(JSON.parse(decryptEnvironmentValue(key, row.credential_encrypted)).refresh_token).toBe(
      "rotated-refresh",
    );
  } finally {
    disposition.mockRestore();
    alias.mockRestore();
  }
});
