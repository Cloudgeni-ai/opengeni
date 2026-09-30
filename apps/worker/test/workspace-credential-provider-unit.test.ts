import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import { encryptEnvironmentValue, type Database } from "@opengeni/db";
import * as database from "@opengeni/db";
import { verifyOpenGeniSignature, type RunCredentialsRequest } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { verifyCredentialProviderRequest } from "@opengeni/sdk";
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
  initiatorContext: {},
  sandboxOs: "linux",
  effectiveSandboxBackend: "none",
} as RunCredentialsRequest;
const settings = testSettings({
  environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
});
const secret = "signing-secret";
const row = {
  id: "provider",
  workspaceId: scope.workspaceId,
  enabled: true,
  url: "https://product.example/credentials",
  timeoutMs: 2000,
  secretEncrypted: encryptEnvironmentValue(environmentsEncryptionKeyBytes(settings)!, secret),
};

afterEach(() => mock.restore());

describe("worker integration adapter without PostgreSQL", () => {
  test.each(["human", "service", "agent"] as const)(
    "signs the exact %s initiator context without treating it as human authority",
    async (kind) => {
      const initiator =
        kind === "human"
          ? { kind: "subject" as const, subjectId: "accepted-human", label: "Human" }
          : { kind: "service" as const, subjectId: "host:scheduled", label: "Scheduled check" };
      const context = {
        occurrenceId: "accepted-occurrence",
        nested: { exact: ["é", 3, false] },
        updateIds: ["accepted-update-1", "accepted-update-2"],
        ...(kind === "agent"
          ? {
              via: [
                {
                  kind: "agent",
                  sessionId: "parent",
                  turnId: "parent-turn",
                  attemptId: "parent-attempt",
                  executionGeneration: 1,
                },
              ],
            }
          : {}),
      };
      let received: Awaited<ReturnType<typeof verifyCredentialProviderRequest>> | undefined;
      const resolver = await workspaceCredentialProviderResolver(
        {} as Database,
        settings,
        scope,
        null,
        {
          resolveProvider: async () => row as never,
          resolveHuman: async () => null,
          fetch: async (_url, init) => {
            received = await verifyCredentialProviderRequest({
              body: String(init?.body),
              headers: new Headers(init?.headers),
              secret,
            });
            return Response.json({ status: "not_applicable" });
          },
        },
      );
      expect(await resolver!({ ...input, initiator, initiatorContext: context })).toEqual({
        status: "not_applicable",
        ...scope,
      });
      expect(received?.initiatorContext).toEqual({ kind, initiator, context });
      expect(received?.initiatingHuman).toBeNull();
      expect(received?.initiatingHumanSubjectId).toBeNull();
    },
  );

  test("a paused workspace registration suppresses the deployment credential port", async () => {
    spyOn(database, "resolveWorkspaceCredentialProvider").mockResolvedValue({
      ...row,
      enabled: false,
    } as never);
    spyOn(database, "getSessionRootId").mockResolvedValue(scope.sessionId);
    let called = false;
    const resolver = await bindRunCredentialResolver({
      effectiveTools: [],
      db: {} as Database,
      settings,
      ...scope,
      session: { id: scope.sessionId, mcpServers: [] } as never,
      turn: { id: "turn", initiator: input.initiator, initiatorContext: {}, tools: [] } as never,
      attemptId: "attempt",
      effectiveSandboxBackend: "docker",
      variableSet: null,
      connectionCredentials: {
        runCredentials: async () => {
          called = true;
          return { status: "ok", ...scope, environment: { TOKEN: "must-not-be-used" } };
        },
      },
    });
    expect(resolver).not.toBeNull();
    expect(await resolver!.resolve({ purpose: "provision", forceRefresh: false })).toBeNull();
    expect(called).toBe(false);
  });

  test("disabled workspace overrides return explicit opt-out without invoking a provider", async () => {
    const resolver = await workspaceCredentialProviderResolver(
      {} as Database,
      settings,
      scope,
      null,
      {
        resolveProvider: async () => ({ ...row, enabled: false }) as never,
        fetch: async () => {
          throw new Error("paused provider must not be called");
        },
      },
    );
    expect(resolver).not.toBeNull();
    expect(await resolver!(input)).toEqual({ status: "not_applicable", ...scope });
  });

  test("renewal uses the rotated signing secret and never switches to another registration", async () => {
    let current = row;
    const signatures: { body: string; signature: string | null }[] = [];
    const resolver = await workspaceCredentialProviderResolver(
      {} as Database,
      settings,
      scope,
      null,
      {
        resolveProvider: async () => current as never,
        resolveHuman: async () => null,
        fetch: async (_url, init) => {
          signatures.push({
            body: String(init?.body),
            signature: new Headers(init?.headers).get("OpenGeni-Signature"),
          });
          return Response.json({ status: "ok" });
        },
      },
    );
    await resolver!(input);
    current = {
      ...row,
      secretEncrypted: encryptEnvironmentValue(
        environmentsEncryptionKeyBytes(settings)!,
        "rotated-secret",
      ),
    };
    await resolver!({ ...input, purpose: "renewal" });
    expect(await verifyOpenGeniSignature({ ...signatures[0]!, secret })).toBe(true);
    expect(await verifyOpenGeniSignature({ ...signatures[1]!, secret: "rotated-secret" })).toBe(
      true,
    );
    expect(await verifyOpenGeniSignature({ ...signatures[1]!, secret })).toBe(false);
    current = { ...current, id: "inherited-other-provider" };
    expect(await resolver!({ ...input, purpose: "renewal" })).toEqual({
      status: "not_applicable",
      ...scope,
    });
    expect(signatures).toHaveLength(2);
  });
  test("sandbox-free turns do not expand deployment run-credential port use", async () => {
    let called = false;
    const resolver = await bindRunCredentialResolver({
      effectiveTools: [],
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
        mcpServers: [{ id: "custom", url: "https://product.example/mcp" }],
        resolveHuman: async (_db, receivedScope, subject, turnId) => {
          expect(receivedScope).toMatchObject(scope);
          expect(turnId).toBe(input.turnId);
          seenSubject = subject;
          return human;
        },
        fetch: async (_url, init) => {
          seenBody = JSON.parse(String(init?.body));
          return Response.json({
            status: "ok",
            mcp: [{ url: "https://product.example/mcp", headers: { Authorization: "mcp-secret" } }],
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
      initiatorContext: { kind: "human", initiator: input.initiator, context: {} },
      lane: "workspace",
      mcpServers: [{ id: "custom", url: "https://product.example/mcp" }],
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
            mcp: [{ url: "https://product.example/mcp", headers: { Host: "do-not-leak" } }],
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

  test("organization provider posts its lane and no targets for an unattached session", async () => {
    let body: Record<string, unknown> | undefined;
    const resolver = await workspaceCredentialProviderResolver(
      {} as Database,
      settings,
      scope,
      null,
      {
        resolveProvider: async () => ({ ...row, workspaceId: null }) as never,
        resolveHuman: async () => null,
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body));
          return Response.json({ status: "ok" });
        },
      },
    );
    await resolver!(input);
    expect(body).toMatchObject({ lane: "organization", mcpServers: [] });
  });
});
