import { describe, expect, test } from "bun:test";
import type { ConnectionMetadata } from "@opengeni/contracts";
import { decideOAuthAccountConnection } from "../src/integrations/oauth-account-identity";
import {
  MAX_REVERIFIED_LOGINS,
  reverifyLoginsBlockingNewAccount,
} from "../src/integrations/oauth-account-reverify";
import { accountIdentityWithRetry, mcpToolAccountIdentity } from "../src/integrations/oauth-client";
import {
  accountIdentityKeysFor,
  accountIdentityVerifierFor,
  type AccountIdentityVerifier,
} from "../src/integrations/oauth-profiles";

const LINEAR = "https://mcp.linear.app/mcp";
const ISSUER = "https://mcp.linear.app";
const verifier = accountIdentityVerifierFor(LINEAR) as Extract<
  AccountIdentityVerifier,
  { kind: "mcp_tool" }
>;
const identityKeys = accountIdentityKeysFor(null, LINEAR);
const json = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const anna = { id: "user-anna", email: "anna@example.test", displayName: "anna" };
const annaElsewhere = { id: "user-anna-kestrel", email: "anna@kestrel.test", displayName: "anna" };

/** A Linear MCP whose first `slowCalls` get_user reads never answer until aborted. */
function linearClient(user: Record<string, unknown>, slowCalls: number) {
  let userReads = 0;
  return {
    get userReads() {
      return userReads;
    },
    client: {
      callTool: ({ name }: { name: string }, options: { signal?: AbortSignal }) => {
        if (name === "get_workspace") return Promise.resolve(json({ id: "org", name: "Org" }));
        userReads += 1;
        if (userReads > slowCalls) return Promise.resolve(json(user));
        return new Promise((_resolve, reject) => {
          const signal = options.signal!;
          const abort = () =>
            reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
          if (signal.aborted) abort();
          signal.addEventListener("abort", abort, { once: true });
        });
      },
    } as never,
  };
}

function readIdentity(client: never, budgetMs: number) {
  return mcpToolAccountIdentity(
    client,
    verifier,
    ["get_user", "get_workspace"],
    budgetMs,
    new AbortController().signal,
  );
}

function login(id: string, identity: Record<string, string> = {}): ConnectionMetadata {
  return {
    id,
    workspaceId: "workspace",
    subjectId: "owner",
    providerDomain: "mcp.linear.app",
    kind: "oauth2",
    status: "active",
    version: 1,
    grantedScopes: [],
    metadata: { mcpUrl: LINEAR, authorizationServerIssuer: ISSUER, ...identity },
    createdAt: `2026-11-16T16:0${id.length % 10}:00.000Z`,
  } as ConnectionMetadata;
}

function decision(accounts: readonly ConnectionMetadata[], incoming: Record<string, string>) {
  return {
    accounts,
    ownerSubjectId: "owner",
    requesterSubjectId: "owner",
    providerDomain: "mcp.linear.app",
    mcpUrl: LINEAR,
    metadata: { mcpUrl: LINEAR, authorizationServerIssuer: ISSUER, ...incoming },
    grantedScopes: [],
    identityKeys,
  };
}

describe("a second account after a slow first identity read", () => {
  test("reproduction: one slow get_user saves the first login unverified and refuses the next", async () => {
    const first = linearClient(anna, 1);
    const check = await readIdentity(first.client, 30);
    expect(check).toEqual({ failure: "timeout" });
    const second = await readIdentity(linearClient(annaElsewhere, 0).client, 1_000);
    expect(second.identity?.linearUserId).toBe(annaElsewhere.id);
    expect(decideOAuthAccountConnection(decision([login("first")], second.identity!))).toEqual({
      kind: "reject",
      reason: "account_reconnect_required",
    });
  });

  test("a second identity read after a timeout confirms the first login", async () => {
    const first = linearClient(anna, 1);
    const check = await accountIdentityWithRetry(
      (budgetMs) => readIdentity(first.client, budgetMs),
      () => 30,
      new AbortController().signal,
    );
    expect(first.userReads).toBe(2);
    expect(check.identity?.linearUserId).toBe(anna.id);
    const saved = login("first", check.identity!);
    expect(
      decideOAuthAccountConnection(
        decision([saved], { linearUserId: annaElsewhere.id, linearEmail: annaElsewhere.email }),
      ),
    ).toEqual({ kind: "write" });
  });

  test("an unconfirmed earlier login is checked again, recorded and the new account let through", async () => {
    const stored = new Map([["first", login("first")]]);
    const incoming = { linearUserId: annaElsewhere.id };
    const verified: string[] = [];
    const confirmed = await reverifyLoginsBlockingNewAccount({
      decision: decision([...stored.values()], incoming),
      verify: async (row) => {
        verified.push(row.id);
        // The stored login's own Linear account, slow to answer at first.
        const service = linearClient(anna, 1);
        const check = await accountIdentityWithRetry(
          (budgetMs) => readIdentity(service.client, budgetMs),
          () => 30,
          new AbortController().signal,
        );
        return check.identity;
      },
      save: async (row, identity) => {
        stored.set(row.id, { ...row, metadata: { ...row.metadata, ...identity } });
        return true;
      },
    });
    expect(confirmed).toBe(1);
    expect(verified).toEqual(["first"]);
    expect(stored.get("first")!.metadata.linearUserId).toBe(anna.id);
    // Persisting decides again from the stored rows.
    expect(decideOAuthAccountConnection(decision([...stored.values()], incoming))).toEqual({
      kind: "write",
    });
    // The same account signing in again is still that account.
    expect(
      decideOAuthAccountConnection(decision([...stored.values()], { linearUserId: anna.id })).kind,
    ).toBe("reuse");
  });

  test("a login that still can't be confirmed keeps today's refusal", async () => {
    const failures: string[] = [];
    const saves: string[] = [];
    for (const verify of [
      async () => undefined,
      async () => ({ linearEmail: "anna@example.test" }),
      async () => {
        throw new Error("token refresh failed");
      },
    ]) {
      const accounts = [login("first")];
      const confirmed = await reverifyLoginsBlockingNewAccount({
        decision: decision(accounts, { linearUserId: annaElsewhere.id }),
        verify,
        save: async (row) => {
          saves.push(row.id);
          return true;
        },
        onFailure: (row) => failures.push(row.id),
      });
      expect(confirmed).toBe(0);
      expect(
        decideOAuthAccountConnection(decision(accounts, { linearUserId: annaElsewhere.id })),
      ).toEqual({ kind: "reject", reason: "account_reconnect_required" });
    }
    expect(saves).toEqual([]);
    expect(failures).toEqual(["first"]);
  });

  test("only the refusal it can resolve triggers a check", async () => {
    const calls: string[] = [];
    const verify = async (row: ConnectionMetadata) => {
      calls.push(row.id);
      return { linearUserId: anna.id };
    };
    const save = async () => true;
    const incoming = { linearUserId: annaElsewhere.id };
    // Already decidable: verified logins, or none.
    await reverifyLoginsBlockingNewAccount({
      decision: decision([login("verified", { linearUserId: anna.id })], incoming),
      verify,
      save,
    });
    await reverifyLoginsBlockingNewAccount({ decision: decision([], incoming), verify, save });
    // Reconnecting a chosen login is decided on its own.
    await reverifyLoginsBlockingNewAccount({
      decision: { ...decision([login("first")], incoming), requestedConnectionId: "first" },
      verify,
      save,
    });
    // A login from another account namespace would still refuse it.
    await reverifyLoginsBlockingNewAccount({
      decision: decision(
        [
          login("first"),
          {
            ...login("other"),
            metadata: { mcpUrl: LINEAR, authorizationServerIssuer: "https://elsewhere.test" },
          },
        ],
        incoming,
      ),
      verify,
      save,
    });
    // A login that can't be used isn't checked.
    await reverifyLoginsBlockingNewAccount({
      decision: decision([{ ...login("first"), status: "needs_reauth" }], incoming),
      verify,
      save,
    });
    // Another person's login never blocks, so it is never checked.
    await reverifyLoginsBlockingNewAccount({
      decision: decision([{ ...login("theirs"), subjectId: "someone-else" }], incoming),
      verify,
      save,
    });
    // The number of logins checked for one sign-in is bounded.
    await reverifyLoginsBlockingNewAccount({
      decision: decision(
        Array.from({ length: MAX_REVERIFIED_LOGINS + 1 }, (_, index) => login(`many-${index}`)),
        incoming,
      ),
      verify,
      save,
    });
    expect(calls).toEqual([]);
  });
});

describe("accountIdentityWithRetry", () => {
  const ok = { identity: { linearUserId: "user" } };
  async function run(failures: string[], options: { budgets?: number[]; aborted?: boolean } = {}) {
    const budgets = [...(options.budgets ?? [100, 100])];
    const seen: number[] = [];
    const controller = new AbortController();
    if (options.aborted) controller.abort();
    const result = await accountIdentityWithRetry(
      async (budgetMs) => {
        seen.push(budgetMs);
        const failure = failures.shift();
        return failure ? { failure } : ok;
      },
      () => budgets.shift() ?? 0,
      controller.signal,
    );
    return { result, seen };
  }

  test("reads once more after a transient failure, within what the budget allows", async () => {
    for (const failure of ["timeout", "request_failed", "tool_error", "http_503", "http_429"]) {
      expect(await run([failure], { budgets: [100, 40] })).toEqual({ result: ok, seen: [100, 40] });
    }
  });

  test("never retries a definite answer, an aborted request or a spent budget", async () => {
    for (const failure of ["invalid_identity", "tool_missing", "budget_exhausted", "http_401"]) {
      expect(await run([failure])).toEqual({ result: { failure }, seen: [100] });
    }
    expect(await run(["timeout"], { aborted: true })).toEqual({
      result: { failure: "timeout" },
      seen: [100],
    });
    expect(await run(["timeout"], { budgets: [100, 0] })).toEqual({
      result: { failure: "timeout" },
      seen: [100],
    });
  });

  test("reads at most twice and reports the first failure", async () => {
    expect(await run(["timeout", "request_failed", "timeout"])).toEqual({
      result: { failure: "timeout" },
      seen: [100, 100],
    });
  });
});
