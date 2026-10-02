import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  metadataWithTurnExecutionPolicyV1,
  signDelegatedAccessToken,
  verifyDelegatedAccessToken,
  type DelegatedAccessTokenPayload,
} from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { codemodeSessionRequest } from "../src/codemode";

const delegationSecret = "codemode-restriction-test";
const settings = testSettings({ productAccessMode: "managed", delegationSecret });
const policy = resolveTurnExecutionPolicyV1(settings, {
  modelId: "scripted-model",
  requestedModelId: null,
  modelSource: "session",
  reasoningEffort: "high",
  reasoningSource: "session",
});
const restores: (() => void)[] = [];
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
afterEach(() => {
  while (restores.length) restores.pop()!();
});

describe("Codemode SDK proxy inherited setup restriction", () => {
  test.each(["bearer", "turn", "session", "none", "untrustedMetadata"] as const)(
    "%s provenance reaches the actual proxy signer without changing the permission ceiling",
    async (source) => {
      const authority = {
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        executionGeneration: 1,
        subjectId: "sandbox:codemode-fixture",
      };
      const restrictedMetadata = metadataWithTurnExecutionPolicyV1(
        {},
        {
          ...policy,
          credentialRestriction: "developer_setup",
        },
      );
      // Ownership authorization has its own integration coverage. Here the
      // active pointer/catalog are checked by the real proxy function, and
      // setup provenance is resolved from a genuinely signed incoming bearer.
      track(spyOn(core, "requireSessionAuthorization").mockResolvedValue(null));
      track(
        spyOn(db, "getActiveSessionTurnForExecution").mockResolvedValue({
          id: authority.turnId,
          status: "running",
          activeAttemptId: authority.attemptId,
          executionGeneration: 1,
          metadata: source === "turn" ? restrictedMetadata : {},
        } as never),
      );
      track(
        spyOn(db, "getAttemptToolCatalog").mockResolvedValue({
          version: 1,
          ...authority,
          generation: 1,
          digest: "0".repeat(64),
          createdAt: new Date().toISOString(),
          entries: [],
        } as never),
      );
      track(
        spyOn(db, "getSession").mockResolvedValue({
          id: authority.sessionId,
          firstPartyMcpTools: ["session_create"],
          firstPartyMcpPermissions: ["workspace:read", "sessions:create"],
          metadata:
            source === "session"
              ? restrictedMetadata
              : source === "untrustedMetadata"
                ? { credentialRestriction: "developer_setup" }
                : {},
        } as never),
      );
      const bearer = await signDelegatedAccessToken(delegationSecret, {
        ...authority,
        principalKind: "agent_attempt",
        permissions: ["codemode:call"],
        ...(source === "bearer" ? { credentialRestriction: "developer_setup" as const } : {}),
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      const deps = { db: {} as never, settings, managedAuth: null } as core.ApiRouteDeps;
      let proxyClaims: DelegatedAccessTokenPayload | null = null;
      const app = new Hono().post("/", async (c) => {
        const grant = await core.requireAccessGrant(c, deps, authority.workspaceId);
        const rewritten = await codemodeSessionRequest(
          deps,
          grant,
          c.req.raw,
          "/v1/workspaces/site-host/sessions",
        );
        proxyClaims = await verifyDelegatedAccessToken(
          delegationSecret,
          rewritten.headers.get("authorization")!.slice("Bearer ".length),
        );
        return c.text("proxied");
      });
      const response = await app.request("/", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ metadata: restrictedMetadata }),
      });
      expect(response.status).toBe(200);
      expect(proxyClaims).not.toBeNull();
      expect(proxyClaims!.permissions).toEqual(["workspace:read", "sessions:create"]);
      expect(proxyClaims!.credentialRestriction).toBe(
        source === "none" || source === "untrustedMetadata" ? undefined : "developer_setup",
      );
      expect(proxyClaims).toMatchObject(authority);
    },
  );
});
