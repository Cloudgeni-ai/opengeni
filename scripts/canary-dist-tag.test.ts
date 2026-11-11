import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type libnpmpublish from "libnpmpublish";
import {
  CANARY_BACKFILL_TAG,
  canarySourceDescends,
  currentCanarySources,
  publishCanaryArtifact,
  readRegistryPackage,
  selectCanaryDistTag,
} from "./publish-canary";

const older = "a".repeat(40);
const newer = "b".repeat(40);
const sibling = "c".repeat(40);
// newer descends from older; sibling descends from neither.
const history = new Set([`${older}..${newer}`]);
const descends = (ancestor: string, descendant: string) =>
  history.has(`${ancestor}..${descendant}`);

test("canary moves forward to a source that descends from every tagged source", () => {
  expect(selectCanaryDistTag(newer, [older], descends)).toBe("canary");
  expect(selectCanaryDistTag(newer, [newer], descends)).toBe("canary");
  expect(selectCanaryDistTag(newer, [], descends)).toBe("canary");
});

test("an older or unrelated source publishes under canary-backfill", () => {
  expect(selectCanaryDistTag(older, [newer], descends)).toBe(CANARY_BACKFILL_TAG);
  expect(selectCanaryDistTag(sibling, [older], descends)).toBe(CANARY_BACKFILL_TAG);
  expect(selectCanaryDistTag(newer, [older, sibling], descends)).toBe(CANARY_BACKFILL_TAG);
});

test("canaries published before sources were recorded do not hold the tag", () => {
  expect(selectCanaryDistTag(older, [undefined], descends)).toBe("canary");
  expect(() => selectCanaryDistTag(older, ["main"], descends)).toThrow("invalid");
  expect(() => selectCanaryDistTag("HEAD", [older], descends)).toThrow("invalid");
});

test("ancestry comes from git and an unknown commit fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "canary-dist-tag-"));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.test",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.test",
        },
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q");
    writeFileSync(join(root, "file"), "1");
    git("add", "file");
    git("commit", "-q", "-m", "first");
    const first = git("rev-parse", "HEAD");
    writeFileSync(join(root, "file"), "2");
    git("commit", "-q", "-am", "second");
    const second = git("rev-parse", "HEAD");
    expect(canarySourceDescends(root, first, second)).toBe(true);
    expect(canarySourceDescends(root, second, first)).toBe(false);
    expect(canarySourceDescends(root, first, first)).toBe(true);
    expect(() => canarySourceDescends(root, "d".repeat(40), second)).toThrow(
      "cannot be established",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the tagged source is read once per distinct canary version", async () => {
  const requested: string[] = [];
  const read: typeof readRegistryPackage = (name, _request, _base, options) =>
    readRegistryPackage(
      name,
      async (url) => {
        requested.push(String(url));
        if (String(url).includes("/dist-tags")) return Response.json({ canary: "1.0.1-canary.7" });
        return Response.json({
          name,
          version: options?.receiptVersion,
          ...(options?.receiptVersion === "1.0.1-canary.7" ? { gitHead: older } : {}),
        });
      },
      "https://registry.example.test",
      options,
    );
  const tagged = (canary?: string) => ({ "dist-tags": canary ? { canary } : {}, versions: {} });
  const sources = await currentCanarySources(
    new Map([
      ["@example/a", tagged("1.0.1-canary.7")],
      ["@example/b", tagged("1.0.1-canary.7")],
      ["@example/c", tagged("1.0.1-canary.3")],
      ["@example/d", tagged()],
    ]),
    read,
  );
  expect(sources).toEqual([older, undefined]);
  expect(requested.filter((url) => !url.includes("/dist-tags"))).toEqual([
    "https://registry.example.test/%40example%2Fa/1.0.1-canary.7?write=true",
    "https://registry.example.test/%40example%2Fc/1.0.1-canary.3?write=true",
  ]);
});

test("a malformed tagged source fails before publication", async () => {
  const read: typeof readRegistryPackage = async () => ({
    "dist-tags": { canary: "1.0.1-canary.7" },
    versions: { "1.0.1-canary.7": { gitHead: 7 } },
  });
  await expect(
    currentCanarySources(
      new Map([["@example/a", { "dist-tags": { canary: "1.0.1-canary.7" }, versions: {} }]]),
      read,
    ),
  ).rejects.toThrow("invalid");
});

test("the selected tag reaches npm and the manifest records a valid source", async () => {
  const manifest = {
    name: "@example/package",
    version: "1.0.1-canary.4",
    gitHead: older,
    publishConfig: { access: "public", provenance: true },
  };
  const tags: unknown[] = [];
  const publish = (async (
    _manifest: unknown,
    _tarball: unknown,
    options: { defaultTag: string },
  ) => {
    tags.push(options.defaultTag);
    return { ok: true, status: 201, transparencyLogUrl: "https://search.sigstore.dev/?logIndex=7" };
  }) as unknown as typeof libnpmpublish.publish;
  const tarball = Buffer.from("synthetic-tarball");
  await publishCanaryArtifact(manifest, tarball, "token", publish, "https://example.test");
  await publishCanaryArtifact(
    manifest,
    tarball,
    "token",
    publish,
    "https://example.test",
    undefined,
    undefined,
    CANARY_BACKFILL_TAG,
  );
  expect(tags).toEqual(["canary", CANARY_BACKFILL_TAG]);
  for (const invalid of [
    { manifest: { ...manifest, gitHead: "HEAD" } },
    { manifest, tag: "latest" },
  ]) {
    await expect(
      publishCanaryArtifact(
        invalid.manifest,
        tarball,
        "token",
        publish,
        "https://example.test",
        undefined,
        undefined,
        (invalid.tag ?? "canary") as typeof CANARY_BACKFILL_TAG,
      ),
    ).rejects.toThrow("invalid");
  }
  expect(tags).toHaveLength(2);
});
