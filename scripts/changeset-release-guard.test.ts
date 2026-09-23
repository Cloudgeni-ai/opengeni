import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
const guard = workflow.match(/          changeset_count=.*?\n          fi/s)?.[0];
if (!guard) throw new Error("Missing changeset release guard");

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
