import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { PERSONAL_GITHUB_RECONNECT_MESSAGE } from "@opengeni/contracts/personal-github";
import { removeSessionResources, type ApiRouteDeps } from "@opengeni/core";
import { MemoryEventBus } from "@opengeni/testing/fakes";
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
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { inspectPersonalGitHubPush } from "../src/routes/personal-github-gateway-policy";
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
      default_branch: "main",
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
      'Basic realm="Opengeni Git broker", charset="UTF-8"',
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

  test("a force push or branch deletion waits for approval; ordinary pushes do not", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-personal-git-push-policy-"));
    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      const projectRoot = join(root, "provider");
      const bareRepository = join(projectRoot, "Cloudgeni-ai", "opengeni.git");
      const client = join(root, "client");
      const home = join(root, "home");
      mkdirSync(dirname(bareRepository), { recursive: true });
      mkdirSync(home, { recursive: true });
      execFileSync("git", ["init", "--bare", "--initial-branch=main", bareRepository]);
      execFileSync("git", ["-C", bareRepository, "config", "http.receivepack", "true"]);
      const decisions: string[] = [];
      const sensitives: boolean[] = [];
      let answer: "wait" | "allow" = "wait";
      const completed: string[] = [];
      const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.github.com/user") return liveUserResponse();
        if (url.startsWith("https://api.github.com/repositories/")) return liveRepositoryResponse();
        if (url.startsWith("https://api.github.com/repos/")) {
          // compare/{base}...{head}: answer from the provider repository.
          const [base, head] = decodeURIComponent(url.split("/compare/")[1]!.split("?")[0]!).split(
            "...",
          ) as [string, string];
          let status = "diverged";
          try {
            execFileSync("git", ["-C", bareRepository, "merge-base", "--is-ancestor", base, head]);
            status = "ahead";
          } catch {}
          return Response.json({ status });
        }
        return await gitHttpBackendFetch(projectRoot, input, init);
      }) as typeof fetch;
      const brokerServices: PersonalGitHubGitBrokerServices = {
        openClaims: (token) => (token === "broker-secret" ? claims : null),
        resolveAuthority: async () => ({
          claims,
          repository,
          providerPrincipalId: "9876543210987654321",
          identity: {
            claims,
            initiator: { kind: "human", subjectId: "user-1" },
            unattended: false,
          },
        }),
        authorizeProviderRequest: async () => "Bearer provider-secret",
        inspectPush: async (authority, body, gzip, defaultBranch) =>
          await inspectPersonalGitHubPush({
            body,
            gzip,
            defaultBranch,
            repositoryFullName: authority.repository.fullName,
            identity: authority.identity!,
            isAncestor: async (base, head) => {
              const response = await providerFetch(
                `https://api.github.com/repos/x/y/compare/${base}...${head}`,
              );
              const payload = (await response.json()) as { status: string };
              return payload.status === "ahead" || payload.status === "identical";
            },
            decide: async (_identity, input) => {
              decisions.push(input.title);
              sensitives.push(input.action.sensitive);
              return answer === "allow"
                ? { kind: "run", requestId: `request-${decisions.length}` }
                : {
                    kind: "refuse",
                    status: 403,
                    waiting: true,
                    message: `Waiting for approval: ${input.title}.`,
                  };
            },
          }),
        completePush: async (_authority, requestId, outcome) => {
          completed.push(`${requestId}:${outcome}`);
        },
        fetch: providerFetch,
      };
      server = Bun.serve({
        port: 0,
        fetch: async (request) => {
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
      const gitEnvironment = {
        ...process.env,
        HOME: home,
        GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Client",
        GIT_AUTHOR_EMAIL: "c@example.test",
        GIT_COMMITTER_NAME: "Client",
        GIT_COMMITTER_EMAIL: "c@example.test",
      };
      writeFileSync(
        join(root, "helper"),
        "#!/bin/sh\n[ \"$1\" = get ] || exit 0\nprintf 'username=x\\npassword=broker-secret\\n'\n",
        { mode: 0o700 },
      );
      await runGitCommand(
        ["config", "--global", "credential.helper", join(root, "helper")],
        gitEnvironment,
      );
      await runGitCommand(["init", "--initial-branch=main", client], gitEnvironment);
      await runGitCommand(["-C", client, "remote", "add", "origin", brokerBase], gitEnvironment);
      const commit = async (text: string) => {
        writeFileSync(join(client, "file.txt"), text);
        await runGitCommand(["-C", client, "add", "file.txt"], gitEnvironment);
        await runGitCommand(["-C", client, "commit", "-m", text], gitEnvironment);
      };
      const push = async (args: string[]) => {
        const child = Bun.spawn(["git", "-C", client, "push", "origin", ...args], {
          env: gitEnvironment,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stderr, exitCode] = await Promise.all([
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stderr, exitCode };
      };

      await commit("one");
      expect((await push(["main", "main:topic"])).exitCode).toBe(0);
      await commit("two");
      expect((await push(["main"])).exitCode).toBe(0);
      expect(decisions).toEqual([]);

      await runGitCommand(
        ["-C", client, "commit", "--amend", "-m", "two rewritten"],
        gitEnvironment,
      );
      const forced = await push(["--force", "main"]);
      expect(forced.exitCode).not.toBe(0);
      expect(forced.stderr).toContain("waiting for approval");
      expect(forced.stderr).toContain("Force-push main on Cloudgeni-ai/opengeni");
      const deleted = await push([":topic"]);
      expect(deleted.exitCode).not.toBe(0);
      expect(decisions).toEqual([
        "Force-push main on Cloudgeni-ai/opengeni",
        "Delete topic on Cloudgeni-ai/opengeni",
      ]);
      // GitHub's default branch: rewriting main always asks; deleting another
      // branch follows the person's policy.
      expect(sensitives).toEqual([true, false]);

      answer = "allow";
      expect((await push(["--force", "main"])).exitCode).toBe(0);
      expect((await push([":topic"])).exitCode).toBe(0);
      expect(completed).toEqual(["request-3:completed", "request-4:completed"]);
      expect(
        execFileSync(
          "git",
          ["-C", bareRepository, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("main");

      // A shallow clone, the way managed sandboxes clone, pushes a new branch
      // and a fast-forward without asking.
      const asked = decisions.length;
      const shallow = join(root, "shallow");
      await runGitCommand(["clone", "--depth", "1", brokerBase, shallow], gitEnvironment);
      writeFileSync(join(shallow, "file.txt"), "from a shallow clone");
      await runGitCommand(["-C", shallow, "commit", "-am", "shallow"], gitEnvironment);
      const shallowPush = async (args: string[]) => {
        const child = Bun.spawn(["git", "-C", shallow, "push", "origin", ...args], {
          env: gitEnvironment,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stderr, exitCode] = await Promise.all([
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stderr, exitCode };
      };
      expect(await shallowPush(["HEAD:refs/heads/shallow-topic"])).toMatchObject({ exitCode: 0 });
      expect(await shallowPush(["HEAD:main"])).toMatchObject({ exitCode: 0 });
      expect(decisions.length).toBe(asked);
      expect(
        execFileSync("git", ["-C", bareRepository, "rev-parse", "main", "shallow-topic"], {
          encoding: "utf8",
        })
          .trim()
          .split("\n"),
      ).toEqual(
        Array(2).fill(
          execFileSync("git", ["-C", shallow, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        ),
      );
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

  /**
   * `refresh` stores an expired token whose refresh GitHub answers with that
   * OAuth error in an HTTP 200, the way github.com reports refresh errors.
   */
  async function acceptedPersonalBrokerFixture(
    options: { refresh?: string; allRepositories?: "read" | "write" } = {},
  ) {
    if (!shared || !dbClient) throw new Error("PostgreSQL test database unavailable");
    const client = dbClient;
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
    const oauthClientId = "Ov23broker-client";
    const settings: Settings = testSettings({
      githubPersonalOauthEnabled: true,
      githubPersonalOauthClientId: oauthClientId,
      githubPersonalOauthClientSecret: "broker-client-secret",
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
        JSON.stringify({
          access_token: "provider-secret",
          token_type: "Bearer",
          scope: "repo",
          ...(options.refresh
            ? {
                refresh_token: "ghr_current",
                token_endpoint: "https://github.com/login/oauth/access_token",
                client_id: oauthClientId,
                token_endpoint_auth_method: "client_secret_post",
                scope_parameter_supported: false,
              }
            : {}),
        }),
      ),
      grantedScopes: ["repo"],
      expiresAt: options.refresh ? new Date(Date.now() - 60_000) : null,
      metadata: {
        credentialRole: "opengeni_github_personal",
        providerFamily: "github",
        providerPrincipalId: "9876543210987654321",
        githubUserId: "9876543210987654321",
        githubLogin: "octocat",
        oauthEnvironment: settings.environment,
        oauthClientMarker: options.refresh
          ? createHash("sha256").update(oauthClientId).digest("hex").slice(0, 32)
          : "a".repeat(32),
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
      ...(options.allRepositories ? { allRepositoriesAccess: options.allRepositories } : {}),
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
        personalGitHubRepositorySelection: {
          credentialBindingId,
          connectionAuthorityGeneration: emptySelection.connectionAuthorityGeneration,
          selectionGeneration: selected.selectionGeneration,
          ...(options.allRepositories ? { allRepositoriesAccess: options.allRepositories } : {}),
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
    const counter = { providerCalls: 0, tokenRefreshes: 0 };
    const providerFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        counter.tokenRefreshes += 1;
        return Response.json({ error: options.refresh ?? "bad_refresh_token" });
      }
      counter.providerCalls += 1;
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
    async function brokerFor(forSession: { id: string; rootSessionId: string }) {
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(client.db, target!.id, {
        sessionId: forSession.id,
        workflowId: `session-${forSession.id}`,
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
        sessionId: forSession.id,
        rootSessionId: forSession.rootSessionId,
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
      const brokerUrl = `https://broker.example/v1/git/personal/${exactRouteId}/info/refs?service=git-upload-pack`;
      return { attemptId, brokerBearer, brokerUrl };
    }
    return {
      app,
      counter,
      session,
      target: target!,
      subjectId,
      originGrant,
      connection,
      emptySelection,
      selected,
      credentialBindingId,
      frozen,
      brokerFor,
    };
  }

  test("revalidates the real accepted attempt and denies a stale repository selection generation", async () => {
    if (!shared || !dbClient) return;
    const fixture = await acceptedPersonalBrokerFixture();
    const { app, originGrant, connection, emptySelection, selected, subjectId } = fixture;
    const { attemptId, brokerBearer, brokerUrl } = await fixture.brokerFor(fixture.session);
    // Credential rotation uses connections.version as a CAS but does not
    // alter the common repository-use authority generation frozen above.
    await shared.admin`
        update connections set version = version + 1 where id = ${connection.id}
      `;
    const acceptedResponse = await app.request(brokerUrl, {
      headers: { authorization: basic(brokerBearer) },
    });
    expect(acceptedResponse.status).toBe(200);
    expect(fixture.counter.providerCalls).toBe(3);
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
    expect(fixture.counter.providerCalls).toBe(3);
  }, 120_000);

  test("tells Git to reconnect GitHub when GitHub refused the stored grant", async () => {
    if (!shared || !dbClient) return;
    const fixture = await acceptedPersonalBrokerFixture();
    const { app, connection } = fixture;
    const route = await fixture.brokerFor(fixture.session);
    const accepted = await app.request(route.brokerUrl, {
      headers: { authorization: basic(route.brokerBearer) },
    });
    expect(accepted.status).toBe(200);
    const providerCalls = fixture.counter.providerCalls;

    // A refresh GitHub rejected moves the connection to needs_reauth (the
    // token resolver's permanent-failure transition).
    await shared.admin`
        update connections
        set status = 'needs_reauth', last_error = 'connection refresh failed with HTTP 400',
          version = version + 1
        where id = ${connection.id}
      `;
    const refused = await app.request(route.brokerUrl, {
      headers: { authorization: basic(route.brokerBearer) },
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe(`${PERSONAL_GITHUB_RECONNECT_MESSAGE}\n`);
    expect(fixture.counter.providerCalls).toBe(providerCalls);
  }, 120_000);

  // The staging incident: the stored token expired, and GitHub refused its
  // refresh with HTTP 200 and an OAuth error. Git used to hear "authorization
  // is no longer current" while the connection stayed active forever.
  test("an expired grant GitHub refuses to refresh moves to needs_reauth and Git hears reconnect", async () => {
    if (!shared || !dbClient) return;
    const fixture = await acceptedPersonalBrokerFixture({ refresh: "bad_refresh_token" });
    const route = await fixture.brokerFor(fixture.session);
    const [before] = await shared.admin<{ authority_generation: string }[]>`
        select authority_generation from connections where id = ${fixture.connection.id}
      `;

    const refused = await fixture.app.request(route.brokerUrl, {
      headers: { authorization: basic(route.brokerBearer) },
    });

    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe(`${PERSONAL_GITHUB_RECONNECT_MESSAGE}\n`);
    expect(fixture.counter.tokenRefreshes).toBe(1);
    const [after] = await shared.admin<
      { status: string; last_error: string | null; authority_generation: string }[]
    >`
        select status, last_error, authority_generation from connections
        where id = ${fixture.connection.id}
      `;
    expect(after!.status).toBe("needs_reauth");
    expect(after!.last_error).toBe(
      "connection refresh refused by the provider (bad_refresh_token)",
    );
    // Every bearer frozen before the refusal is fenced off.
    expect(Number(after!.authority_generation)).toBeGreaterThan(
      Number(before!.authority_generation),
    );
  }, 120_000);

  test("a refresh GitHub cannot serve right now tells Git to try again and keeps the grant", async () => {
    if (!shared || !dbClient) return;
    const fixture = await acceptedPersonalBrokerFixture({ refresh: "temporarily_unavailable" });
    const route = await fixture.brokerFor(fixture.session);

    const busy = await fixture.app.request(route.brokerUrl, {
      headers: { authorization: basic(route.brokerBearer) },
    });

    expect(busy.status).toBe(502);
    expect(await busy.text()).toBe("GitHub is temporarily unavailable. Try again.\n");
    const [after] = await shared.admin<{ status: string }[]>`
        select status from connections where id = ${fixture.connection.id}
      `;
    expect(after!.status).toBe("active");
  }, 120_000);

  test("refuses the next Git request for a repository removed from the chat, including in a child chat", async () => {
    if (!shared || !dbClient) return;
    const fixture = await acceptedPersonalBrokerFixture();
    const { app, session, target, subjectId, originGrant, frozen } = fixture;
    const child = await createSession(dbClient.db, {
      accountId: originGrant.accountId,
      workspaceId: target.id,
      parentSessionId: session.id,
      initialMessage: "child uses personal GitHub",
      resources: session.resources,
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
      workspaceId: target.id,
      sessionId: child.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
    const parentRoute = await fixture.brokerFor(session);
    const childRoute = await fixture.brokerFor(child);
    for (const route of [parentRoute, childRoute]) {
      const accepted = await app.request(route.brokerUrl, {
        headers: { authorization: basic(route.brokerBearer) },
      });
      expect(accepted.status).toBe(200);
    }
    const providerCallsBeforeRemoval = fixture.counter.providerCalls;

    await removeSessionResources(
      { db: dbClient.db, bus: new MemoryEventBus() },
      {
        accountId: originGrant.accountId,
        workspaceId: target.id,
        subjectId,
        permissions: ["sessions:read", "sessions:control"],
        principalKind: "human_session",
      },
      session.id,
      // A different spelling of the same repository still matches.
      { resources: [{ kind: "repository", uri: `${repository.canonicalUrl.toLowerCase()}.git` }] },
    );

    // The turns keep their older snapshots and routes, but the next request
    // for the removed repository fails before any provider call.
    for (const route of [parentRoute, childRoute]) {
      const refused = await app.request(route.brokerUrl, {
        headers: { authorization: basic(route.brokerBearer) },
      });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("This repository was removed from this chat.");
      const push = await app.request(
        route.brokerUrl.replace("service=git-upload-pack", "service=git-receive-pack"),
        { headers: { authorization: basic(route.brokerBearer) } },
      );
      expect(push.status).toBe(403);
    }
    expect(fixture.counter.providerCalls).toBe(providerCallsBeforeRemoval);
  }, 120_000);

  test("All my repositories keeps Git working across selection edits until the mode is turned off", async () => {
    if (!shared || !dbClient) return;
    const fixture = await acceptedPersonalBrokerFixture({ allRepositories: "write" });
    const { app, session, originGrant, connection, emptySelection, subjectId } = fixture;
    const route = await fixture.brokerFor(session);
    const first = await app.request(route.brokerUrl, {
      headers: { authorization: basic(route.brokerBearer) },
    });
    expect(first.status).toBe(200);

    // Editing the explicit list bumps the generation; the mode stays on.
    const edited = await replacePersonalGitHubRepositorySelections(dbClient.db, {
      accountId: originGrant.accountId,
      originWorkspaceId: originGrant.workspaceId,
      subjectId,
      connectionId: connection.id,
      expectedConnectionAuthorityGeneration: emptySelection.connectionAuthorityGeneration,
      expectedSelectionGeneration: fixture.selected.selectionGeneration,
      idempotencyKey: crypto.randomUUID(),
      repositories: [],
    });
    expect(edited.allRepositoriesAccess).toBe("write");
    const afterEdit = await app.request(route.brokerUrl, {
      headers: { authorization: basic(route.brokerBearer) },
    });
    expect(afterEdit.status).toBe(200);

    await replacePersonalGitHubRepositorySelections(dbClient.db, {
      accountId: originGrant.accountId,
      originWorkspaceId: originGrant.workspaceId,
      subjectId,
      connectionId: connection.id,
      expectedConnectionAuthorityGeneration: emptySelection.connectionAuthorityGeneration,
      expectedSelectionGeneration: edited.selectionGeneration,
      idempotencyKey: crypto.randomUUID(),
      allRepositoriesAccess: null,
      repositories: [],
    });
    const providerCallsBeforeOff = fixture.counter.providerCalls;
    const afterOff = await app.request(route.brokerUrl, {
      headers: { authorization: basic(route.brokerBearer) },
    });
    expect(afterOff.status).toBe(401);
    expect(fixture.counter.providerCalls).toBe(providerCallsBeforeOff);
  }, 120_000);

  test("All my repositories still refuses a repository removed from the chat, including in a child chat", async () => {
    if (!shared || !dbClient) return;
    const fixture = await acceptedPersonalBrokerFixture({ allRepositories: "write" });
    const { app, session, target, subjectId, originGrant, frozen } = fixture;
    const child = await createSession(dbClient.db, {
      accountId: originGrant.accountId,
      workspaceId: target.id,
      parentSessionId: session.id,
      initialMessage: "child uses personal GitHub",
      resources: session.resources,
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
      workspaceId: target.id,
      sessionId: child.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
    const parentRoute = await fixture.brokerFor(session);
    const childRoute = await fixture.brokerFor(child);
    for (const route of [parentRoute, childRoute]) {
      const accepted = await app.request(route.brokerUrl, {
        headers: { authorization: basic(route.brokerBearer) },
      });
      expect(accepted.status).toBe(200);
    }
    const providerCallsBeforeRemoval = fixture.counter.providerCalls;

    await removeSessionResources(
      { db: dbClient.db, bus: new MemoryEventBus() },
      {
        accountId: originGrant.accountId,
        workspaceId: target.id,
        subjectId,
        permissions: ["sessions:read", "sessions:control"],
        principalKind: "human_session",
      },
      session.id,
      { resources: [{ kind: "repository", uri: repository.canonicalUrl }] },
    );

    // The mode reaches every repository the person can use, but not one a
    // person removed from this chat (or its parent chat).
    for (const route of [parentRoute, childRoute]) {
      const refused = await app.request(route.brokerUrl, {
        headers: { authorization: basic(route.brokerBearer) },
      });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("This repository was removed from this chat.");
      const push = await app.request(
        route.brokerUrl.replace("service=git-upload-pack", "service=git-receive-pack"),
        { headers: { authorization: basic(route.brokerBearer) } },
      );
      expect(push.status).toBe(403);
    }
    expect(fixture.counter.providerCalls).toBe(providerCallsBeforeRemoval);
  }, 120_000);
});
