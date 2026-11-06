// `gh` as the person through the Opengeni gateway, with the real gh binary:
// the sandbox setup script, the gh and git wrappers, the local proxy, and a
// fake HTTPS gateway (with git http-backend for clones). Skipped when gh,
// git, openssl or node is unavailable.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  GH_GATEWAY_KIT_FILE_NAME,
  GH_GATEWAY_KIT_SCRIPT,
  gitCredentialBindingHash,
  gitCredentialBindingTokenRefreshCommand,
  repositoryCloneCommand,
} from "../src/index";
import { isolatedGitEnvironment } from "./isolated-git-home-fixture";

function findRealGh(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir || ".", "gh");
    if (!existsSync(candidate)) continue;
    try {
      // The real gh is a binary; Opengeni's wrapper is a shell script.
      if (readFileSync(candidate).subarray(0, 2).toString("latin1") === "#!") continue;
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function which(command: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const realGh = findRealGh();
const available = realGh !== null && ["git", "openssl", "node"].every(which);
const PASS = "pass-for-this-session";
const ROUTE = "A".repeat(43);

type Recorded = { method: string; path: string; authorization: string | null; body: string };

describe.skipIf(!available)("gh as the person through the Opengeni gateway (real gh)", () => {
  let root = "";
  let home = "";
  let repo = "";
  let realbin = "";
  let cert = "";
  let server: ReturnType<typeof Bun.serve> | null = null;
  const recorded: Recorded[] = [];

  function gitBackend(request: Request, body: Uint8Array, pathInfo: string): Response {
    const result = Bun.spawnSync(["git", "http-backend"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_PROJECT_ROOT: join(root, "remotes"),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: pathInfo,
        QUERY_STRING: new URL(request.url).searchParams.toString(),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(body.byteLength),
        HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
      },
      stdin: body,
    });
    const bytes = result.stdout;
    const text = bytes.toString("latin1");
    const split = text.indexOf("\r\n\r\n");
    const headerEnd = split >= 0 ? split : text.indexOf("\n\n");
    const separator = split >= 0 ? 4 : 2;
    const headers = new Headers();
    let status = 200;
    for (const line of text.slice(0, headerEnd).split(/\r?\n/u)) {
      const colon = line.indexOf(":");
      if (colon < 1) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else headers.append(name, value);
    }
    return new Response(bytes.subarray(headerEnd + separator), { status, headers });
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "opengeni-gh-gateway-"));
    home = join(root, "home");
    repo = join(root, "widgets");
    realbin = join(root, "realbin");
    mkdirSync(home, { recursive: true });
    mkdirSync(realbin, { recursive: true });
    symlinkSync(realGh!, join(realbin, "gh"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(root, "key.pem"),
        "-out",
        join(root, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    cert = join(root, "cert.pem");

    // A remote that `gh repo clone acme/other` reaches through the gateway.
    const seed = join(root, "seed");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    execFileSync("git", ["init", "-q", "-b", "main", seed], { env: gitEnv });
    writeFileSync(join(seed, "README.md"), "other\n");
    execFileSync("git", ["-C", seed, "add", "README.md"], { env: gitEnv });
    execFileSync("git", ["-C", seed, "commit", "-q", "-m", "init"], { env: gitEnv });
    mkdirSync(join(root, "remotes", "acme"), { recursive: true });
    execFileSync(
      "git",
      ["clone", "-q", "--bare", seed, join(root, "remotes", "acme", "other.git")],
      { env: gitEnv },
    );
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
    execFileSync(
      "git",
      ["-C", repo, "remote", "add", "origin", "https://github.com/acme/widgets"],
      {
        env: gitEnv,
      },
    );

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: readFileSync(cert, "utf8"), key: readFileSync(join(root, "key.pem"), "utf8") },
      async fetch(request) {
        const url = new URL(request.url);
        const body = new Uint8Array(await request.arrayBuffer());
        recorded.push({
          method: request.method,
          path: `${url.pathname}${url.search}`,
          authorization: request.headers.get("authorization"),
          body: new TextDecoder().decode(body),
        });
        const gitPrefix = "/v1/github/personal/gateway/git";
        if (url.pathname.startsWith(`${gitPrefix}/`)) {
          if (request.headers.get("authorization") !== `Basic ${btoa(`opengeni:${PASS}`)}`) {
            return new Response("auth\n", {
              status: 401,
              headers: { "www-authenticate": 'Basic realm="Opengeni"' },
            });
          }
          return gitBackend(request, body, url.pathname.slice(gitPrefix.length));
        }
        if (request.headers.get("authorization") !== `Bearer ${PASS}`) {
          return Response.json({ message: "unauthorized" }, { status: 401 });
        }
        const api = url.pathname.replace("/v1/github/personal/gateway/api", "");
        if (api === "/user") return Response.json({ login: "octo", id: 7 });
        if (api === "/repos/acme/widgets") {
          return Response.json({ full_name: "acme/widgets", private: true });
        }
        if (api === "/repos/acme/widgets/issues" && request.method === "POST") {
          return Response.json(
            {
              message:
                "Waiting for your approval in Opengeni: Create issue on acme/widgets. End your turn now; after the person approves, run the same command again.",
            },
            { status: 403 },
          );
        }
        if (api === "/graphql") {
          return Response.json({
            data: {
              repository: {
                id: "R_1",
                name: "other",
                nameWithOwner: "acme/other",
                owner: { login: "acme" },
                url: "https://github.com/acme/other",
                hasIssuesEnabled: true,
                hasWikiEnabled: false,
                description: "",
                isPrivate: true,
                viewerPermission: "WRITE",
                defaultBranchRef: { name: "main" },
                parent: null,
              },
            },
          });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      },
    });

    const base = `https://127.0.0.1:${server.port}`;
    const resources = [
      {
        kind: "repository" as const,
        uri: "https://github.com/acme/widgets",
        ref: "main",
        provider: "github" as const,
        credentialBindingId: "github-personal/binding-1",
      },
    ];
    const bindings = [
      {
        credentialBindingId: "github-personal/binding-1",
        provider: "github" as const,
        token: PASS,
        providerBindingCount: 1,
        transport: {
          kind: "http_broker" as const,
          repositories: [
            {
              repositoryUri: "https://github.com/acme/widgets",
              brokerUri: `${base}/v1/git/personal/${ROUTE}`,
            },
          ],
        },
      },
    ];
    // The static gateway kit also arrives as a staged private file.
    const kitSeed = join(root, "kit-seed");
    writeFileSync(kitSeed, GH_GATEWAY_KIT_SCRIPT, { mode: 0o600 });
    const setup = repositoryCloneCommand(resources, bindings, [], { ghGatewayKitSeed: kitSeed })
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("start_repository_clone '") && line !== "wait_repository_clone_batch",
      )
      .join("\n");
    // The broker pass arrives as a staged private file, never in a command.
    const passSeed = join(root, "pass-seed");
    writeFileSync(passSeed, PASS, { mode: 0o600 });
    const refresh = gitCredentialBindingTokenRefreshCommand(bindings, [
      { bindingHash: gitCredentialBindingHash(bindings[0]!.credentialBindingId), path: passSeed },
    ]);
    expect(refresh).not.toContain(PASS);
    expect(setup).not.toContain(PASS);
    execFileSync("sh", ["-c", `${refresh}\n${setup}`], {
      env: isolatedGitEnvironment({ HOME: home }, { sandboxGitProvisioning: true }),
      stdio: "pipe",
    });
  });

  afterAll(() => {
    server?.stop(true);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function gh(args: string[], cwd: string) {
    const env = isolatedGitEnvironment(
      {
        HOME: home,
        PATH: `${join(home, ".opengeni", "bin")}${delimiter}${realbin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
        NODE_EXTRA_CA_CERTS: cert,
        GIT_SSL_CAINFO: cert,
        GIT_TERMINAL_PROMPT: "0",
        TMPDIR: root,
        GH_TOKEN: "ambient-token-must-not-be-used",
        GITHUB_TOKEN: "ambient-token-must-not-be-used",
      },
      { sandboxGitProvisioning: true },
    );
    const child = Bun.spawn(["gh", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, status };
  }

  test("gh api reaches GitHub as the person with only the session pass", async () => {
    const result = await gh(["api", "user", "--jq", ".login"], root);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("octo");
    const request = recorded.findLast((entry) => entry.path.endsWith("/api/user"));
    expect(request?.path).toBe("/v1/github/personal/gateway/api/user");
    expect(request?.authorization).toBe(`Bearer ${PASS}`);
    expect(recorded.some((entry) => entry.body.includes("ambient-token"))).toBe(false);
    // The per-command proxy and its config are gone afterwards.
    expect(readdirSync(root).some((name) => name.startsWith("opengeni-gh."))).toBe(false);
  });

  test("gh resolves the repository from a checkout mounted as the person", async () => {
    const result = await gh(["api", "repos/{owner}/{repo}", "--jq", ".full_name"], repo);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("acme/widgets");
  });

  test("a request waiting for approval shows Opengeni's message", async () => {
    const result = await gh(
      ["api", "-X", "POST", "repos/{owner}/{repo}/issues", "-f", "title=Hi"],
      repo,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Waiting for your approval in Opengeni");
  });

  test("gh repo clone clones through the gateway and keeps the gateway remote", async () => {
    const result = await gh(["repo", "clone", "acme/other", join(root, "other")], root);
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "other", "README.md"), "utf8")).toBe("other\n");
    const config = readFileSync(join(root, "other", ".git", "config"), "utf8");
    expect(config).toContain("url = https://github.com/acme/other.git");
    expect(config).toContain("/v1/github/personal/gateway/git/");
    expect(config).not.toContain(PASS);
    const gitRequests = recorded.filter((entry) =>
      entry.path.startsWith("/v1/github/personal/gateway/git/acme/other.git/"),
    );
    expect(gitRequests.length).toBeGreaterThan(0);

    // Later plain Git in the clone uses the gateway with the session pass.
    const before = recorded.length;
    const lsRemote = Bun.spawn(["git", "-C", join(root, "other"), "ls-remote", "origin"], {
      stdout: "pipe",
      stderr: "pipe",
      env: isolatedGitEnvironment(
        {
          HOME: home,
          PATH: `${join(home, ".opengeni", "bin")}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
          GIT_SSL_CAINFO: cert,
          GIT_TERMINAL_PROMPT: "0",
        },
        { sandboxGitProvisioning: true },
      ),
    });
    const [lsOutput, lsStatus] = await Promise.all([
      new Response(lsRemote.stdout).text(),
      lsRemote.exited,
    ]);
    expect(lsStatus).toBe(0);
    expect(lsOutput).toContain("refs/heads/main");
    expect(
      recorded.slice(before).some((entry) => entry.path.includes("/gateway/git/acme/other")),
    ).toBe(true);

    // gh still sees github.com/acme/other as the repository of the clone.
    const view = await gh(
      ["api", "repos/{owner}/{repo}", "--jq", ".full_name"],
      join(root, "other"),
    );
    expect(recorded.at(-1)?.path).toBe("/v1/github/personal/gateway/api/repos/acme/other");
    expect(view.status).not.toBe(0);
  });

  test("the sandbox keeps no GitHub token, only the pass file", () => {
    const credentials = join(home, ".opengeni", "git-credentials");
    const files = readdirSync(credentials);
    for (const name of files) {
      expect(readFileSync(join(credentials, name), "utf8")).not.toContain("ambient-token");
    }
    expect(readFileSync(join(home, ".opengeni", "bin", GH_GATEWAY_KIT_FILE_NAME), "utf8")).toBe(
      GH_GATEWAY_KIT_SCRIPT,
    );
    expect(existsSync(join(root, "kit-seed"))).toBe(false);
  });
});
