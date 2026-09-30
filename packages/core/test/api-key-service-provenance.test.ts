import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createApiKey,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  getSessionTurnPersonalConnectionDelegations,
} from "@opengeni/db";
import { requireAccessGrantAuthorization } from "../src/access";
import { creationInitiatorForGrant } from "../src/domain/sessions";
import { personalConnectionDelegationSourceForGrant } from "../src/domain/personal-connection-delegations";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("api-key-service-provenance");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("API-key service provenance acceptance", () => {
  for (const credentialKind of ["organization", "workspace"] as const) {
    test(`${credentialKind} key freezes service without human and keeps its permission boundary`, async () => {
      const access = await bootstrapWorkspace(client.db, {
        accountExternalSource: "service-test",
        accountExternalId: crypto.randomUUID(),
        accountName: "Service test",
        workspaceExternalSource: "service-test",
        workspaceExternalId: crypto.randomUUID(),
        workspaceName: "Service test",
        subjectId: `user:${crypto.randomUUID()}`,
      });
      const scope = access.workspaceGrants[0]!;
      const token = crypto.randomUUID();
      const key = await createApiKey(client.db, {
        accountId: scope.accountId,
        ...(credentialKind === "workspace" ? { workspaceId: scope.workspaceId } : {}),
        credentialKind,
        name: "test",
        prefix: "test",
        keyHash: createHash("sha256").update(token).digest("hex"),
        permissions: ["workspace:read", "sessions:create"],
      });
      const app = new Hono();
      const deps = { db: client.db, settings: testSettings({ productAccessMode: "configured" }) };
      app.post("/create", async (c) => {
        const authorization = await requireAccessGrantAuthorization(
          c,
          deps,
          scope.workspaceId,
          "sessions:create",
        );
        const grant = authorization.grant;
        const frozen = creationInitiatorForGrant(grant);
        expect(authorization.contextIntegrity).toBe(true);
        expect(grant.subjectId).toBe(`api_key:${key.id}`);
        expect(grant.permissions).toEqual(["workspace:read", "sessions:create"]);
        expect(personalConnectionDelegationSourceForGrant(grant)).toEqual({ kind: "none" });
        const session = await createSession(client.db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          initialMessage: "drift",
          resources: [],
          metadata: {},
          model: "test",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: frozen.initiator!,
          createdByContext: frozen.context!,
        });
        const started = await initializeSessionStartAtomically(client.db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId: session.id,
          reasoningEffortFallback: "medium",
          createdEventPayload: {},
        });
        expect(started.turn?.initiator).toEqual({ kind: "service", subjectId: "cloudgeni:drift" });
        expect(started.turn?.initiatorContext).toMatchObject({ job: "42", scheduled: true });
        const [stored] =
          await shared.admin`select initiating_human_subject_id from session_turns where id = ${started.turn!.id}`;
        expect(stored?.initiating_human_subject_id).toBeNull();
        expect(
          await getSessionTurnPersonalConnectionDelegations(
            client.db,
            scope.workspaceId,
            session.id,
            started.turn!.id,
          ),
        ).toEqual([]);
        return c.json({ ok: true });
      });
      app.post("/denied", async (c) =>
        c.json(
          await requireAccessGrantAuthorization(c, deps, scope.workspaceId, "sessions:control"),
        ),
      );
      const headers = {
        authorization: `Bearer ${token}`,
        "x-opengeni-service-initiator": "cloudgeni:drift",
        "x-opengeni-service-context": '{"job":"42","scheduled":true}',
      };
      expect((await app.request("/create", { method: "POST", headers })).status).toBe(200);
      expect((await app.request("/denied", { method: "POST", headers })).status).toBe(403);
      const conflict = await app.request("/create", {
        method: "POST",
        headers: { ...headers, "x-opengeni-external-actor": "{}" },
      });
      expect(conflict.status).toBe(422);
      expect(await conflict.text()).toContain("mutually exclusive");
    }, 60_000);
  }
});
