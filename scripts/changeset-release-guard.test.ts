import { expect, test } from "bun:test";
import { mkdtemp, rm, cp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { isolatedGitEnvironment } from "../packages/runtime/test/isolated-git-home-fixture";

const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
const guard = workflow.match(/          changeset_count=.*?\n          fi/s)?.[0];
if (!guard) throw new Error("Missing changeset release guard");

test("the service attribution changeset produces a publishable SDK version", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const path = join(root, ".changeset/sdk-service-attribution.md");
  // Version PRs consume changesets; this regression applies while it is pending.
  if (!(await Bun.file(path).exists())) return;
  const text = await Bun.file(path).text();
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  expect(frontmatter).not.toBeNull();
  expect(parse(frontmatter![1]!)).toEqual({ "@opengeni/sdk": "minor" });
  const config = await Bun.file(join(root, ".changeset/config.json")).json();
  const sdk = await Bun.file(join(root, "packages/sdk/package.json")).json();
  expect(sdk.private).not.toBe(true);
  expect(config.ignore).not.toContain(sdk.name);

  // Use the actual installed Changesets planner against an isolated SDK fixture,
  // rather than relying only on a synthetic plan or changing unrelated versions.
  const dir = await mkdtemp(join(tmpdir(), "sdk-service-release-"));
  try {
    await mkdir(join(dir, ".changeset"));
    await mkdir(join(dir, "packages/sdk"), { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "release-fixture",
        private: true,
        workspaces: ["packages/*"],
      }),
    );
    await writeFile(
      join(dir, "packages/sdk/package.json"),
      JSON.stringify({
        name: sdk.name,
        version: sdk.version,
      }),
    );
    await writeFile(
      join(dir, ".changeset/config.json"),
      JSON.stringify({
        ...config,
        fixed: [],
        linked: [],
        ignore: [],
      }),
    );
    await cp(path, join(dir, ".changeset/sdk-service-attribution.md"));
    const gitEnv = isolatedGitEnvironment({
      HOME: join(dir, "home"),
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    });
    for (const args of [
      ["init", "-b", "main"],
      ["add", "package.json", "packages/sdk/package.json", ".changeset/config.json"],
      ["commit", "-m", "fixture"],
    ]) {
      const git = Bun.spawn(["git", ...args], {
        cwd: dir,
        env: gitEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([new Response(git.stdout).text(), new Response(git.stderr).text()]);
      expect(await git.exited).toBe(0);
    }
    const output = join(dir, "plan.json");
    const child = Bun.spawn(
      ["bun", join(root, "node_modules/@changesets/cli/bin.js"), "status", "--output", output],
      { cwd: dir, env: gitEnv, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ status, stdout, stderr }).toMatchObject({ status: 0 });
    const plan = await Bun.file(output).json();
    expect(plan.releases).toContainEqual(
      expect.objectContaining({
        name: "@opengeni/sdk",
        type: "minor",
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  { name: "explicit test-only changeset", changesets: [{ releases: [] }], releases: [], code: 0 },
  {
    name: "ignored package release",
    changesets: [{ releases: [{ name: "private", type: "patch" }] }],
    releases: [],
    code: 1,
  },
  {
    name: "empty changeset cannot mask ignored package release",
    changesets: [{ releases: [] }, { releases: [{ name: "private", type: "patch" }] }],
    releases: [],
    code: 1,
  },
  {
    name: "public package release",
    changesets: [{ releases: [{ name: "public", type: "patch" }] }],
    releases: [{ name: "public" }],
    code: 0,
  },
])("release guard: $name", async ({ changesets, releases, code }) => {
  const dir = await mkdtemp(join(tmpdir(), "changeset-guard-"));
  try {
    const path = join(dir, "plan.json");
    await Bun.write(path, JSON.stringify({ changesets, releases }));
    const child = Bun.spawn(
      ["bash", "-euo", "pipefail", "-c", `plan="$1"\n${guard}`, "guard", path],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(code);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
