import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
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
      alwaysAsk: true,
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
    expect(calls[0]!.action).toMatchObject({ alwaysAsk: true });
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
