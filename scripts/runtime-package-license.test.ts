import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const runtimeRoot = join(root, "packages/runtime");
const packagedLicensePath = "package/src/curated_skill_library/LICENSE";
const expectedLicenseSha256 = "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04";
const pinnedSourceCommit = "de4323afdfbc30d1387f287b55062fa8d82b62e8";
const mplSkillIds = [
  "azure-verified-modules",
  "refactor-module",
  "terraform-search-import",
  "terraform-stacks",
  "terraform-style-guide",
  "terraform-test",
] as const;

describe("@opengeni/runtime package licensing", () => {
  test("ships the exact MPL-2.0 license and notice for curated Terraform Skills", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "opengeni-runtime-license-"));

    try {
      const packed = JSON.parse(
        (
          await spawn(
            ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
            runtimeRoot,
          )
        ).toString("utf8"),
      ) as Array<{ filename?: string; files?: Array<{ path?: string }> }>;
      const packageResult = packed[0];
      expect(packed).toHaveLength(1);
      expect(packageResult?.filename).toBeString();
      expect(packageResult?.files?.map((file) => file.path)).toContain(
        "src/curated_skill_library/LICENSE",
      );
      expect(packageResult?.files?.map((file) => file.path)).toContain("THIRD_PARTY_NOTICES");

      const tarball = join(scratch, packageResult!.filename!);
      const archiveEntries = (await spawn(["tar", "-tzf", tarball], root)).toString("utf8");
      expect(archiveEntries.split("\n")).toContain(packagedLicensePath);

      const [packagedLicense, sourceLicense, packagedNotices] = await Promise.all([
        spawn(["tar", "-xOzf", tarball, packagedLicensePath], root),
        readFile(join(runtimeRoot, "src/curated_skill_library/LICENSE")),
        spawn(["tar", "-xOzf", tarball, "package/THIRD_PARTY_NOTICES"], root),
      ]);
      expect(packagedLicense).toEqual(sourceLicense);
      expect(createHash("sha256").update(packagedLicense).digest("hex")).toBe(
        expectedLicenseSha256,
      );

      const notices = packagedNotices.toString("utf8");
      expect(notices).toContain(pinnedSourceCommit);
      expect(notices).toContain("src/curated_skill_library/LICENSE");
      for (const skillId of mplSkillIds) expect(notices).toContain(`- ${skillId}`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

async function spawn(argv: string[], cwd: string): Promise<Buffer> {
  const child = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${argv[0]} failed: ${stderr.trim()}`);
  return Buffer.from(stdout);
}
