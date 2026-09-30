import { describe, expect, test } from "bun:test";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import { encryptEnvironmentValue, type Database } from "@opengeni/db";
import type { RunCredentialsRequest } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import {
  credentialProviderRequestBody,
  workspaceCredentialProviderResolver,
} from "../src/activities/workspace-credential-provider";
import {
  runCredentialAuthNeededPayloads,
  runCredentialModelNote,
  bindRunCredentialResolver,
} from "../src/activities/run-credentials";
import { normalizeRunCredentialsResolution } from "@opengeni/runtime";

const scope = { accountId: "account", workspaceId: "workspace", sessionId: "session" };
const input = {
  ...scope,
  rootSessionId: "root",
  parentSessionId: null,
  turnId: "turn",
  attemptId: "attempt",
  purpose: "provision",
  forceRefresh: false,
  initiator: { kind: "subject", subjectId: "accepted-sender" },
  sandboxOs: "linux",
  effectiveSandboxBackend: "none",
} as RunCredentialsRequest;
const settings = testSettings({
  environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
});
const secret = "signing-secret";
const row = {
  enabled: true,
  url: "https://product.example/credentials",
  timeoutMs: 2000,
  secretEncrypted: encryptEnvironmentValue(environmentsEncryptionKeyBytes(settings)!, secret),
};

describe("worker integration adapter without PostgreSQL", () => {
  test("sandbox-free turns do not expand deployment run-credential port use", async () => {
    let called = false;
    const resolver = await bindRunCredentialResolver({
      db: {} as Database,
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      session: { id: scope.sessionId } as never,
      turn: {} as never,
      attemptId: "attempt",
      effectiveSandboxBackend: "none",
      variableSet: null,
      connectionCredentials: {
        runCredentials: async () => {
          called = true;
          return { status: "not_applicable", ...scope };
        },
      },
    });
    expect(resolver).toBeNull();
    expect(called).toBe(false);
  });

  test("posts the exact accepted human identity, independent of initiator and session creator", async () => {
    const human = {
      subjectId: "accepted-human",
      externalIdentity: { source: "acme", externalId: "alice" },
    };
    let seenBody: Record<string, unknown> | undefined;
    let seenSubject: string | null = null;
    const resolver = await workspaceCredentialProviderResolver(
      {} as Database,
      settings,
      scope,
      human.subjectId,
      {
        resolveProvider: async () => row as never,
        resolveHuman: async (_db, receivedScope, subject) => {
          expect(receivedScope).toMatchObject(scope);
          seenSubject = subject;
          return human;
        },
        fetch: async (_url, init) => {
          seenBody = JSON.parse(String(init?.body));
          return Response.json({
            status: "ok",
            mcp: [{ server: "custom", headers: { Authorization: "mcp-secret" } }],
          });
        },
      },
    );
    const resolution = await resolver!(input);
    expect(seenSubject).toBe("accepted-human");
    expect(seenBody).toMatchObject({
      initiatingHumanSubjectId: "accepted-human",
      initiatingHuman: human,
      initiator: input.initiator,
    });
    const material = normalizeRunCredentialsResolution(resolution, scope)!;
    expect(material.mcp?.[0]?.headers.Authorization).toBe("mcp-secret");
    expect(runCredentialAuthNeededPayloads(material)).toEqual([]);
    expect(runCredentialModelNote(material)).toBeUndefined();
  });

  test("a missing accepted human remains null instead of deriving a creator or external label", () => {
    expect(credentialProviderRequestBody(input, null)).toMatchObject({
      initiatingHumanSubjectId: null,
      initiatingHuman: null,
    });
    const human = { subjectId: "local-human", externalIdentity: null };
    expect(credentialProviderRequestBody(input, human.subjectId, human).initiatingHuman).toEqual(
      human,
    );
  });

  test("invalid MCP responses produce value-free notices initially and value-free renewal failures", async () => {
    const resolver = await workspaceCredentialProviderResolver(
      {} as Database,
      settings,
      scope,
      null,
      {
        resolveProvider: async () => row as never,
        resolveHuman: async () => null,
        fetch: async () =>
          Response.json({
            status: "ok",
            mcp: [{ server: "custom", headers: { Host: "do-not-leak" } }],
          }),
      },
    );
    const first = await resolver!(input);
    expect(JSON.stringify(first)).toContain("invalid response body");
    expect(JSON.stringify(first)).not.toContain("do-not-leak");
    await expect(resolver!({ ...input, purpose: "renewal", forceRefresh: true })).rejects.toThrow(
      "invalid response body",
    );
  });

  test("absence of a matching enabled workspace/org provider preserves host fallback", async () => {
    const resolver = await workspaceCredentialProviderResolver(
      {} as Database,
      settings,
      scope,
      null,
      {
        resolveProvider: async () => null,
        resolveHuman: async () => {
          throw new Error("must not resolve");
        },
      },
    );
    expect(resolver).toBeNull();
  });
});
