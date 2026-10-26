// Credential profiles (0997) against real PostgreSQL as the application role:
// the workspace profile plus session additions that child sessions inherit,
// validation, clearing, audit with names only, and the per-command
// environment a child session's commands receive. Every value is fake.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, createSession, ensureManagedAccessForUser, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createStaticSecretResolver } from "@opengeni/vaults/testing";
import {
  CredentialProfileError,
  createSessionCredentialEnvironment,
  getSessionCredentialProfile,
  getWorkspaceCredentialProfile,
  setCredentialProfile,
} from "../src";

setDefaultTimeout(180_000);

/** A secret reference, assembled so no tool on the way resolves it early. */
const ref = (path: string) => ["{", "{secret:", path, "}}"].join("");

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("credential-profiles");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function world() {
  const db = client!.db;
  const userId = `credential-profiles-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Credential profiles",
  });
  const grant = access.workspaceGrants[0]!;
  const session = async (parentSessionId: string | null = null) =>
    await createSession(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "credential profiles",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      ...(parentSessionId ? { parentSessionId } : {}),
    });
  return {
    db,
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: `user:${userId}`,
    session,
  };
}

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "credential profiles",
  () => {
    test("a child session inherits the workspace and parent profiles; nearer levels win", async () => {
      if (!client) return;
      const w = await world();
      const parent = await w.session();
      const child = await w.session(parent.id);
      const grandchild = await w.session(child.id);
      const sibling = await w.session();
      const base = { accountId: w.accountId, workspaceId: w.workspaceId, subjectId: w.subjectId };
      await setCredentialProfile(w.db, {
        ...base,
        sessionId: null,
        profile: {
          entries: [
            { name: "GH_TOKEN", reference: ref("cloud-auth/GITHUB_TOKEN/value") },
            { name: "AZURE_CLIENT_ID", reference: ref("cloud-auth/AZURE_CLIENT_ID/value") },
          ],
        },
      });
      await setCredentialProfile(w.db, {
        ...base,
        sessionId: parent.id,
        profile: {
          entries: [{ name: "AZURE_CLIENT_ID", reference: ref("other/AZURE_CLIENT_ID/value") }],
          gitHelper: true,
        },
      });
      await setCredentialProfile(w.db, {
        ...base,
        sessionId: grandchild.id,
        profile: { entries: [{ name: "EXTRA", reference: ref("Extra") }] },
      });

      const childView = await getSessionCredentialProfile(w.db, {
        workspaceId: w.workspaceId,
        sessionId: child.id,
      });
      expect(childView.profile).toBeNull();
      expect(childView.effective).toEqual({
        entries: [
          {
            name: "GH_TOKEN",
            reference: ref("cloud-auth/GITHUB_TOKEN/value"),
            source: { scope: "workspace", sessionId: null },
          },
          {
            name: "AZURE_CLIENT_ID",
            reference: ref("other/AZURE_CLIENT_ID/value"),
            source: { scope: "session", sessionId: parent.id },
          },
        ],
        gitHelper: true,
      });
      const grandchildView = await getSessionCredentialProfile(w.db, {
        workspaceId: w.workspaceId,
        sessionId: grandchild.id,
      });
      expect(grandchildView.profile?.entries).toEqual([{ name: "EXTRA", reference: ref("Extra") }]);
      expect(grandchildView.effective.entries.map((entry) => entry.name)).toEqual([
        "GH_TOKEN",
        "AZURE_CLIENT_ID",
        "EXTRA",
      ]);
      const siblingView = await getSessionCredentialProfile(w.db, {
        workspaceId: w.workspaceId,
        sessionId: sibling.id,
      });
      expect(siblingView.effective.entries.map((entry) => entry.reference)).toEqual([
        ref("cloud-auth/GITHUB_TOKEN/value"),
        ref("cloud-auth/AZURE_CLIENT_ID/value"),
      ]);
      expect(siblingView.effective.gitHelper).toBe(false);

      // The child's commands receive the inherited variables.
      const credentials = createSessionCredentialEnvironment({
        db: w.db,
        workspaceId: w.workspaceId,
        sessionId: child.id,
        resolver: createStaticSecretResolver({
          "cloud-auth/GITHUB_TOKEN/value": "ghp_fakeInheritedToken",
          "other/AZURE_CLIENT_ID/value": "fake-client-id",
        }),
      });
      const { env, notes } = await credentials.forCommand({
        surface: "shell",
        toolName: "exec_command",
      });
      expect(notes).toEqual([]);
      expect(env.GH_TOKEN).toBe("ghp_fakeInheritedToken");
      expect(env.AZURE_CLIENT_ID).toBe("fake-client-id");
      expect(env.GIT_CONFIG_COUNT).toBe("2");
    });

    test("validation, escaped references, clearing and audit without references", async () => {
      if (!client) return;
      const w = await world();
      const base = { accountId: w.accountId, workspaceId: w.workspaceId, subjectId: w.subjectId };
      const invalid = async (entries: Array<{ name: string; reference: string }>) => {
        try {
          await setCredentialProfile(w.db, { ...base, sessionId: null, profile: { entries } });
        } catch (error) {
          expect(error).toBeInstanceOf(CredentialProfileError);
          expect((error as CredentialProfileError).status).toBe(422);
          return (error as CredentialProfileError).message;
        }
        throw new Error("expected a validation error");
      };
      expect(await invalid([{ name: "OPENGENI_TOKEN", reference: ref("A") }])).toContain(
        "reserved",
      );
      expect(
        await invalid([
          { name: "GH_TOKEN", reference: ref("A") },
          { name: "gh_token", reference: ref("B") },
        ]),
      ).toContain("listed twice");
      expect(await invalid([{ name: "GH_TOKEN", reference: "ghp_plaintext" }])).toContain(
        "exactly one secret reference",
      );
      expect(
        await invalid([{ name: "KEY", reference: ["{", "{secretfile:Key}}"].join("") }]),
      ).toContain("secretfile");
      expect(await invalid([{ name: "1BAD", reference: ref("A") }])).toContain("letters");

      // An escaped reference (as written for hand-off tools) is stored plain.
      const saved = await setCredentialProfile(w.db, {
        ...base,
        sessionId: null,
        profile: { entries: [{ name: "GH_TOKEN", reference: `\\${ref("cloud-auth/T/value")}` }] },
      });
      expect(saved?.entries).toEqual([{ name: "GH_TOKEN", reference: ref("cloud-auth/T/value") }]);
      expect(
        (await getWorkspaceCredentialProfile(w.db, { workspaceId: w.workspaceId })).profile
          ?.entries,
      ).toEqual([{ name: "GH_TOKEN", reference: ref("cloud-auth/T/value") }]);

      expect(
        await setCredentialProfile(w.db, { ...base, sessionId: null, profile: { entries: [] } }),
      ).toBeNull();
      expect(
        (await getWorkspaceCredentialProfile(w.db, { workspaceId: w.workspaceId })).profile,
      ).toBeNull();

      const audit = await shared!.admin<{ action: string; metadata: unknown }[]>`
        select action, metadata from audit_events
        where workspace_id = ${w.workspaceId}::uuid and action like 'credential_profile.%'
        order by occurred_at`;
      expect(audit.map((row) => row.action)).toEqual([
        "credential_profile.updated",
        "credential_profile.cleared",
      ]);
      expect(JSON.stringify(audit)).toContain("GH_TOKEN");
      expect(JSON.stringify(audit)).not.toContain("secret:");

      try {
        await setCredentialProfile(w.db, {
          ...base,
          sessionId: crypto.randomUUID(),
          profile: { entries: [{ name: "GH_TOKEN", reference: ref("A") }] },
        });
        throw new Error("expected session not found");
      } catch (error) {
        expect((error as CredentialProfileError).status).toBe(404);
      }
    });
  },
);
