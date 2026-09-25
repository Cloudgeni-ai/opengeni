import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import type { RunCredentialsResolution, Session, SessionTurn } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  encryptEnvironmentValue,
  upsertWorkspaceCredentialProvider,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { verifyCredentialProviderRequest } from "../../../packages/sdk/src/workspace-integrations";
import { bindRunCredentialResolver } from "../src/activities/run-credentials";
import {
  GIT_CREDENTIALS_FILE,
  GIT_CREDENTIALS_FILE_ENV,
} from "../src/activities/workspace-credential-provider";

setDefaultTimeout(60_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient;
const settings = testSettings({ environmentsEncryptionKey: randomBytes(32).toString("base64") });
const secret = `ogcp_${randomBytes(32).toString("base64url")}`;
let scope: { accountId: string; workspaceId: string };
let session: Session;
let receiver: ReturnType<typeof Bun.serve>;
let reply: () => Response = () => new Response(null, { status: 500 });
const requests: unknown[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-credential-provider");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Credential provider",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Credential provider",
    subjectId: "user:owner",
  });
  const grant = access.workspaceGrants[0]!;
  scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  session = (await createSession(client.db, {
    ...scope,
    initialMessage: "hello",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "docker",
  })) as unknown as Session;
  receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const body = await request.text();
      try {
        requests.push(
          await verifyCredentialProviderRequest({ body, headers: request.headers, secret }),
        );
      } catch {
        return new Response("bad signature", { status: 401 });
      }
      return reply();
    },
  });
  await upsertWorkspaceCredentialProvider(client.db, {
    ...scope,
    url: `http://127.0.0.1:${receiver.port}/credentials`,
    secretEncrypted: encryptEnvironmentValue(environmentsEncryptionKeyBytes(settings)!, secret),
    enabled: true,
    timeoutMs: 2000,
    createdBySubjectId: null,
  });
}, 180_000);

afterAll(async () => {
  receiver?.stop(true);
  await client?.close();
  await shared?.release();
}, 60_000);

function turn(): SessionTurn {
  return {
    id: crypto.randomUUID(),
    executionGeneration: 1,
    initiator: { kind: "subject", subjectId: "user:owner" },
    initiatorContext: {},
    sandboxOs: "linux",
  } as unknown as SessionTurn;
}

async function bind(options: { hostPort?: RunCredentialsResolution } = {}) {
  return await bindRunCredentialResolver({
    db: client.db,
    settings,
    initiatingHumanSubjectId: "user:owner",
    connectionCredentials: options.hostPort
      ? { runCredentials: async () => options.hostPort! }
      : null,
    ...scope,
    session,
    turn: turn(),
    attemptId: crypto.randomUUID(),
    effectiveSandboxBackend: "docker",
    variableSet: null,
  });
}

describe("workspace credential provider", () => {
  test("signs the request and turns git sugar into a working credential helper", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    reply = () =>
      Response.json({
        status: "ok",
        environment: { CLOUD_TOKEN: "cloud-secret" },
        git: [{ host: "github.com", password: "gh-token/with+symbols" }],
        expiresAt,
      });
    const resolver = await bind();
    const material = await resolver!.resolve({ purpose: "provision", forceRefresh: false });
    expect(requests.at(-1)).toMatchObject({
      type: "credentials.request",
      purpose: "provision",
      workspaceId: scope.workspaceId,
      sessionId: session.id,
      initiatingHumanSubjectId: "user:owner",
      sandboxBackend: "docker",
    });
    expect(material!.environment).toMatchObject({
      CLOUD_TOKEN: "cloud-secret",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
    });
    expect(material!.fileEnvironment).toEqual({ [GIT_CREDENTIALS_FILE_ENV]: GIT_CREDENTIALS_FILE });
    expect(material!.expiresAt?.toISOString()).toBe(expiresAt);

    // Exercise the exact helper with real git against the materialized file.
    const root = await mkdtemp(join(tmpdir(), "og-git-helper-"));
    try {
      const file = material!.files.find((entry) => entry.path === GIT_CREDENTIALS_FILE)!;
      await mkdir(join(root, "git"), { recursive: true });
      await writeFile(join(root, GIT_CREDENTIALS_FILE), file.content, { mode: 0o400 });
      const git = Bun.spawn(["git", "credential", "fill"], {
        cwd: root,
        stdin: new TextEncoder().encode("protocol=https\nhost=github.com\n\n"),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: root,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          ...material!.environment,
          [GIT_CREDENTIALS_FILE_ENV]: join(root, GIT_CREDENTIALS_FILE),
        },
      });
      const output = await new Response(git.stdout).text();
      expect(await git.exited).toBe(0);
      expect(output).toContain("username=x-access-token");
      expect(output).toContain("password=gh-token/with+symbols");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a failed first provision is a visible notice; a failed renewal keeps old material", async () => {
    reply = () => new Response("down", { status: 503 });
    const resolver = await bind();
    const provisioned = await resolver!.resolve({ purpose: "provision", forceRefresh: false });
    expect(provisioned!.environment).toEqual({});
    expect(provisioned!.authNeeded).toEqual([
      { reason: "refresh_failed", message: "Workspace credential provider returned HTTP 503" },
    ]);
    await expect(resolver!.resolve({ purpose: "renewal", forceRefresh: true })).rejects.toThrow(
      "returned HTTP 503",
    );
    reply = () => new Response("{not json", { status: 200 });
    const invalid = await resolver!.resolve({ purpose: "provision", forceRefresh: false });
    expect(invalid!.authNeeded[0]!.message).toContain("invalid response body");
  });

  test("provider auth_needed and not_applicable pass through", async () => {
    reply = () =>
      Response.json({
        status: "auth_needed",
        authNeeded: [{ reason: "expired", providerDomain: "github.com", message: "Reconnect" }],
      });
    const resolver = await bind();
    const material = await resolver!.resolve({ purpose: "provision", forceRefresh: false });
    expect(material!.authNeeded).toEqual([
      { reason: "expired", providerDomain: "github.com", message: "Reconnect" },
    ]);
    reply = () => Response.json({ status: "not_applicable" });
    expect(await resolver!.resolve({ purpose: "provision", forceRefresh: false })).toBeNull();
  });

  test("a disabled provider falls back to the deployment's host port", async () => {
    await upsertWorkspaceCredentialProvider(client.db, {
      ...scope,
      url: `http://127.0.0.1:${receiver.port}/credentials`,
      enabled: false,
      timeoutMs: 2000,
      createdBySubjectId: null,
    });
    const before = requests.length;
    const resolver = await bind({
      hostPort: {
        status: "ok",
        ...scope,
        sessionId: session.id,
        environment: { FROM_HOST: "1" },
      },
    });
    const material = await resolver!.resolve({ purpose: "provision", forceRefresh: false });
    expect(material!.environment).toEqual({ FROM_HOST: "1" });
    expect(requests.length).toBe(before);
    expect(await bind()).toBeNull();
  });
});
