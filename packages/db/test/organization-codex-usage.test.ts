import { expect, mock, spyOn, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "../src/database";
import { encryptEnvironmentValue, decryptEnvironmentValue } from "../src/environment-crypto";
import { readOrganizationCodexUsage } from "../src/organization-codex-usage";
import * as aliases from "../src/subscription-core-repository";
import * as compatibility from "../src/subscription-core-codex-compat";

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
      if (/set local lock_timeout|select pg_advisory_xact_lock/.test(query.sql))
        return { rows: [] };
      throw new Error("Unexpected database operation");
    },
  } as unknown as Database;
  const disposition = spyOn(compatibility, "readCodexCutoverDisposition").mockImplementation(
    async () => (maintenance ? "maintenance" : "core"),
  );
  const alias = spyOn(aliases, "resolveSubscriptionConnectionId").mockResolvedValue(credentialId);
  const provider = mock(async () => new Response("{}"));
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
