import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  githubPageFontsOutputPath,
  renderGitHubPageFontsModule,
} from "./generate-github-page-fonts";

describe("generated GitHub page fonts", () => {
  test("match the font files the web app ships", async () => {
    expect(await readFile(githubPageFontsOutputPath, "utf8")).toBe(
      await renderGitHubPageFontsModule(),
    );
  });
});
