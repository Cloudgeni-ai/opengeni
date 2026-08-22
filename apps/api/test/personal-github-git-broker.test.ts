import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  getPersonalGitHubRepositorySelectionState,
  initializeSessionStartAtomically,
  persistProviderOAuthConnection,
  replacePersonalGitHubRepositorySelections,
  type DbClient,
} from "@opengeni/db";
import {
  personalGitHubGitBrokerRouteId,
  sealPersonalGitHubGitBrokerClaims,
  type PersonalGitHubGitBrokerClaims,
} from "@opengeni/github";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  handlePersonalGitHubGitBrokerRequest,
  isPersonalGitHubGitBrokerPath,
  isPersonalGitHubGitBrokerRequest,
  registerPersonalGitHubGitBrokerRoutes,
  type PersonalGitHubGitBrokerServices,
} from "../src/routes/personal-github-git-broker";
import { isApiContractProtectedMutation, routeLabel } from "../src/app";

const routeId = "r".repeat(43);
const claims: PersonalGitHubGitBrokerClaims = {
  version: 1,
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  rootSessionId: "00000000-0000-4000-8000-000000000003",
  turnId: "00000000-0000-4000-8000-000000000004",
  attemptId: "00000000-0000-4000-8000-000000000005",
  executionGeneration: 1,
  originWorkspaceId: "00000000-0000-4000-8000-000000000002",
  connectionId: "00000000-0000-4000-8000-000000000006",
  connectionAuthorityGeneration: 3,
  ownerSubjectId: "user-1",
  credentialBindingId: "00000000-0000-4000-8000-000000000007",
  selectionGeneration: 4,
  nonce: "opaque-nonce",
  issuedAt: 1_800_000_000,
  expiresAt: 1_800_000_300,
};

const repository = {
  repositoryId: "9007199254740993",
  fullName: "Cloudgeni-ai/opengeni",
  canonicalUrl: "https://github.com/Cloudgeni-ai/opengeni",
  ref: "main",
  access: "write" as const,
  selectionGeneration: 4,
};

let shared: SharedTestDatabase | null = null;
let dbClient: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-personal-github-git-broker");
  if (shared) dbClient = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await dbClient?.close();
  await shared?.release();
}, 60_000);

function basic(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
}

function liveRepositoryResponse(): Response {
  return new Response(
    JSON.stringify({
      id: repository.repositoryId,
      full_name: repository.fullName,
      html_url: repository.canonicalUrl,
      archived: false,
      disabled: false,
      permissions: { pull: true, triage: false, push: true, maintain: false, admin: false },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function liveUserResponse(
  providerPrincipalId = "9876543210987654321",
  login = "octocat",
): Response {
  return Response.json({ id: providerPrincipalId, login });
}

async function gitHttpBackendFetch(
  projectRoot: string,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(String(input));
  const requestBody = init?.body
    ? new Uint8Array(await new Response(init.body).arrayBuffer())
    : new Uint8Array();
  const requestHeaders = new Headers(init?.headers);
  const child = Bun.spawn(["git", "http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.searchParams.toString(),
      REQUEST_METHOD: init?.method ?? "GET",
      CONTENT_TYPE: requestHeaders.get("content-type") ?? "",
      CONTENT_LENGTH: String(requestBody.byteLength),
      HTTP_GIT_PROTOCOL: requestHeaders.get("git-protocol") ?? "",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(requestBody);
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git http-backend failed: ${stderr}`);
  const bytes = new Uint8Array(stdout);
  const separator = findHeaderSeparator(bytes);
  if (!separator) throw new Error("git http-backend returned no CGI headers");
  const responseHeaders = new Headers();
  let status = 200;
  for (const line of new TextDecoder().decode(bytes.slice(0, separator.index)).split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else responseHeaders.append(name, value);
  }
  return new Response(bytes.slice(separator.index + separator.length), {
    status,
    headers: responseHeaders,
  });
}

function findHeaderSeparator(bytes: Uint8Array): { index: number; length: number } | null {
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 10 && bytes[index + 1] === 10) return { index, length: 2 };
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return { index, length: 4 };
    }
  }
  return null;
}

async function runGitCommand(
  args: string[],
  environment: Record<string, string | undefined>,
): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0] ?? "command"} failed: ${stderr}`);
  return stdout;
}

function services(
  fetchImpl: typeof fetch,
  access: "read" | "write" = "write",
): PersonalGitHubGitBrokerServices {
  return {
    openClaims: (token) => (token === "broker-secret" ? claims : null),
    resolveAuthority: async (actualClaims, actualRouteId) => {
      expect(actualClaims).toEqual(claims);
      expect(actualRouteId).toBe(routeId);
      return {
        claims,
        repository: { ...repository, access },
        providerPrincipalId: "9876543210987654321",
      };
    },
    authorizeProviderRequest: async () => "Bearer provider-secret",
    fetch: (async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === "https://api.github.com/user"
        ? liveUserResponse()
        : await fetchImpl(input, init)) as typeof fetch,
  };
}

describe("personal GitHub Git broker", () => {
  test("challenges unauthenticated standard Git clients for Basic credentials", async () => {
    const response = await handlePersonalGitHubGitBrokerRequest(
      new Request(
        `https://broker.example/v1/git/personal/${routeId}/info/refs?service=git-upload-pack`,
      ),
      routeId,
      "info_refs",
      services((async () => new Response()) as typeof fetch),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Basic realm="OpenGeni Git broker", charset="UTF-8"',
    );
  });

  test("denies a live OAuth identity that no longer matches the connected principal", async () => {
    let repositoryCalls = 0;
    const mismatched = services((async () => {
      repositoryCalls += 1;
      return liveRepositoryResponse();
    }) as typeof fetch);
    mismatched.fetch = (async (input: string | URL | Request) => {
      if (String(input) === "https://api.github.com/user") {
        return liveUserResponse("111", "other-user");
      }
      repositoryCalls += 1;
      return liveRepositoryResponse();
    }) as typeof fetch;
    const response = await handlePersonalGitHubGitBrokerRequest(
      new Request(
        `https://broker.example/v1/git/personal/${routeId}/info/refs?service=git-upload-pack`,
        { headers: { authorization: basic("broker-secret") } },
      ),
      routeId,
      "info_refs",
      mismatched,
    );
    expect(response.status).toBe(403);
    expect(repositoryCalls).toBe(0);
  });

  test("proxies an exact info/refs request with fixed hosts and stripped caller headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) return liveRepositoryResponse();
      return new Response(new TextEncoder().encode("001e# service=git-upload-pack\n0000"), {
        status: 200,
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    }) as typeof fetch;
    const app = new Hono();
    registerPersonalGitHubGitBrokerRoutes(app, {} as ApiRouteDeps, services(fetchImpl));

    const response = await app.request(
      `https://broker.example/v1/git/personal/${routeId}/info/refs?service=git-upload-pack`,
      {
        headers: {
          authorization: basic("broker-secret"),
          cookie: "must-not-forward=true",
          "proxy-authorization": "Basic must-not-forward",
          "x-forwarded-for": "203.0.113.10",
          "git-protocol": "version=2",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("service=git-upload-pack");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`https://api.github.com/repositories/${repository.repositoryId}`);
    expect(calls[1]!.url).toBe(
      "https://github.com/Cloudgeni-ai/opengeni.git/info/refs?service=git-upload-pack",
    );
    expect(calls.every(({ init }) => init.redirect === "manual")).toBe(true);
    const upstreamHeaders = new Headers(calls[1]!.init.headers);
    expect(upstreamHeaders.get("authorization")).toBe(basic("provider-secret"));
    expect(upstreamHeaders.get("git-protocol")).toBe("version=2");
    expect(upstreamHeaders.has("cookie")).toBe(false);
    expect(upstreamHeaders.has("proxy-authorization")).toBe(false);
    expect(upstreamHeaders.has("x-forwarded-for")).toBe(false);
  });

  test("denies receive-pack before provider use when selection is read-only", async () => {
    let calls = 0;
    const response = await handlePersonalGitHubGitBrokerRequest(
      new Request(`https://broker.example/v1/git/personal/${routeId}/git-receive-pack`, {
        method: "POST",
        headers: {
          authorization: "Bearer broker-secret",
          "content-type": "application/x-git-receive-pack-request",
        },
        body: "pack",
      }),
      routeId,
      "receive_pack",
      services(
        (async () => {
          calls += 1;
          return new Response();
        }) as typeof fetch,
        "read",
      ),
    );

    expect(response.status).toBe(403);
    expect(calls).toBe(0);

    const advertisement = await handlePersonalGitHubGitBrokerRequest(
      new Request(
        `https://broker.example/v1/git/personal/${routeId}/info/refs?service=git-receive-pack`,
        { headers: { authorization: basic("broker-secret") } },
      ),
      routeId,
      "info_refs",
      services(
        (async () => {
          calls += 1;
          return new Response();
        }) as typeof fetch,
        "read",
      ),
    );
    expect(advertisement.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("streams an upload-pack body without aborting after upload completion", async () => {
    let uploaded = "";
    let signalAborted = true;
    let contentEncoding: string | null = null;
    let calls = 0;
    const response = await handlePersonalGitHubGitBrokerRequest(
      new Request(`https://broker.example/v1/git/personal/${routeId}/git-upload-pack`, {
        method: "POST",
        headers: {
          authorization: basic("broker-secret"),
          "content-type": "application/x-git-upload-pack-request",
          "content-encoding": "gzip",
        },
        body: "streamed-pack",
      }),
      routeId,
      "upload_pack",
      services((async (_input: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) return liveRepositoryResponse();
        uploaded = await new Response(init?.body).text();
        signalAborted = init?.signal?.aborted ?? true;
        contentEncoding = new Headers(init?.headers).get("content-encoding");
        return new Response("result", {
          headers: { "content-type": "application/x-git-upload-pack-result" },
        });
      }) as typeof fetch),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("result");
    expect(uploaded).toBe("streamed-pack");
    expect(signalAborted).toBe(false);
    expect(contentEncoding).toBe("gzip");
  });

  test("does not replay an ambiguous push and returns fixed inspect-before-retry guidance", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (calls.length === 1) return liveRepositoryResponse();
      throw new Error("sensitive provider transport diagnostic");
    }) as typeof fetch;
    const response = await handlePersonalGitHubGitBrokerRequest(
      new Request(`https://broker.example/v1/git/personal/${routeId}/git-receive-pack`, {
        method: "POST",
        headers: {
          authorization: basic("broker-secret"),
          "content-type": "application/x-git-receive-pack-request",
        },
        body: "pack",
      }),
      routeId,
      "receive_pack",
      services(fetchImpl),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      "GitHub push outcome is unknown. Inspect the remote before retrying.\n",
    );
    expect(calls).toHaveLength(2);
  });

  test("treats every non-successful receive-pack response as outcome unknown", async () => {
    let calls = 0;
    const response = await handlePersonalGitHubGitBrokerRequest(
      new Request(`https://broker.example/v1/git/personal/${routeId}/git-receive-pack`, {
        method: "POST",
        headers: {
          authorization: basic("broker-secret"),
          "content-type": "application/x-git-receive-pack-request",
        },
        body: "pack",
      }),
      routeId,
      "receive_pack",
      services((async () => {
        calls += 1;
        return calls === 1
          ? liveRepositoryResponse()
          : new Response("provider detail must not escape", { status: 503 });
      }) as typeof fetch),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      "GitHub push outcome is unknown. Inspect the remote before retrying.\n",
    );
    expect(calls).toBe(2);
  });

  test("requires the exact advertisement type and a non-null POST body", async () => {
    let calls = 0;
    const wrongAdvertisement = await handlePersonalGitHubGitBrokerRequest(
      new Request(
        `https://broker.example/v1/git/personal/${routeId}/info/refs?service=git-upload-pack`,
        { headers: { authorization: basic("broker-secret") } },
      ),
      routeId,
      "info_refs",
      services((async () => {
        calls += 1;
        return calls === 1
          ? liveRepositoryResponse()
          : new Response("wrong", {
              headers: { "content-type": "application/x-git-receive-pack-advertisement" },
            });
      }) as typeof fetch),
    );
    expect(wrongAdvertisement.status).toBe(502);

    const nullPostBody = await handlePersonalGitHubGitBrokerRequest(
      new Request(`https://broker.example/v1/git/personal/${routeId}/git-upload-pack`, {
        method: "POST",
        headers: {
          authorization: basic("broker-secret"),
          "content-type": "application/x-git-upload-pack-request",
        },
      }),
      routeId,
      "upload_pack",
      services((async () => {
        throw new Error("must not reach provider");
      }) as typeof fetch),
    );
    expect(nullPostBody.status).toBe(404);

    const unsupportedEncoding = await handlePersonalGitHubGitBrokerRequest(
      new Request(`https://broker.example/v1/git/personal/${routeId}/git-upload-pack`, {
        method: "POST",
        headers: {
          authorization: basic("broker-secret"),
          "content-type": "application/x-git-upload-pack-request",
          "content-encoding": "br",
        },
        body: "pack",
      }),
      routeId,
      "upload_pack",
      services((async () => {
        throw new Error("must not reach provider");
      }) as typeof fetch),
    );
    expect(unsupportedEncoding.status).toBe(404);
  });

  test("runs standard Git clone, fetch, pull, renewable auth, and write-fenced push", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-personal-git-e2e-"));
    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      const projectRoot = join(root, "provider");
      const bareRepository = join(projectRoot, "Cloudgeni-ai", "opengeni.git");
      const publisher = join(root, "publisher");
      const client = join(root, "client");
      const home = join(root, "home");
      const helperDir = join(root, "bin");
      const bearerFile = join(root, "broker-bearer");
      const globalConfig = join(root, "gitconfig");
      mkdirSync(dirname(bareRepository), { recursive: true });
      mkdirSync(publisher, { recursive: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(helperDir, { recursive: true });
      execFileSync("git", ["init", "--bare", "--initial-branch=main", bareRepository]);
      execFileSync("git", ["init", "--initial-branch=main", publisher]);
      writeFileSync(join(publisher, "README.md"), "one\n");
      execFileSync("git", ["-C", publisher, "add", "README.md"]);
      execFileSync("git", [
        "-C",
        publisher,
        "-c",
        "user.name=Publisher",
        "-c",
        "user.email=p@example.test",
        "commit",
        "-m",
        "initial",
      ]);
      execFileSync("git", ["-C", publisher, "remote", "add", "origin", bareRepository]);
      execFileSync("git", ["-C", publisher, "push", "origin", "main"]);
      execFileSync("git", ["-C", bareRepository, "config", "http.receivepack", "true"]);

      let activeBearer = "broker-bearer-one";
      let repositoryAccess: "read" | "write" = "write";
      let unauthenticatedRequests = 0;
      const acceptedBearers: string[] = [];
      const brokerServices: PersonalGitHubGitBrokerServices = {
        openClaims: (token) => {
          acceptedBearers.push(token);
          return token === activeBearer ? claims : null;
        },
        resolveAuthority: async () => ({
          claims,
          repository: { ...repository, access: repositoryAccess },
          providerPrincipalId: "9876543210987654321",
        }),
        authorizeProviderRequest: async () => "Bearer provider-secret",
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url === "https://api.github.com/user") return liveUserResponse();
          if (url.startsWith("https://api.github.com/repositories/")) {
            return liveRepositoryResponse();
          }
          return await gitHttpBackendFetch(projectRoot, input, init);
        }) as typeof fetch,
      };
      server = Bun.serve({
        port: 0,
        fetch: async (request) => {
          if (!request.headers.has("authorization")) unauthenticatedRequests += 1;
          const url = new URL(request.url);
          const match = url.pathname.match(
            /^\/v1\/git\/personal\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/u,
          );
          if (!match) return new Response("not found", { status: 404 });
          const operation =
            match[2] === "info/refs"
              ? "info_refs"
              : match[2] === "git-upload-pack"
                ? "upload_pack"
                : "receive_pack";
          return await handlePersonalGitHubGitBrokerRequest(
            request,
            match[1]!,
            operation,
            brokerServices,
          );
        },
      });
      const brokerBase = `http://127.0.0.1:${server.port}/v1/git/personal/${routeId}`;
      const helperPath = join(helperDir, "git-credential-opengeni");
      writeFileSync(
        helperPath,
        `#!/bin/sh\n[ "$1" = get ] || exit 0\nprintf 'username=x-access-token\\npassword=%s\\n' "$(cat ${bearerFile})"\n`,
      );
      chmodSync(helperPath, 0o700);
      writeFileSync(bearerFile, activeBearer, { mode: 0o600 });
      const gitEnvironment = {
        ...process.env,
        HOME: home,
        PATH: `${helperDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      };
      await runGitCommand(["config", "--global", "credential.helper", "opengeni"], gitEnvironment);
      await runGitCommand(["config", "--global", "credential.useHttpPath", "true"], gitEnvironment);
      await runGitCommand(
        ["config", "--global", `url.${brokerBase}.insteadOf`, repository.canonicalUrl],
        gitEnvironment,
      );

      await runGitCommand(["clone", repository.canonicalUrl, client], gitEnvironment);
      expect(
        (
          await runGitCommand(
            ["-C", client, "config", "--get", "remote.origin.url"],
            gitEnvironment,
          )
        ).trim(),
      ).toBe(repository.canonicalUrl);
      expect(unauthenticatedRequests).toBeGreaterThan(0);
      expect(acceptedBearers).toContain("broker-bearer-one");

      writeFileSync(join(publisher, "README.md"), "two\n");
      execFileSync("git", ["-C", publisher, "add", "README.md"]);
      execFileSync("git", [
        "-C",
        publisher,
        "-c",
        "user.name=Publisher",
        "-c",
        "user.email=p@example.test",
        "commit",
        "-m",
        "second",
      ]);
      execFileSync("git", ["-C", publisher, "push", "origin", "main"]);
      await runGitCommand(["-C", client, "fetch", "origin"], gitEnvironment);
      await runGitCommand(["-C", client, "pull", "--ff-only"], gitEnvironment);
      expect(readFileSync(join(client, "README.md"), "utf8")).toBe("two\n");

      activeBearer = "broker-bearer-two";
      writeFileSync(bearerFile, activeBearer, { mode: 0o600 });
      await runGitCommand(["-C", client, "fetch", "origin"], gitEnvironment);
      expect(acceptedBearers).toContain("broker-bearer-two");

      writeFileSync(join(client, "client.txt"), "push\n");
      await runGitCommand(["-C", client, "add", "client.txt"], gitEnvironment);
      await runGitCommand(
        [
          "-C",
          client,
          "-c",
          "user.name=Client",
          "-c",
          "user.email=c@example.test",
          "commit",
          "-m",
          "client",
        ],
        gitEnvironment,
      );
      repositoryAccess = "read";
      await expect(
        runGitCommand(["-C", client, "push", "origin", "main"], gitEnvironment),
      ).rejects.toThrow();
      repositoryAccess = "write";
      await runGitCommand(["-C", client, "push", "origin", "main"], gitEnvironment);
    } finally {
      server?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("closes the protocol paths and keeps route identifiers out of telemetry labels", () => {
    const infoPath = `/v1/git/personal/${routeId}/info/refs`;
    const uploadPath = `/v1/git/personal/${routeId}/git-upload-pack`;
    const receivePath = `/v1/git/personal/${routeId}/git-receive-pack`;
    expect(isPersonalGitHubGitBrokerPath(infoPath)).toBe(true);
    expect(isPersonalGitHubGitBrokerPath(uploadPath)).toBe(true);
    expect(isPersonalGitHubGitBrokerPath(receivePath)).toBe(true);
    expect(isPersonalGitHubGitBrokerPath(`/v1/git/personal/${routeId}/anything-else`)).toBe(false);
    expect(isPersonalGitHubGitBrokerRequest("GET", infoPath)).toBe(true);
    expect(isPersonalGitHubGitBrokerRequest("POST", receivePath)).toBe(true);
    expect(isPersonalGitHubGitBrokerRequest("PUT", receivePath)).toBe(false);
    expect(routeLabel(infoPath)).toBe("/v1/git/personal/:routeId/info/refs");
    expect(routeLabel(uploadPath)).toBe("/v1/git/personal/:routeId/git-upload-pack");
    expect(routeLabel(receivePath)).toBe("/v1/git/personal/:routeId/git-receive-pack");
    expect(isApiContractProtectedMutation("POST", receivePath)).toBe(false);
  });

  test("revalidates the real accepted attempt and denies a stale repository selection generation", async () => {
    if (!shared || !dbClient) return;
    const userId = `git-broker-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(dbClient.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Git broker owner",
    });
    const originGrant = access.workspaceGrants.find(
      (grant) => grant.workspaceId === access.defaultWorkspaceId,
    );
    if (!originGrant) throw new Error("personal workspace grant was not projected");
    const [target] = await shared.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${originGrant.accountId}, 'Git broker target') returning id
      `;
    await shared.admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${target!.id}, ${originGrant.accountId})
      `;
    await shared.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id)
        values (${originGrant.accountId}, ${target!.id}, ${subjectId})
      `;

    const signingSecret = "git-broker-signing-secret";
    const encryptionKey = Buffer.alloc(32, 11).toString("base64");
    const settings: Settings = testSettings({
      githubPersonalOauthEnabled: true,
      integrationsEnabled: true,
      integrationsStateSecret: signingSecret,
      environmentsEncryptionKey: encryptionKey,
    });
    const key = environmentsEncryptionKeyBytes(settings);
    if (!key) throw new Error("test encryption key was not configured");
    const credentialBindingId = crypto.randomUUID();
    const now = new Date().toISOString();
    const connection = await persistProviderOAuthConnection(dbClient.db, {
      accountId: originGrant.accountId,
      workspaceId: originGrant.workspaceId,
      subjectId,
      visibleToSubjectId: subjectId,
      providerDomain: "github.com",
      kind: "oauth2",
      status: "active",
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: "provider-secret", token_type: "Bearer", scope: "repo" }),
      ),
      grantedScopes: ["repo"],
      expiresAt: null,
      metadata: {
        credentialRole: "opengeni_github_personal",
        providerFamily: "github",
        providerPrincipalId: "9876543210987654321",
        githubUserId: "9876543210987654321",
        githubLogin: "octocat",
        oauthEnvironment: "test",
        oauthClientMarker: "a".repeat(32),
        credentialBindingId,
        connectedAt: now,
        lastVerifiedAt: now,
      },
      createdBySubjectId: subjectId,
      updatedBySubjectId: subjectId,
      credentialRole: "opengeni_github_personal",
      providerFamily: "github",
      providerPrincipalId: "9876543210987654321",
      requireLiveUserAuthority: true,
      requiredLiveUserPermission: "connections:write",
      exclusiveProviderPrincipalPerOwner: true,
    });
    if (!connection?.authorityId) throw new Error("personal GitHub connection was not created");
    const emptySelection = await getPersonalGitHubRepositorySelectionState(dbClient.db, {
      accountId: originGrant.accountId,
      originWorkspaceId: originGrant.workspaceId,
      subjectId,
      connectionId: connection.id,
    });
    if (!emptySelection) throw new Error("repository selection head was not created");
    const selected = await replacePersonalGitHubRepositorySelections(dbClient.db, {
      accountId: originGrant.accountId,
      originWorkspaceId: originGrant.workspaceId,
      subjectId,
      connectionId: connection.id,
      expectedConnectionAuthorityGeneration: emptySelection.connectionAuthorityGeneration,
      expectedSelectionGeneration: 0,
      idempotencyKey: crypto.randomUUID(),
      repositories: [
        {
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          canonicalUrl: repository.canonicalUrl,
          defaultBranch: repository.ref,
          visibility: "private",
          private: true,
          archived: false,
          disabled: false,
          permissions: {
            pull: true,
            triage: false,
            push: true,
            maintain: false,
            admin: false,
          },
          selectedAccess: "write",
          lastVerifiedAt: now,
        },
      ],
    });
    const targetGrant = await shared.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${originGrant.accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
      await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
      const [row] = await tx<Array<{ id: string; generation: number }>>`
          select grant_id as id, grant_generation::int as generation
          from issue_self_connection_use_grant(
            ${originGrant.accountId}::uuid, ${connection.authorityId}::uuid,
            ${target!.id}::uuid, 'always', 'workspace_shared', null::uuid, true
          )
        `;
      return row!;
    });
    const frozenRepository = {
      ...repository,
      selectionGeneration: selected.selectionGeneration,
    };
    const frozen = [
      {
        serverId: "github:personal",
        connectionId: connection.id,
        originWorkspaceId: originGrant.workspaceId,
        ownerSubjectId: subjectId,
        providerDomain: "github.com",
        kind: "oauth2" as const,
        connectionType: "github_personal" as const,
        userDelegation: {
          organizationId: originGrant.accountId,
          authorityId: connection.authorityId,
          authorityGeneration: emptySelection.connectionAuthorityGeneration,
          workspaceId: target!.id,
          sessionId: null,
          action: "connection.use" as const,
          mode: "always" as const,
          context: "workspace_shared" as const,
          authorityEpoch: null,
          grantId: targetGrant.id,
          grantGeneration: targetGrant.generation,
        },
        personalGitHubRepositorySelection: {
          credentialBindingId,
          connectionAuthorityGeneration: emptySelection.connectionAuthorityGeneration,
          selectionGeneration: selected.selectionGeneration,
          repositories: [frozenRepository],
        },
      },
    ];
    const session = await createSession(dbClient.db, {
      accountId: originGrant.accountId,
      workspaceId: target!.id,
      initialMessage: "use personal GitHub",
      resources: [
        {
          kind: "repository",
          uri: repository.canonicalUrl,
          ref: repository.ref,
          provider: "github",
          connectionType: "github_personal",
          credentialBindingId,
          repositoryId: repository.repositoryId,
          access: "write",
        },
      ],
      tools: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId },
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      subjectId,
      personalConnectionDelegations: frozen,
    });
    await initializeSessionStartAtomically(dbClient.db, {
      accountId: originGrant.accountId,
      workspaceId: target!.id,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(dbClient.db, target!.id, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`turn was not claimed: ${claimed.reason}`);
    const bearerClaims: PersonalGitHubGitBrokerClaims = {
      version: 1,
      accountId: originGrant.accountId,
      workspaceId: target!.id,
      sessionId: session.id,
      rootSessionId: session.rootSessionId,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      originWorkspaceId: originGrant.workspaceId,
      connectionId: connection.id,
      connectionAuthorityGeneration: emptySelection.connectionAuthorityGeneration,
      ownerSubjectId: subjectId,
      credentialBindingId,
      selectionGeneration: selected.selectionGeneration,
      nonce: crypto.randomUUID(),
      issuedAt: Math.floor(Date.now() / 1_000),
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
    };
    const exactRouteId = personalGitHubGitBrokerRouteId(signingSecret, {
      ...bearerClaims,
      repository: frozenRepository,
    });
    const brokerBearer = sealPersonalGitHubGitBrokerClaims(signingSecret, bearerClaims);
    let providerCalls = 0;
    const providerFetch = (async (input: string | URL | Request) => {
      providerCalls += 1;
      const url = String(input);
      return url === "https://api.github.com/user"
        ? liveUserResponse()
        : url.startsWith("https://api.github.com/repositories/")
          ? liveRepositoryResponse()
          : new Response("advertisement", {
              headers: { "content-type": "application/x-git-upload-pack-advertisement" },
            });
    }) as typeof fetch;
    const routeDeps = {
      settings,
      db: dbClient.db,
      githubPersonalFetch: providerFetch,
    } as ApiRouteDeps;
    const app = new Hono();
    registerPersonalGitHubGitBrokerRoutes(app, routeDeps);
    const brokerUrl = `https://broker.example/v1/git/personal/${exactRouteId}/info/refs?service=git-upload-pack`;
    // Credential rotation uses connections.version as a CAS but does not
    // alter the common repository-use authority generation frozen above.
    await shared.admin`
        update connections set version = version + 1 where id = ${connection.id}
      `;
    const acceptedResponse = await app.request(brokerUrl, {
      headers: { authorization: basic(brokerBearer) },
    });
    expect(acceptedResponse.status).toBe(200);
    expect(providerCalls).toBe(3);
    const audit = await shared.admin<
      Array<{
        phase: "credential_resolution" | "provider_request";
        outcome: string;
        serverId: string;
      }>
    >`
        select use_phase as phase, outcome, server_id as "serverId"
        from connection_use_audit_facts
        where attempt_id = ${attemptId}
        order by occurred_at, physical_request_id
      `;
    expect(audit).toHaveLength(6);
    expect(audit.map((row) => row.phase).sort()).toEqual([
      "credential_resolution",
      "credential_resolution",
      "credential_resolution",
      "provider_request",
      "provider_request",
      "provider_request",
    ]);
    expect(audit.every((row) => row.outcome === "authorized")).toBe(true);
    expect(audit.every((row) => row.serverId === "github:personal")).toBe(true);

    await replacePersonalGitHubRepositorySelections(dbClient.db, {
      accountId: originGrant.accountId,
      originWorkspaceId: originGrant.workspaceId,
      subjectId,
      connectionId: connection.id,
      expectedConnectionAuthorityGeneration: emptySelection.connectionAuthorityGeneration,
      expectedSelectionGeneration: selected.selectionGeneration,
      idempotencyKey: crypto.randomUUID(),
      repositories: [],
    });
    const staleResponse = await app.request(brokerUrl, {
      headers: { authorization: basic(brokerBearer) },
    });
    expect(staleResponse.status).toBe(401);
    expect(providerCalls).toBe(3);
  }, 120_000);
});
