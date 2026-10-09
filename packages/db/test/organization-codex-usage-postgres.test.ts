import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { CodexReloginRequired, type CodexFetch } from "@opengeni/codex";
import type { Settings } from "@opengeni/config";
import {
  createDb,
  ensureManagedAccessForUser,
  fetchOrganizationCodexUsageForAccount,
  disconnectSubscriptionCoreCodexConnection,
  withSessionRlsActorContext,
  withRlsContext,
  type Database,
  type DbClient,
} from "../src";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import type { OrganizationCodexUsageJoinedFetch } from "../src/organization-codex-usage";

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

const real = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 62);
const settings = { environmentsEncryptionKey: key.toString("base64") } as Settings;
beforeAll(async () => {
  if (!real) return;
  shared = await acquireSharedTestDatabase("organization-codex-usage");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture(mode: "legacy" | "core", expired = false, workspaceManaged = false) {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Usage fixture",
  });
  const organizationId = access.workspaceGrants[0]!.accountId;
  const credentialId = crypto.randomUUID();
  const actorSubjectId = `user:${userId}`;
  const encrypted = encryptEnvironmentValue(
    key,
    JSON.stringify({
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      id_token: "synthetic-id",
    }),
  );
  const expires = new Date(expired ? 0 : Date.now() + 86_400_000).toISOString();
  if (mode === "legacy") {
    // Reconstruct the pre-cutover fixture; new organizations are seeded core.
    await shared!.admin`delete from subscription_provider_cutovers
      where account_id = ${organizationId} and provider = 'codex'`;
    await shared!.admin`insert into codex_subscription_credentials (
      id, account_id, organization_id, authority_scope, credential_encrypted,
      chatgpt_account_id, plan_type, status, allocator_enabled, allowed_workspace_ids,
      allow_personal_workspaces, expires_at
    ) values (${credentialId}, ${organizationId}, ${organizationId}, 'organization',
      ${encrypted}, ${crypto.randomUUID()}, 'pro', 'active', false, '{}', false, ${expires})`;
  } else {
    await shared!.admin`insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${organizationId}, 'codex', true)
      on conflict (account_id, provider) do update set enabled = true`;
    await shared!.admin`insert into subscription_connections (
      id, account_id, provider, kind, credential_encrypted, credential_format, provider_account_id,
      plan_type, ownership, scope_kind, status, allocator_enabled, allow_personal_workspaces, expires_at,
      managed_by_workspace_id
    ) values (${credentialId}, ${organizationId}, 'codex', 'subscription', ${encrypted}, 'v2',
      ${crypto.randomUUID()}, 'pro', 'shared', 'workspaces', 'active', false, false, ${expires},
      ${workspaceManaged ? access.workspaceGrants[0]!.workspaceId : null})`;
  }
  return { organizationId, actorSubjectId, credentialId, mode };
}

async function aliasFor(input: Awaited<ReturnType<typeof fixture>>) {
  const alias = crypto.randomUUID();
  await shared!.admin`insert into subscription_connection_aliases
    (account_id, provider, alias_connection_id, connection_id)
    values (${input.organizationId}, 'codex', ${alias}, ${input.credentialId})`;
  return { ...input, credentialId: alias };
}

function disconnect(input: Awaited<ReturnType<typeof fixture>>, db: Database = client!.db) {
  return withSessionRlsActorContext({ subjectId: input.actorSubjectId }, () =>
    disconnectSubscriptionCoreCodexConnection(db, {
      accountId: input.organizationId,
      workspaceId: null,
      subjectId: input.actorSubjectId,
      connectionId: input.credentialId,
    }),
  );
}

async function waitForBlockedLock() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await shared!.admin`select count(*)::int as pending from pg_locks
      where locktype = 'advisory' and not granted
      and database = (select oid from pg_database where datname = current_database())`;
    if (Number(row!.pending) > 0) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected actual PostgreSQL lock contention");
}

async function assertScrubbed(input: Awaited<ReturnType<typeof fixture>>) {
  const [row] = await shared!
    .admin`select credential_encrypted, disconnected_at is not null as disconnected
    from subscription_connections where id = ${input.credentialId}`;
  expect(row).toEqual({ credential_encrypted: "", disconnected: true });
}

describe("organization core usage versus disconnect", () => {
  test.skipIf(!real)(
    "usage wins: alias GET owns the canonical lock through its full body",
    async () => {
      const input = await fixture("core");
      const alias = await aliasFor(input);
      const started = deferred<void>();
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const fetch = joined(
        mock(async () => {
          started.resolve();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
              },
            }),
          );
        }),
      );
      const reading = fetchOrganizationCodexUsageForAccount(client!.db, settings, alias, fetch);
      await started.promise;
      let removed = false;
      const removing = disconnect(input).then((result) => {
        removed = true;
        return result;
      });
      try {
        await waitForBlockedLock();
        expect(removed).toBe(false);
        body.enqueue(new TextEncoder().encode('{"plan_type":"pro"}'));
        expect(removed).toBe(false);
        body.close();
        expect((await reading).status).toBe("no-data");
        expect((await removing).outcome).toBe("removed");
        await assertScrubbed(input);
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        try {
          body.close();
        } catch {}
        await Promise.allSettled([reading, removing]);
      }
    },
  );

  test.skipIf(!real)(
    "disconnect wins: a waiting alias probe never sends a cached bearer",
    async () => {
      const input = await fixture("core");
      const alias = await aliasFor(input);
      const fenced = deferred<void>();
      const commit = deferred<void>();
      const removing = withSessionRlsActorContext({ subjectId: input.actorSubjectId }, () =>
        withRlsContext(
          client!.db,
          { accountId: input.organizationId, workspaceId: null },
          async (tx) => {
            const result = await disconnect(input, tx);
            fenced.resolve();
            await commit.promise;
            return result;
          },
        ),
      );
      await fenced.promise;
      const fetch = provider();
      const reading = fetchOrganizationCodexUsageForAccount(client!.db, settings, alias, fetch);
      try {
        await waitForBlockedLock();
        expect(fetch).not.toHaveBeenCalled();
        commit.resolve();
        expect((await removing).outcome).toBe("removed");
        expect((await reading).status).toBe("error");
        expect(fetch).not.toHaveBeenCalled();
        await assertScrubbed(input);
      } finally {
        commit.resolve();
        await Promise.allSettled([reading, removing]);
      }
    },
  );

  test.skipIf(!real)(
    "deadline joins body cancellation and releases the lock for disconnect",
    async () => {
      const input = await fixture("core");
      const started = deferred<void>();
      let cancelled = false;
      let joinedLocally = false;
      const fetch = joined(
        mock(async () => {
          started.resolve();
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          );
        }),
        async () => {
          joinedLocally = true;
        },
      );
      const began = Date.now();
      const reading = fetchOrganizationCodexUsageForAccount(client!.db, settings, input, fetch);
      await started.promise;
      const removing = disconnect(input);
      await waitForBlockedLock();
      expect((await reading).status).toBe("error");
      expect(cancelled).toBe(true);
      expect(joinedLocally).toBe(true);
      expect((await removing).outcome).toBe("removed");
      expect(Date.now() - began).toBeLessThan(9_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      await assertScrubbed(input);
    },
    15_000,
  );

  test.skipIf(!real)(
    "disconnect queued during a 401 prevents refresh and a second GET",
    async () => {
      const input = await fixture("core");
      let removing: ReturnType<typeof disconnect> | undefined;
      const fetch = joined(
        mock(async () => {
          removing = disconnect(input);
          await waitForBlockedLock();
          return new Response(null, { status: 401 });
        }),
      );
      const refresh = mock(async () => ({ accessToken: "must-not-refresh" }));
      const result = await fetchOrganizationCodexUsageForAccount(
        client!.db,
        settings,
        input,
        fetch,
        refresh,
      );
      expect(result.status).toBe("error");
      expect((await removing)?.outcome).toBe("removed");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
      await assertScrubbed(input);
    },
  );

  test.skipIf(!real)(
    "PostgreSQL releases an orphaned usage transaction even when the worker cannot run its timer",
    async () => {
      const input = await fixture("core");
      const dispatched = deferred<void>();
      let requests = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 30,
        fetch() {
          requests += 1;
          dispatched.resolve();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
              },
            }),
          );
        },
      });
      const worker = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `
      import { createDb, fetchOrganizationCodexUsageForAccount } from './packages/db/src/index.ts';
      const client = createDb(process.env.ORG_USAGE_FIXTURE_DB, { max: 1 });
      let pending;
      const transport = Object.assign((_url, init) => {
        pending = fetch(process.env.ORG_USAGE_FIXTURE_URL, init);
        return pending;
      }, { abortAndJoin: async () => { await pending?.catch(() => undefined); } });
      try {
        const result = await fetchOrganizationCodexUsageForAccount(client.db,
          { environmentsEncryptionKey: process.env.ORG_USAGE_FIXTURE_KEY },
          JSON.parse(process.env.ORG_USAGE_FIXTURE_INPUT), transport);
        console.log(JSON.stringify({ status: result.status }));
      } finally { await client.close(); }
    `,
        ],
        {
          cwd: new URL("../../../", import.meta.url).pathname,
          env: {
            ...process.env,
            ORG_USAGE_FIXTURE_DB: shared!.appUrl,
            ORG_USAGE_FIXTURE_URL: server.url.toString(),
            ORG_USAGE_FIXTURE_KEY: key.toString("base64"),
            ORG_USAGE_FIXTURE_INPUT: JSON.stringify(input),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = new Response(worker.stdout).text();
      const errors = new Response(worker.stderr).text();
      try {
        await Promise.race([
          dispatched.promise,
          worker.exited.then(() => {
            throw new Error("Usage fixture exited before dispatch");
          }),
        ]);
        worker.kill("SIGSTOP");
        const began = Date.now();
        const removing = disconnect(input);
        await waitForBlockedLock();
        expect((await removing).outcome).toBe("removed");
        expect(Date.now() - began).toBeLessThan(15_000);
        await assertScrubbed(input);
        worker.kill("SIGCONT");
        expect(await worker.exited).toBe(0);
        expect(JSON.parse((await output).trim())).toEqual({ status: "error" });
        expect(requests).toBe(1);
      } finally {
        if (worker.exitCode === null) {
          worker.kill("SIGCONT");
          worker.kill("SIGTERM");
        }
        await worker.exited;
        await Promise.all([output, errors]);
        await server.stop(true);
      }
    },
    30_000,
  );
});

describe("organization Codex usage through retained core aliases", () => {
  test.skipIf(!real)("reads the canonical account without routing or consent changes", async () => {
    const canonical = await fixture("core");
    const alias = await aliasFor(canonical);
    const fetch = provider();
    expect(
      (await fetchOrganizationCodexUsageForAccount(client!.db, settings, alias, fetch)).status,
    ).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [row] = await shared!.admin`select status, allocator_enabled, extra_credits_enabled,
      refresh_generation from subscription_connections where id = ${canonical.credentialId}`;
    expect(row).toMatchObject({
      status: "active",
      allocator_enabled: false,
      extra_credits_enabled: false,
    });
    expect(Number(row!.refresh_generation)).toBe(1);
  });

  test.skipIf(!real)(
    "shares one canonical refresh lock and updates the canonical generation",
    async () => {
      const canonical = await fixture("core", true);
      const alias = await aliasFor(canonical);
      const fetch = provider();
      const accessToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
      const refresh = mock(async () => ({
        accessToken,
        refreshToken: "alias-rotated",
        idToken: "synthetic-id",
      }));
      const results = await Promise.all(
        [canonical, alias].map((input) =>
          fetchOrganizationCodexUsageForAccount(client!.db, settings, input, fetch, refresh),
        ),
      );
      expect(results.map((result) => result.status)).toEqual(["ok", "ok"]);
      expect(refresh).toHaveBeenCalledTimes(1);
      const [row] = await shared!.admin`select refresh_generation from subscription_connections
      where id = ${canonical.credentialId}`;
      expect(Number(row!.refresh_generation)).toBe(2);
    },
  );

  test.skipIf(!real)(
    "rejects foreign and workspace-managed aliases before provider I/O",
    async () => {
      const canonical = await fixture("core");
      const alias = await aliasFor(canonical);
      const other = await fixture("core");
      const fetch = provider();
      expect(
        (
          await fetchOrganizationCodexUsageForAccount(
            client!.db,
            settings,
            { ...other, credentialId: alias.credentialId },
            fetch,
          )
        ).status,
      ).toBe("error");
      const managedAlias = await aliasFor(await fixture("core", false, true));
      expect(
        (await fetchOrganizationCodexUsageForAccount(client!.db, settings, managedAlias, fetch))
          .status,
      ).toBe("error");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

function provider() {
  return joined(
    mock(
      async () =>
        new Response(
          JSON.stringify({
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                used_percent: 75,
                limit_window_seconds: 18000,
                reset_after_seconds: 120,
              },
            },
            credits: { has_credits: true, unlimited: false, balance: "120.50" },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ) as ReturnType<typeof mock> & CodexFetch,
  );
}

for (const mode of ["legacy", "core"] as const) {
  describe(`organization Codex usage (${mode})`, () => {
    test.skipIf(!real)(
      "retries a rejected unexpired bearer once and surfaces repeated rejection",
      async () => {
        const input = await fixture(mode);
        const success = provider();
        let calls = 0;
        const fetch = joined<CodexFetch>(async (...args) =>
          ++calls === 1 ? new Response(null, { status: 401 }) : success(...args),
        );
        const refresh = mock(async () => ({
          accessToken: "fresh-access",
          refreshToken: "fresh-refresh",
          idToken: "synthetic-id",
        }));
        expect(
          (await fetchOrganizationCodexUsageForAccount(client!.db, settings, input, fetch, refresh))
            .status,
        ).toBe("ok");
        expect(calls).toBe(2);
        expect(refresh).toHaveBeenCalledTimes(1);
        const failed = await fixture(mode);
        calls = 0;
        const denied = joined<CodexFetch>(async () => {
          calls += 1;
          return new Response(null, { status: 401 });
        });
        expect(
          (
            await fetchOrganizationCodexUsageForAccount(
              client!.db,
              settings,
              failed,
              denied,
              refresh,
            )
          ).reason,
        ).toBe("needs_relogin");
        expect(calls).toBe(2);
        expect(refresh).toHaveBeenCalledTimes(2);
      },
    );
    test.skipIf(!real)(
      "reads paused, unassigned accounts without changing routing or consent",
      async () => {
        const input = await fixture(mode);
        const fetch = provider();
        const result = await fetchOrganizationCodexUsageForAccount(
          client!.db,
          settings,
          input,
          fetch,
        );
        expect(result.status).toBe("ok");
        expect(result.credits?.balance).toBe("120.50");
        expect(fetch).toHaveBeenCalledTimes(1);
        const rows =
          mode === "legacy"
            ? await shared!
                .admin`select allocator_enabled, extra_credits_enabled, allowed_workspace_ids
            from codex_subscription_credentials where id = ${input.credentialId}`
            : await shared!.admin`select allocator_enabled, extra_credits_enabled
            from subscription_connections where id = ${input.credentialId}`;
        expect(rows[0]).toMatchObject({ allocator_enabled: false, extra_credits_enabled: false });
        if (mode === "legacy") expect(rows[0]!.allowed_workspace_ids).toEqual([]);
      },
    );
    test.skipIf(!real)(
      "denies another organization and a revoked administrator before provider I/O",
      async () => {
        const input = await fixture(mode);
        const other = await fixture(mode);
        const fetch = provider();
        expect(
          (
            await fetchOrganizationCodexUsageForAccount(
              client!.db,
              settings,
              {
                ...input,
                credentialId: other.credentialId,
              },
              fetch,
            )
          ).status,
        ).toBe("error");
        await shared!.admin`update organization_memberships set role = 'member'
        where account_id = ${input.organizationId} and subject_id = ${input.actorSubjectId}`;
        expect(
          (await fetchOrganizationCodexUsageForAccount(client!.db, settings, input, fetch)).status,
        ).toBe("error");
        expect(fetch).not.toHaveBeenCalled();
      },
    );
    test.skipIf(!real)(
      "serializes stale bearer refresh and commits permanent sign-in failure",
      async () => {
        const input = await fixture(mode, true);
        const fetch = provider();
        const accessToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
        const refresh = mock(async () => ({
          accessToken,
          refreshToken: "rotated-refresh",
          idToken: "synthetic-id",
        }));
        const results = await Promise.all(
          [1, 2].map(() =>
            fetchOrganizationCodexUsageForAccount(client!.db, settings, input, fetch, refresh),
          ),
        );
        expect(results.map((r) => r.status)).toEqual(["ok", "ok"]);
        expect(refresh).toHaveBeenCalledTimes(1);
        const failed = await fixture(mode, true);
        const refusal = mock(async () => {
          throw new CodexReloginRequired("Synthetic expired sign-in");
        });
        expect(
          (
            await fetchOrganizationCodexUsageForAccount(
              client!.db,
              settings,
              failed,
              fetch,
              refusal,
            )
          ).reason,
        ).toBe("needs_relogin");
        const rows =
          mode === "legacy"
            ? await shared!
                .admin`select status from codex_subscription_credentials where id = ${failed.credentialId}`
            : await shared!
                .admin`select status from subscription_connections where id = ${failed.credentialId}`;
        expect(rows[0]!.status).toBe("needs_relogin");
      },
    );
    test.skipIf(!real)("refuses cutover maintenance without falling back", async () => {
      const input = await fixture(mode);
      await shared!.admin`insert into subscription_provider_cutovers (account_id, provider, enabled)
        values (${input.organizationId}, 'codex', false)
        on conflict (account_id, provider) do update set enabled = false`;
      const fetch = provider();
      expect(
        (await fetchOrganizationCodexUsageForAccount(client!.db, settings, input, fetch)).status,
      ).toBe("error");
      expect(fetch).not.toHaveBeenCalled();
    });
    for (const change of ["quarantine", "maintenance"] as const) {
      test.skipIf(!real)(
        `retains rotated tokens when ${change} starts during refresh`,
        async () => {
          const input = await fixture(mode, true);
          const fetch = provider();
          const refresh = mock(async () => {
            if (change === "maintenance") {
              await shared!
                .admin`insert into subscription_provider_cutovers (account_id, provider, enabled)
              values (${input.organizationId}, 'codex', false)
              on conflict (account_id, provider) do update set enabled = false`;
            } else if (mode === "legacy") {
              await shared!
                .admin`update codex_subscription_credentials set status = 'error', last_error = 'Synthetic quarantine'
              where id = ${input.credentialId}`;
            } else {
              await shared!
                .admin`update subscription_connections set status = 'error', last_error = 'Synthetic quarantine'
              where id = ${input.credentialId}`;
            }
            return {
              accessToken: "rotated-access",
              refreshToken: "rotated-refresh",
              idToken: "synthetic-id",
            };
          });
          const result = await fetchOrganizationCodexUsageForAccount(
            client!.db,
            settings,
            input,
            fetch,
            refresh,
          );
          expect(result.status).toBe("error");
          expect(fetch).not.toHaveBeenCalled();
          const rows =
            mode === "legacy"
              ? await shared!
                  .admin`select version as generation, status, last_error, credential_encrypted
              from codex_subscription_credentials where id = ${input.credentialId}`
              : await shared!
                  .admin`select refresh_generation as generation, status, last_error, credential_encrypted
              from subscription_connections where id = ${input.credentialId}`;
          expect(Number(rows[0]!.generation)).toBe(2);
          const { decryptEnvironmentValue } = await import("../src/environment-crypto");
          expect(
            JSON.parse(decryptEnvironmentValue(key, rows[0]!.credential_encrypted)).refresh_token,
          ).toBe("rotated-refresh");
          if (change === "quarantine")
            expect(rows[0]).toMatchObject({ status: "error", last_error: "Synthetic quarantine" });
        },
      );
    }
  });
}
