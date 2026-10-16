import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changesetPackages, ignoredOnlyChangesets } from "./drop-ignored-changesets";

describe("ignored-package changesets", () => {
  test("parses quoted and unquoted package names", () => {
    expect(
      changesetPackages('---\n"opengeni-web": patch\n@opengeni/sdk: minor\n---\n\nNote.\n'),
    ).toEqual(["opengeni-web", "@opengeni/sdk"]);
    expect(changesetPackages("---\n---\n\nEmpty.\n")).toEqual([]);
    expect(changesetPackages("No front matter.\n")).toBeUndefined();
  });

  test("selects only changesets whose every package is ignored", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ignored-changesets-"));
    try {
      await writeFile(join(directory, "README.md"), "# Changesets\n");
      await writeFile(join(directory, "config.json"), "{}\n");
      await writeFile(join(directory, "web-only.md"), '---\n"opengeni-web": patch\n---\n\nWeb.\n');
      await writeFile(
        join(directory, "mixed.md"),
        '---\n"opengeni-web": patch\n"@opengeni/sdk": patch\n---\n\nMixed.\n',
      );
      await writeFile(join(directory, "sdk.md"), '---\n"@opengeni/sdk": minor\n---\n\nSDK.\n');
      await writeFile(join(directory, "empty.md"), "---\n---\n\nEmpty.\n");
      expect(ignoredOnlyChangesets(directory, ["opengeni-web", "@opengeni/testing"])).toEqual([
        "web-only.md",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects front matter it cannot read instead of guessing", () => {
    expect(() => changesetPackages("---\nnot a package line\n---\n")).toThrow(
      "unrecognized changeset front matter line",
    );
  });
});
