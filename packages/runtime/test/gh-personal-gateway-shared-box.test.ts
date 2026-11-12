// Two chats on one sandbox (for example a parent and a worker it started)
// each use their own personal GitHub pass for Git and gh, alternately,
// through the real product setup and renewal programs. Before the pass was
// per chat, the chat that set up last overwrote the other's pass, and the
// other chat's Git and gh failed with "authorization is no longer current".

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyDiff } from "@openai/agents";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  GH_GATEWAY_KIT_SCRIPT,
  gitCredentialBindingHash,
  gitCredentialBindingTokenRefreshCommand,
  gitSessionKey,
  repositoryCloneCommand,
  withGitSessionEnvironment,
} from "../src/index";
import { isolatedGitEnvironment } from "./isolated-git-home-fixture";

function findRealGh(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir || ".", "gh");
    if (!existsSync(candidate)) continue;
    try {
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
const BINDING_ID = "github-personal/binding-1";

type Chat = { name: string; key: string; route: string; pass: string };
type Recorded = { path: string; pass: string | null };

describe.skipIf(!available)("two chats on one sandbox use their own GitHub pass", () => {
  let root = "";
  let home = "";
  let realbin = "";
  let cert = "";
  let base = "";
  let server: ReturnType<typeof Bun.serve> | null = null;
  const recorded: Recorded[] = [];
  const chatA: Chat = {
    name: "a",
    key: gitSessionKey("session-a"),
    route: "A".repeat(43),
    pass: "pass-for-chat-a",
  };
  const chatB: Chat = {
    name: "b",
    key: gitSessionKey("session-b"),
    route: "B".repeat(43),
    pass: "pass-for-chat-b",
  };
  const validPasses = new Set([chatA.pass, chatB.pass]);
  const credentials = () => join(home, ".opengeni", "git-credentials");

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
    const text = result.stdout.toString("latin1");
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
    return new Response(result.stdout.subarray(headerEnd + separator), { status, headers });
  }

  function passOf(request: Request): string | null {
    const authorization = request.headers.get("authorization") ?? "";
    if (authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
    if (authorization.startsWith("Basic ")) {
      const decoded = atob(authorization.slice("Basic ".length));
      return decoded.slice(decoded.indexOf(":") + 1);
    }
    return null;
  }

  function bindingsFor(chat: Chat, pass = chat.pass) {
    return [
      {
        credentialBindingId: BINDING_ID,
        provider: "github" as const,
        token: pass,
        providerBindingCount: 1,
        transport: {
          kind: "http_broker" as const,
          repositories: [
            {
              repositoryUri: "https://github.com/acme/widgets",
              brokerUri: `${base}/v1/git/personal/${chat.route}`,
            },
          ],
        },
      },
    ];
  }

  /** Stages a pass as a private file and renews it into the chat's directory. */
  function renewalProgram(chat: Chat, pass: string): string {
    const seed = join(root, `pass-seed-${chat.name}`);
    writeFileSync(seed, pass, { mode: 0o600 });
    const program = gitCredentialBindingTokenRefreshCommand(
      bindingsFor(chat, pass),
      [{ bindingHash: gitCredentialBindingHash(BINDING_ID), path: seed }],
      { gitSessionKey: chat.key },
    );
    expect(program).not.toContain(pass);
    return program;
  }

  function setUp(chat: Chat): void {
    const kitSeed = join(root, `kit-seed-${chat.name}`);
    const kitDiff = GH_GATEWAY_KIT_SCRIPT.split("\n")
      .map((line) => `+${line}`)
      .join("\n");
    writeFileSync(kitSeed, applyDiff("", kitDiff, "create"), { mode: 0o600 });
    const setup = repositoryCloneCommand(
      [
        {
          kind: "repository" as const,
          uri: "https://github.com/acme/widgets",
          ref: "main",
          provider: "github" as const,
          credentialBindingId: BINDING_ID,
        },
      ],
      bindingsFor(chat),
      [],
      { ghGatewayKitSeed: kitSeed },
    )
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("start_repository_clone '") && line !== "wait_repository_clone_batch",
      )
      .join("\n");
    expect(setup).not.toContain(chat.pass);
    // Each chat's commands carry its own directory, as the runtime decorates them.
    const program = withGitSessionEnvironment(
      `${renewalProgram(chat, chat.pass)}\n${setup}`,
      chat.key,
    );
    execFileSync("sh", ["-c", program], { env: environment(), stdio: "pipe" });
  }

  function environment(): NodeJS.ProcessEnv {
    return isolatedGitEnvironment(
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
  }

  /** Runs a command as one chat's agent command would run, or outside any chat. */
  async function run(chat: Chat | null, command: string) {
    const script = chat ? withGitSessionEnvironment(command, chat.key) : command;
    const child = Bun.spawn(["sh", "-c", script], {
      cwd: root,
      env: environment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, status };
  }

  async function lastRequest(chat: Chat | null, command: string, pathPart: string) {
    const before = recorded.length;
    const result = await run(chat, command);
    expect(result.stderr).not.toContain("no longer current");
    expect(result.status).toBe(0);
    const request = recorded.slice(before).findLast((entry) => entry.path.includes(pathPart));
    expect(request).toBeDefined();
    return { request: request!, stdout: result.stdout };
  }

  const brokerFetch = (chat: Chat | null) =>
    lastRequest(chat, "git ls-remote https://github.com/acme/widgets", "/v1/git/personal/");
  let clones = 0;
  /** `gh repo clone` (Git through the gateway), then plain Git in that clone. */
  async function gatewayGit(chat: Chat) {
    const target = join(root, `other-${chat.name}-${(clones += 1)}`);
    const clone = await lastRequest(
      chat,
      `gh repo clone acme/other ${target}`,
      "/v1/github/personal/gateway/git/",
    );
    const later = await lastRequest(
      chat,
      `git -C ${target} ls-remote origin`,
      "/v1/github/personal/gateway/git/",
    );
    return [clone.request.pass, later.request.pass];
  }
  const ghUser = (chat: Chat | null) =>
    lastRequest(chat, "gh api user --jq .login", "/v1/github/personal/gateway/api/user");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "opengeni-gh-shared-box-"));
    home = join(root, "home");
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
    writeFileSync(join(seed, "README.md"), "hello\n");
    execFileSync("git", ["-C", seed, "add", "README.md"], { env: gitEnv });
    execFileSync("git", ["-C", seed, "commit", "-q", "-m", "init"], { env: gitEnv });
    mkdirSync(join(root, "remotes", "acme"), { recursive: true });
    for (const name of ["widgets", "other"]) {
      execFileSync(
        "git",
        ["clone", "-q", "--bare", seed, join(root, "remotes", "acme", `${name}.git`)],
        { env: gitEnv },
      );
    }

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: readFileSync(cert, "utf8"), key: readFileSync(join(root, "key.pem"), "utf8") },
      async fetch(request) {
        const url = new URL(request.url);
        const body = new Uint8Array(await request.arrayBuffer());
        const pass = passOf(request);
        recorded.push({ path: url.pathname, pass });
        const unauthorized = () =>
          new Response("auth\n", {
            status: 401,
            headers: { "www-authenticate": 'Basic realm="Opengeni"' },
          });
        const broker = /^\/v1\/git\/personal\/[AB]{43}(\/.*)$/u.exec(url.pathname);
        if (broker) {
          if (!pass || !validPasses.has(pass)) return unauthorized();
          return gitBackend(request, body, `/acme/widgets.git${broker[1]}`);
        }
        const gatewayGitPrefix = "/v1/github/personal/gateway/git";
        if (url.pathname.startsWith(`${gatewayGitPrefix}/`)) {
          if (!pass || !validPasses.has(pass)) return unauthorized();
          return gitBackend(request, body, url.pathname.slice(gatewayGitPrefix.length));
        }
        if (!pass || !validPasses.has(pass)) {
          return Response.json({ message: "unauthorized" }, { status: 401 });
        }
        if (url.pathname === "/v1/github/personal/gateway/api/user") {
          return Response.json({ login: "octo", id: 7 });
        }
        if (url.pathname === "/v1/github/personal/gateway/api/graphql") {
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
    base = `https://127.0.0.1:${server.port}`;

    // A chat directory nobody has used for days is removed by the next setup.
    const stale = join(credentials(), "sessions", gitSessionKey("long-finished"));
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, `${gitCredentialBindingHash(BINDING_ID)}-token`), "old-pass");
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    // Chat A sets up first, then chat B on the same box.
    setUp(chatA);
    setUp(chatB);
  });

  afterAll(() => {
    server?.stop(true);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("git and gh alternate between the chats, each with its own pass", async () => {
    for (let round = 0; round < 2; round += 1) {
      const brokerA = (await brokerFetch(chatA)).request;
      expect(brokerA.path.startsWith(`/v1/git/personal/${chatA.route}/`)).toBe(true);
      expect(brokerA.pass).toBe(chatA.pass);
      const userB = await ghUser(chatB);
      expect(userB.stdout.trim()).toBe("octo");
      expect(userB.request.pass).toBe(chatB.pass);
      expect(await gatewayGit(chatA)).toEqual([chatA.pass, chatA.pass]);
      const brokerB = (await brokerFetch(chatB)).request;
      expect(brokerB.path.startsWith(`/v1/git/personal/${chatB.route}/`)).toBe(true);
      expect(brokerB.pass).toBe(chatB.pass);
      expect((await ghUser(chatA)).request.pass).toBe(chatA.pass);
      expect(await gatewayGit(chatB)).toEqual([chatB.pass, chatB.pass]);
    }
    expect(recorded.some((entry) => entry.pass === "ambient-token-must-not-be-used")).toBe(false);
  }, 60_000);

  test("each chat's routes keep the canonical github.com remote", async () => {
    for (const chat of [chatA, chatB]) {
      const result = await run(chat, "git ls-remote --get-url https://github.com/acme/widgets");
      expect(result.stdout.trim()).toBe(`${base}/v1/git/personal/${chat.route}`);
    }
    // No chat's routes are in the box's global Git config.
    const global = readFileSync(join(home, ".gitconfig"), "utf8");
    expect(global).not.toContain("/v1/git/personal/");
    expect(global).not.toContain("http-broker.gitconfig");
  });

  test("renewing one chat's pass leaves the other chat's pass alone", async () => {
    const renewed = "renewed-pass-for-chat-a";
    validPasses.add(renewed);
    const result = await run(null, renewalProgram(chatA, renewed));
    expect(result.status).toBe(0);
    expect((await brokerFetch(chatA)).request.pass).toBe(renewed);
    expect((await ghUser(chatA)).request.pass).toBe(renewed);
    expect((await brokerFetch(chatB)).request.pass).toBe(chatB.pass);
    expect((await ghUser(chatB)).request.pass).toBe(chatB.pass);
  });

  test("a process outside any chat uses the chat that set up last", async () => {
    expect(readlinkSync(join(credentials(), "sessions", "latest"))).toBe(chatB.key);
    expect((await brokerFetch(null)).request.pass).toBe(chatB.pass);
    expect((await ghUser(null)).request.pass).toBe(chatB.pass);
  });

  test("setup removes stale chat directories and keeps the current ones", () => {
    const sessions = join(credentials(), "sessions");
    expect(existsSync(join(sessions, gitSessionKey("long-finished")))).toBe(false);
    for (const chat of [chatA, chatB]) {
      const passFile = join(sessions, chat.key, `${gitCredentialBindingHash(BINDING_ID)}-token`);
      expect(existsSync(passFile)).toBe(true);
    }
  });
});
