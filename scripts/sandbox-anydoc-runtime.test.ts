import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("sandbox AnyDoc runtime", () => {
  test("pins one verified native target and proves the CLI during image build", async () => {
    const [dockerfile, manifest, lockfile, license] = await Promise.all([
      readFile(resolve(root, "docker/sandbox.Dockerfile"), "utf8"),
      readFile(resolve(root, "docker/anydoc/package.json"), "utf8"),
      readFile(resolve(root, "docker/anydoc/bun.lock"), "utf8"),
      readFile(resolve(root, "docker/anydoc/LICENSE"), "utf8"),
    ]);

    expect(JSON.parse(manifest)).toMatchObject({
      private: true,
      dependencies: { "@firecrawl/anydoc": "0.1.8" },
    });
    expect(lockfile).toContain('"@firecrawl/anydoc@0.1.8"');
    expect(lockfile).toContain('"@firecrawl/anydoc-linux-x64-gnu@0.1.8"');
    expect(lockfile).toContain('"@firecrawl/anydoc-linux-arm64-gnu@0.1.8"');
    expect(lockfile).toMatch(/sha512-[A-Za-z0-9+/=]+/u);
    expect(createHash("sha256").update(license).digest("hex")).toBe(
      "03a9e7657aac6536fb6458bd220347c4e7f85bd0a51d8d9e8528530b7a682ade",
    );

    expect(dockerfile).toContain("bun install --frozen-lockfile --production --os=linux");
    expect(dockerfile).toContain("node_arch=x64");
    expect(dockerfile).toContain("node_arch=arm64");
    expect(dockerfile).toContain("anydoc-linux-${node_arch}-gnu");
    expect(dockerfile).toContain('test "$(anydoc --version)" = 0.1.8');
    expect(dockerfile).toContain("anydoc /tmp/anydoc-smoke.csv");
    expect(dockerfile).toContain("anydoc /tmp/anydoc-smoke.rtf");
    expect(dockerfile).not.toContain("@firecrawl/anydoc@latest");
  });

  test("ships opt-in guidance that never installs code during a turn", async () => {
    const skill = await readFile(
      resolve(root, "packages/runtime/src/curated_skill_library/document-parsing/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("name: document-parsing");
    expect(skill).toContain("preinstalled `anydoc` CLI");
    expect(skill).toContain("Never install or download AnyDoc at runtime");
    expect(skill).not.toMatch(/\bnpx\b|\bnpm\b|\bpnpm\b|bunx|bun x/u);
  });
});
