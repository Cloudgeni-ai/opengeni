import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, gunzipSync, gzipSync } from "node:zlib";
import type { PersonalGitHubGitBrokerClaims } from "@opengeni/github";
import {
  packBoundary,
  parseReceivePackRequest,
  readPackCommits,
  ZERO_OID,
} from "../src/integrations/git-receive-pack";
import {
  canonicalJson,
  inspectPersonalGitHubPush,
  PUSH_INSPECTION_MAX_BYTES,
  requestDigest,
  type GatewayDecider,
  type GatewayDecisionInput,
} from "../src/routes/personal-github-gateway-policy";

const identity = {
  claims: { connectionId: "connection-1" } as unknown as PersonalGitHubGitBrokerClaims,
  initiator: { kind: "human" as const, subjectId: "person" },
  unattended: false,
};

let root = "";
const commits: Record<string, string> = {};

function git(args: string[], input?: Buffer): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    input,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function commit(name: string, parent?: string): string {
  writeFileSync(join(root, "file.txt"), `${name}\n`);
  git(["add", "file.txt"]);
  const tree = git(["write-tree"]).toString().trim();
  const oid = git(["commit-tree", tree, "-m", name, ...(parent ? ["-p", parent] : [])])
    .toString()
    .trim();
  commits[name] = oid;
  return oid;
}

function pkt(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, "0")), payload]);
}

/** A receive-pack request as `git push` sends it. */
function pushBody(
  updates: Array<{ old: string; next: string; ref: string }>,
  packRevs: string[],
): Buffer {
  const lines = updates.map((update, index) =>
    pkt(
      `${update.old} ${update.next} ${update.ref}${index === 0 ? "\0report-status side-band-64k" : ""}\n`,
    ),
  );
  const pack =
    packRevs.length > 0
      ? git(
          ["pack-objects", "--stdout", "--revs", "--thin", "-q"],
          Buffer.from(`${packRevs.join("\n")}\n`),
        )
      : Buffer.alloc(0);
  return Buffer.concat([...lines, Buffer.from("0000"), pack]);
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Decides like `databaseGatewayDecider` with every GitHub action at `policy`:
 * Allow runs unless the request always asks; otherwise it waits for approval.
 */
function policyDecider(policy: "allow" | "ask") {
  const calls: GatewayDecisionInput[] = [];
  const decide: GatewayDecider = async (_identity, input) => {
    calls.push(input);
    return policy === "allow" && !input.action.sensitive
      ? { kind: "allow" }
      : {
          kind: "refuse",
          status: 403,
          waiting: true,
          message: `Waiting for approval: ${input.title}.`,
        };
  };
  return { calls, decide };
}

function recordingDecider(answer: Awaited<ReturnType<GatewayDecider>>) {
  const calls: GatewayDecisionInput[] = [];
  const decide: GatewayDecider = async (_identity, input) => {
    calls.push(input);
    return answer;
  };
  return { calls, decide };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "opengeni-push-policy-"));
  execFileSync("git", ["init", "-q", root]);
  const base = commit("base");
  commit("main", base);
  commit("feature", commits.main);
  commit("rewritten", base);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("receive-pack reading", () => {
  test("reads commands and the commits of the pack", () => {
    const body = pushBody(
      [{ old: commits.main!, next: commits.feature!, ref: "refs/heads/main" }],
      [commits.feature!, `^${commits.main!}`],
    );
    const request = parseReceivePackRequest(body)!;
    expect(request.commands).toEqual([
      { oldOid: commits.main!, newOid: commits.feature!, ref: "refs/heads/main" },
    ]);
    expect(request.capabilities).toContain("report-status");
    const pack = readPackCommits(body.subarray(request.packOffset))!;
    expect(pack.commits.get(commits.feature!)).toEqual([commits.main!]);
    expect(packBoundary(pack.commits, commits.feature!, commits.main!).reachedOld).toBe(true);
  });

  test("is not a receive-pack request", () => {
    expect(parseReceivePackRequest(Buffer.from("garbage"))).toBeNull();
  });

  test("a pack cut short still gives the commits before the cut", () => {
    writeFileSync(join(root, "large.bin"), randomBytes(256 * 1024));
    git(["add", "large.bin"]);
    const tree = git(["write-tree"]).toString().trim();
    const large = git(["commit-tree", tree, "-m", "large", "-p", commits.main!]).toString().trim();
    git(["rm", "-q", "--cached", "large.bin"]);
    const body = pushBody(
      [{ old: commits.main!, next: large, ref: "refs/heads/main" }],
      [large, `^${commits.main!}`],
    );
    const request = parseReceivePackRequest(body)!;
    rmSync(join(root, "large.bin"));
    const cut = readPackCommits(body.subarray(request.packOffset, body.byteLength - 1024))!;
    expect(cut.commits.get(large)).toEqual([commits.main!]);
  });

  test("only the parent lines right after the tree are parents, as in Git", () => {
    // Git accepts this header (`git fsck --strict` too) but reads one
    // parent: a `parent` line after `author` is not one.
    const tree = git(["write-tree"]).toString().trim();
    const crafted = git(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      Buffer.from(
        `tree ${tree}\nparent ${commits.rewritten!}\nauthor t <t@t> 0 +0000\n` +
          `committer t <t@t> 0 +0000\nparent ${commits.main!}\n\ncrafted\n`,
      ),
    )
      .toString()
      .trim();
    commits.crafted = crafted;
    const body = pushBody(
      [{ old: commits.main!, next: crafted, ref: "refs/heads/main" }],
      [crafted, `^${commits.main!}`],
    );
    const request = parseReceivePackRequest(body)!;
    const pack = readPackCommits(body.subarray(request.packOffset))!;
    expect(pack.commits.get(crafted)).toEqual([commits.rewritten!]);
    expect(packBoundary(pack.commits, crafted, commits.main!).reachedOld).toBe(false);
  });
});

/**
 * Exactly what git 2.47.3 sent for `git push -u origin test/gh-gateway-e2e`
 * of a new branch from a `--depth 1` clone, the way managed sandboxes clone:
 * a `shallow` line first, then the command carrying the capabilities.
 */
const CAPTURED_SHALLOW_NEW_BRANCH_PUSH = Buffer.from(
  "MDAzNXNoYWxsb3cgNDZlZGIyOTkwOWFkNTUzN2YwZDY3YmMzMTY3OTMzNjNiMDdiZGJmZgowMGJlMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCBiNjY3NGRlN2RmNTE2MjIxODJhOTA4MjJiYjYwMGNhYzkwMGUzNTk2IHJlZnMvaGVhZHMvdGVzdC9naC1nYXRld2F5LWUyZQAgcmVwb3J0LXN0YXR1cy12MiBzaWRlLWJhbmQtNjRrIHF1aWV0IG9iamVjdC1mb3JtYXQ9c2hhMSBhZ2VudD1naXQvMi40Ny4zMDAwMFBBQ0sAAAACAAAAA5QKeJx9ykEOAiEMAMA7r+DuhVIoNDFmvwK0jR7WNWv9v77AOY+fqlGFjFbNiZooi2YoGQxWF9PcszHQEOsjvMapT4+FVGZmTjykVmyWhNpcCNQYkXCmNmWahfHx+3FGj1ff/BahcUkVGTBe0k9Yx74/3PVPCe/wBVJbLTKqA3icMzQwMDMxUUhkqJghqZRorfU7QZVF/9ve9q6DM/1aDSGSxQxbKiLD98zIPTwnae7LXyfvu03XYfgDAE9GF7MyeJwr5gIAAPIAfknW7Ijalv21IeNXM0bsMGV+Z7By",
  "base64",
);

describe("pushes from a shallow clone", () => {
  test("read the capabilities from the first command, after the shallow lines", () => {
    const request = parseReceivePackRequest(CAPTURED_SHALLOW_NEW_BRANCH_PUSH)!;
    expect(request.commands).toEqual([
      {
        oldOid: ZERO_OID,
        newOid: "b6674de7df51622182a90822bb600cac900e3596",
        ref: "refs/heads/test/gh-gateway-e2e",
      },
    ]);
    expect(request.capabilities).toEqual([
      "report-status-v2",
      "side-band-64k",
      "quiet",
      "object-format=sha1",
      "agent=git/2.47.3",
    ]);
    const pack = readPackCommits(CAPTURED_SHALLOW_NEW_BRANCH_PUSH.subarray(request.packOffset))!;
    expect(pack.commits.get("b6674de7df51622182a90822bb600cac900e3596")).toEqual([
      "46edb29909ad5537f0d67bc316793363b07bdbff",
    ]);
  });

  for (const gzip of [false, true]) {
    test(`a captured new branch goes through without asking${gzip ? " (gzip)" : ""}`, async () => {
      const { calls, decide } = recordingDecider({ kind: "allow" });
      const result = await inspectPersonalGitHubPush({
        body: stream(
          gzip ? gzipSync(CAPTURED_SHALLOW_NEW_BRANCH_PUSH) : CAPTURED_SHALLOW_NEW_BRANCH_PUSH,
        ),
        gzip,
        repositoryFullName: "Cloudgeni-ai/opengeni",
        isAncestor: async () => {
          throw new Error("not needed");
        },
        identity,
        decide,
      });
      expect(result).toMatchObject({ kind: "forward", requestId: null });
      expect(calls).toEqual([]);
    });
  }
});

/**
 * A smart-HTTP Git server (`git http-backend`) that records every
 * receive-pack request body exactly as the Git client sent it.
 */
function recordingGitServer(projectRoot: string) {
  const pushes: Array<{ body: Buffer; gzip: boolean }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = Buffer.from(await request.arrayBuffer());
      const gzip = request.headers.get("content-encoding")?.toLowerCase() === "gzip";
      if (url.pathname.endsWith("/git-receive-pack")) pushes.push({ body, gzip });
      const child = Bun.spawn(["git", "http-backend"], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.searchParams.toString(),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: String(body.byteLength),
          HTTP_CONTENT_ENCODING: gzip ? "gzip" : "",
          HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      child.stdin.write(body);
      child.stdin.end();
      const output = Buffer.from(await new Response(child.stdout).arrayBuffer());
      await child.exited;
      const split = output.indexOf("\r\n\r\n");
      const headers = new Headers();
      let status = 200;
      for (const line of output.subarray(0, split).toString("latin1").split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon < 1) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else headers.append(name, value);
      }
      return new Response(output.subarray(split + 4), { status, headers });
    },
  });
  return { server, pushes };
}

describe("pushes a real Git client sends from a shallow clone", () => {
  let workRoot = "";
  let server: ReturnType<typeof Bun.serve> | null = null;
  const captured: Record<string, { body: Buffer; gzip: boolean }> = {};
  let provider = "";
  const branchTips: Record<string, string> = {};

  beforeAll(async () => {
    workRoot = mkdtempSync(join(tmpdir(), "opengeni-push-capture-"));
    const projectRoot = join(workRoot, "provider");
    provider = join(projectRoot, "acme", "widgets.git");
    mkdirSync(provider, { recursive: true });
    const environment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    // Asynchronous: the recording server runs in this process.
    const run = async (cwd: string, args: string[]) => {
      const child = Bun.spawn(["git", ...args], {
        cwd,
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
      return stdout.trim();
    };
    await run(provider, ["init", "-q", "--bare", "--initial-branch=main"]);
    await run(provider, ["config", "http.receivepack", "true"]);
    // Push options add a capability the pack offset depends on.
    await run(provider, ["config", "receive.advertisePushOptions", "true"]);
    // Some history, so the clone below is genuinely shallow.
    const seed = join(workRoot, "seed");
    await run(workRoot, ["init", "-q", "--initial-branch=main", seed]);
    for (const text of ["one", "two", "three"]) {
      writeFileSync(join(seed, "file.txt"), `${text}\n`);
      await run(seed, ["add", "file.txt"]);
      await run(seed, ["commit", "-q", "-m", text]);
    }
    await run(seed, ["push", "-q", provider, "main"]);
    const recording = recordingGitServer(projectRoot);
    server = recording.server;
    const remote = `http://127.0.0.1:${server.port}/acme/widgets.git`;
    const client = join(workRoot, "client");
    await run(workRoot, ["clone", "-q", "--depth", "1", remote, client]);
    expect(await run(client, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    const push = async (name: string, args: string[]) => {
      const before = recording.pushes.length;
      await run(client, ["push", "-q", "origin", ...args]);
      expect(recording.pushes.length).toBe(before + 1);
      captured[name] = recording.pushes[before]!;
    };
    const commitText = async (text: string) => {
      writeFileSync(join(client, "file.txt"), `${text}\n`);
      await run(client, ["add", "file.txt"]);
      await run(client, ["commit", "-q", "-m", text]);
      return await run(client, ["rev-parse", "HEAD"]);
    };
    await run(client, ["checkout", "-q", "-b", "topic"]);
    branchTips.topic = await commitText("topic");
    await push("newBranch", ["-u", "topic"]);
    await run(client, ["checkout", "-q", "main"]);
    branchTips.main = await commitText("four");
    await push("fastForward", ["--push-option=ci.skip", "main"]);
    await run(client, ["checkout", "-q", "topic"]);
    await run(client, ["commit", "-q", "--amend", "-m", "topic rewritten"]);
    await push("forcePush", ["--force", "topic"]);
    await push("deletion", [":topic"]);
    await run(client, ["checkout", "-q", "main"]);
    await run(client, ["commit", "-q", "--amend", "-m", "four rewritten"]);
    await push("defaultForcePush", ["--force", "main"]);
    await run(client, ["tag", "v1"]);
    await push("tag", ["v1"]);
    await push("tagDeletion", [":refs/tags/v1"]);
  }, 60_000);

  afterAll(() => {
    server?.stop(true);
    if (workRoot) rmSync(workRoot, { recursive: true, force: true });
  });

  /** The provider repository answers ancestry, as GitHub's compare does. */
  const isAncestor = async (base: string, head: string) => {
    try {
      execFileSync("git", ["-C", provider, "merge-base", "--is-ancestor", base, head], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };

  const inspectCaptured = async (
    name: string,
    gzip: boolean,
    decide: GatewayDecider,
    defaultBranch: string | null = null,
  ) => {
    const sent = captured[name]!;
    const plain = sent.gzip ? gunzipSync(sent.body) : sent.body;
    expect(plain.subarray(4, 12).toString("latin1")).toBe("shallow ");
    return await inspectPersonalGitHubPush({
      body: stream(gzip ? gzipSync(plain) : plain),
      gzip,
      repositoryFullName: "acme/widgets",
      defaultBranch,
      isAncestor,
      identity,
      decide,
    });
  };

  for (const gzip of [false, true]) {
    const label = gzip ? " (gzip)" : "";

    test(`a new branch and a fast-forward go through without asking${label}`, async () => {
      const { calls, decide } = recordingDecider({ kind: "allow" });
      expect(await inspectCaptured("newBranch", gzip, decide)).toMatchObject({
        kind: "forward",
        requestId: null,
      });
      expect(await inspectCaptured("fastForward", gzip, decide)).toMatchObject({
        kind: "forward",
        requestId: null,
      });
      expect(calls).toEqual([]);
    });

    test(`a force push and a deletion ask when the default branch is unknown${label}`, async () => {
      const { calls, decide } = recordingDecider({
        kind: "refuse",
        status: 403,
        waiting: true,
        message: "Waiting for approval.",
      });
      const forced = await inspectCaptured("forcePush", gzip, decide);
      const deleted = await inspectCaptured("deletion", gzip, decide);
      expect(calls.map((call) => call.title)).toEqual([
        "Force-push topic on acme/widgets",
        "Delete topic on acme/widgets",
      ]);
      expect(calls.every((call) => call.action.sensitive)).toBe(true);
      for (const result of [forced, deleted]) {
        expect(result.kind).toBe("respond");
        if (result.kind !== "respond") continue;
        const text = Buffer.from(await result.response.arrayBuffer()).toString("latin1");
        expect(text).toContain("ng refs/heads/topic waiting for approval");
      }
    });
  }

  test("with Allow, force-pushing and deleting another branch go through", async () => {
    const { calls, decide } = policyDecider("allow");
    for (const name of ["forcePush", "deletion"]) {
      expect(await inspectCaptured(name, false, decide, "main")).toMatchObject({
        kind: "forward",
        requestId: null,
      });
    }
    expect(calls.map((call) => [call.title, call.action.sensitive])).toEqual([
      ["Force-push topic on acme/widgets", false],
      ["Delete topic on acme/widgets", false],
    ]);
  });

  test("with Ask first, force-pushing and deleting another branch ask", async () => {
    const { calls, decide } = policyDecider("ask");
    for (const name of ["forcePush", "deletion"]) {
      const result = await inspectCaptured(name, true, decide, "main");
      expect(result.kind).toBe("respond");
      if (result.kind !== "respond") continue;
      const text = Buffer.from(await result.response.arrayBuffer()).toString("latin1");
      expect(text).toContain("ng refs/heads/topic waiting for approval");
    }
    expect(calls).toHaveLength(2);
  });

  test("with Allow, force-pushing the default branch and deleting a tag still ask", async () => {
    const { calls, decide } = policyDecider("allow");
    const forced = await inspectCaptured("defaultForcePush", false, decide, "main");
    const tagDeleted = await inspectCaptured("tagDeletion", false, decide, "main");
    expect(calls.map((call) => [call.title, call.action.sensitive])).toEqual([
      ["Force-push main on acme/widgets", true],
      ["Delete tag v1 on acme/widgets", true],
    ]);
    for (const [result, ref] of [
      [forced, "refs/heads/main"],
      [tagDeleted, "refs/tags/v1"],
    ] as const) {
      expect(result.kind).toBe("respond");
      if (result.kind !== "respond") continue;
      const text = Buffer.from(await result.response.arrayBuffer()).toString("latin1");
      expect(text).toContain(`ng ${ref} waiting for approval`);
    }
    // A default branch spelled in another case is still the default branch.
    expect((await inspectCaptured("defaultForcePush", false, decide, "MAIN")).kind).toBe("respond");
  });

  test("the captured commands are the pushes that were made", () => {
    const plainOf = (name: string) => {
      const sent = captured[name]!;
      return sent.gzip ? gunzipSync(sent.body) : sent.body;
    };
    const commandsOf = (name: string) => parseReceivePackRequest(plainOf(name))!.commands;
    expect(commandsOf("newBranch")).toEqual([
      { oldOid: ZERO_OID, newOid: branchTips.topic!, ref: "refs/heads/topic" },
    ]);
    expect(commandsOf("fastForward")[0]!.newOid).toBe(branchTips.main!);
    expect(parseReceivePackRequest(plainOf("fastForward"))!.capabilities).toContain("push-options");
    expect(commandsOf("deletion")[0]!.newOid).toBe(ZERO_OID);
  });
});

describe("push approvals", () => {
  const inspect = (
    body: Uint8Array,
    decide: GatewayDecider,
    isAncestor: (base: string, head: string) => Promise<boolean | null> = async () => null,
    gzip = false,
  ) =>
    inspectPersonalGitHubPush({
      body: stream(gzip ? gzipSync(body) : body),
      gzip,
      repositoryFullName: "acme/widgets",
      identity,
      decide,
      isAncestor,
    });

  test("a new branch and a fast-forward push go through unchanged", async () => {
    const { calls, decide } = recordingDecider({ kind: "allow" });
    const created = await inspect(
      pushBody(
        [{ old: ZERO_OID, next: commits.feature!, ref: "refs/heads/new" }],
        [commits.feature!],
      ),
      decide,
    );
    expect(created.kind).toBe("forward");
    const body = pushBody(
      [{ old: commits.main!, next: commits.feature!, ref: "refs/heads/main" }],
      [commits.feature!, `^${commits.main!}`],
    );
    const forwarded = await inspect(body, decide, async () => {
      throw new Error("not needed");
    });
    expect(forwarded.kind).toBe("forward");
    if (forwarded.kind === "forward") {
      expect(Buffer.from(forwarded.body as Uint8Array).equals(body)).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  test("a force push waits for approval with Git's own rejection", async () => {
    const { calls, decide } = recordingDecider({
      kind: "refuse",
      status: 403,
      waiting: true,
      message: "Waiting for approval: Force-push main on acme/widgets.",
    });
    const result = await inspect(
      pushBody(
        [{ old: commits.feature!, next: commits.rewritten!, ref: "refs/heads/main" }],
        [commits.rewritten!, `^${commits.base!}`],
      ),
      decide,
      async (base, head) => base === commits.base && head === commits.base,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.action).toMatchObject({
      kind: "write",
      sensitive: true,
      tools: ["ref_create"],
    });
    expect(calls[0]!.title).toBe("Force-push main on acme/widgets");
    expect(result.kind).toBe("respond");
    if (result.kind !== "respond") return;
    const text = Buffer.from(await result.response.arrayBuffer()).toString("latin1");
    expect(text).toContain("ng refs/heads/main waiting for approval");
    expect(text).toContain("GitHub gateway: Waiting for approval");
  });

  test("moving a branch to a commit GitHub has asks unless it is a fast-forward", async () => {
    const { calls, decide } = recordingDecider({ kind: "run", requestId: "request-1" });
    const backwards = await inspect(
      pushBody([{ old: commits.feature!, next: commits.main!, ref: "refs/heads/main" }], []),
      decide,
      async () => false,
    );
    expect(backwards).toMatchObject({ kind: "forward", requestId: "request-1" });
    expect(calls).toHaveLength(1);
    const forward = await inspect(
      pushBody([{ old: commits.main!, next: commits.feature!, ref: "refs/heads/main" }], []),
      decide,
      async () => true,
    );
    expect(forward).toMatchObject({ kind: "forward", requestId: null });
    expect(calls).toHaveLength(1);
  });

  test("a commit naming the old tip outside its parents is still a force push", async () => {
    const { calls, decide } = recordingDecider({ kind: "allow" });
    await inspect(
      pushBody(
        [{ old: commits.main!, next: commits.crafted!, ref: "refs/heads/main" }],
        [commits.crafted!, `^${commits.main!}`],
      ),
      decide,
      async () => false,
    );
    expect(calls.map((call) => call.title)).toEqual(["Force-push main on acme/widgets"]);
  });

  test("deleting a branch or tag asks, and the same push has the same digest", async () => {
    const { calls, decide } = recordingDecider({ kind: "allow" });
    const body = pushBody(
      [
        { old: commits.main!, next: ZERO_OID, ref: "refs/heads/old" },
        { old: commits.main!, next: ZERO_OID, ref: "refs/tags/v1" },
      ],
      [],
    );
    await inspect(body, decide);
    await inspect(body, decide, undefined, true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.title).toBe("Delete old, delete tag v1 on acme/widgets");
    expect(calls[0]!.digest).toBe(calls[1]!.digest);
  });
});

describe("pushes over the inspection limit", () => {
  const fakeOid = (seed: string) => createHash("sha1").update(seed).digest("hex");
  const objectHeader = (type: number, size: number) => {
    const bytes = [(type << 4) | (size & 0x0f)];
    let rest = Math.floor(size / 16);
    while (rest > 0) {
      bytes[bytes.length - 1]! |= 0x80;
      bytes.push(rest & 0x7f);
      rest = Math.floor(rest / 128);
    }
    return Buffer.from(bytes);
  };
  const packObject = (type: number, content: Buffer, level?: number) =>
    Buffer.concat([
      objectHeader(type, content.length),
      deflateSync(content, level === undefined ? {} : { level }),
    ]);
  const commitObject = (parent: string, message: string) => {
    const content = Buffer.from(
      `tree ${fakeOid("tree")}\nparent ${parent}\nauthor t <t@t> 0 +0000\n` +
        `committer t <t@t> 0 +0000\n\n${message}\n`,
    );
    const oid = createHash("sha1")
      .update(`commit ${content.length}\0`)
      .update(content)
      .digest("hex");
    return { oid, object: packObject(1, content) };
  };
  /** A push whose pack has a blob that runs past the inspection limit. */
  const largePush = (oldOid: string, objects: Buffer[], tip: string) => {
    const header = Buffer.alloc(12);
    header.write("PACK", 0, "latin1");
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(objects.length, 8);
    const pack = Buffer.concat([header, ...objects, Buffer.alloc(20)]);
    return Buffer.concat([
      pkt(`${oldOid} ${tip} refs/heads/topic\0report-status side-band-64k\n`),
      Buffer.from("0000"),
      pack,
    ]);
  };
  const largeBlob = () =>
    packObject(3, Buffer.alloc(PUSH_INSPECTION_MAX_BYTES + 1024 * 1024, 7), 0);
  const chunked = (bytes: Buffer): ReadableStream<Uint8Array> => {
    let offset = 0;
    return new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + 1024 * 1024));
        offset += 1024 * 1024;
      },
    });
  };
  const inspectLarge = (body: Buffer, decide: GatewayDecider) =>
    inspectPersonalGitHubPush({
      body: chunked(body),
      gzip: false,
      repositoryFullName: "acme/widgets",
      identity,
      decide,
      // GitHub's compare does not know commits that are only in the push.
      isAncestor: async () => null,
    });

  test("a fast-forward goes through with the commits read before the cut", async () => {
    const oldTip = fakeOid("old tip");
    const tip = commitObject(oldTip, "tip");
    const body = largePush(oldTip, [tip.object, largeBlob()], tip.oid);
    expect(body.byteLength).toBeGreaterThan(PUSH_INSPECTION_MAX_BYTES);
    const { calls, decide } = recordingDecider({ kind: "allow" });
    const result = await inspectLarge(body, decide);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ kind: "forward", requestId: null });
    if (result.kind !== "forward") return;
    const forwarded = Buffer.from(await new Response(result.body as BodyInit).arrayBuffer());
    expect(forwarded.equals(body)).toBe(true);
  }, 60_000);

  test("a force push whose history continues past the cut asks", async () => {
    const oldTip = fakeOid("old tip");
    const middle = commitObject(oldTip, "middle");
    const tip = commitObject(middle.oid, "tip");
    const body = largePush(oldTip, [tip.object, largeBlob(), middle.object], tip.oid);
    const { calls, decide } = recordingDecider({
      kind: "refuse",
      status: 403,
      waiting: true,
      message: "Waiting for approval.",
    });
    const result = await inspectLarge(body, decide);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.title).toBe("Force-push topic on acme/widgets");
    expect(result.kind).toBe("respond");
  }, 60_000);
});

describe("pushes the gateway cannot read", () => {
  test("ask instead of going through unchecked", async () => {
    const { calls, decide } = recordingDecider({
      kind: "refuse",
      status: 403,
      waiting: true,
      message: "Waiting for approval: Push to acme/widgets.",
    });
    const result = await inspectPersonalGitHubPush({
      body: stream(Buffer.from("not a receive-pack request")),
      gzip: false,
      repositoryFullName: "acme/widgets",
      isAncestor: async () => null,
      identity,
      decide,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.action).toMatchObject({ sensitive: true });
    expect(result.kind).toBe("respond");
    if (result.kind === "respond") {
      expect(result.response.status).toBe(200);
      const text = await result.response.text();
      expect(text.slice(4)).toStartWith("ERR GitHub gateway: Waiting for approval");
      expect(Number.parseInt(text.slice(0, 4), 16)).toBe(Buffer.byteLength(text));
    }
    const sideBand = await inspectPersonalGitHubPush({
      body: stream(Buffer.from("garbage report-status side-band-64k")),
      gzip: false,
      repositoryFullName: "acme/widgets",
      isAncestor: async () => null,
      identity,
      decide,
    });
    if (sideBand.kind === "respond") {
      expect((await sideBand.response.text()).slice(4)).toStartWith(
        "\u0003GitHub gateway: Waiting",
      );
    }
    // A compressed push it cannot inflate whole still answers on side-band.
    const compressed = gzipSync(
      pushBody(
        [{ old: commits.main!, next: commits.feature!, ref: "refs/heads/main" }],
        [commits.feature!, `^${commits.main!}`],
      ),
    );
    const truncated = await inspectPersonalGitHubPush({
      body: stream(compressed.subarray(0, compressed.byteLength - 12)),
      gzip: true,
      repositoryFullName: "acme/widgets",
      isAncestor: async () => null,
      identity,
      decide,
    });
    expect(truncated.kind).toBe("respond");
    if (truncated.kind === "respond") {
      expect((await truncated.response.text()).slice(4)).toStartWith(
        "\u0003GitHub gateway: Waiting",
      );
    }
  });

  test("a flush with nothing to push goes on", async () => {
    const { calls, decide } = recordingDecider({ kind: "allow" });
    const result = await inspectPersonalGitHubPush({
      body: stream(Buffer.from("0000")),
      gzip: false,
      repositoryFullName: "acme/widgets",
      isAncestor: async () => null,
      identity,
      decide,
    });
    expect(result.kind).toBe("forward");
    expect(calls).toEqual([]);
  });
});

describe("request digests", () => {
  test("ignore key order and differ by content", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(requestDigest(["api", "POST", { a: 1, b: 2 }])).toBe(
      requestDigest(["api", "POST", { b: 2, a: 1 }]),
    );
    expect(requestDigest(["api", "POST", { a: 1 }])).not.toBe(
      requestDigest(["api", "POST", { a: 2 }]),
    );
  });
});
