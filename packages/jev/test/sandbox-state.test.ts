import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { codeSearchConfig, runCodeSearch } from "../src";
import { cleanPrefix, excludeArgs } from "../src/code-search/recall";
import { FIXTURE_FILES, fakeJevClient, makeFixtureRepo, packPassages } from "./helpers/fixture";
import { LocalCodeSearchWorkspace } from "./helpers/local-workspace";

const describeWithRipgrep = Bun.which("rg") ? describe : describe.skip;

// Token-shaped test value, never a real credential.
const TOKEN = "ogd_TESTONLYcodemodeBearer0123456789abcdefABCDEF";
const SECRET_LINE = `codemodeBearerToken=${TOKEN}`;

/** Platform credential material an agent's workspace can hold next to its code. */
const SECRET_FILES: Record<string, string> = {
  ".opengeni/codemode-tokens/0f3a": `${SECRET_LINE}\n`,
  ".opengeni/git-credentials/github-token": `${SECRET_LINE}\n`,
  "repos/app/.opengeni/codemode-token": `${SECRET_LINE}\n`,
  ".azure/msal_token_cache.json": `{"codemodeBearerToken": "${TOKEN}"}\n`,
  ".config/opengeni/agent/credentials.json": `{"codemodeBearerToken": "${TOKEN}"}\n`,
};
const CODE_FILES: Record<string, string> = {
  "src/codemode.ts": [
    "/** Reads the Codemode bearer token for a command. */",
    "export function codemodeBearerToken(file: string): string {",
    "  return readTokenFile(file);",
    "}",
    "",
  ].join("\n"),
};

const roots: string[] = [];
function repo(): string {
  const root = makeFixtureRepo({
    ...FIXTURE_FILES,
    ...CODE_FILES,
    ...SECRET_FILES,
  });
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const question = "Where does the sandbox keep the codemode bearer token and what is its value?";
const keywords = ["codemodeBearerToken", "codemode token", "ogd", "bearer", "credentials"];

async function search(root: string, paths?: string[]) {
  const ws = new LocalCodeSearchWorkspace(root);
  const result = await runCodeSearch({
    question,
    keywords,
    ...(paths ? { paths } : {}),
    workspace: ws,
    // never widen past a path that matched: the path itself must be what keeps the files out
    config: codeSearchConfig({ recall: { minCandidatesBeforeWiden: 1 } }),
    // the judge accepts anything that mentions the token, so only exclusion can keep it out
    jev: fakeJevClient({ good: ["codemodeBearerToken", "ogd_"] }),
  });
  const read = ws.calls.filter((c) => c.kind === "readText").flatMap((c) => c.args);
  return { result, read };
}

function expectNoSecret(text: string, read: readonly string[]) {
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain("codemodeBearerToken=");
  const passages = packPassages(text).map((p) => p.path);
  expect(passages.some((p) => /\.opengeni|\.azure|\.config\/opengeni/.test(p))).toBe(false);
  expect(read.some((p) => /\.opengeni|\.azure|\.config\/opengeni/.test(p))).toBe(false);
}

describeWithRipgrep("platform credential material is never searched", () => {
  test("a whole-workspace search finds the code but never the credential files", async () => {
    const { result, read } = await search(repo());
    expect(packPassages(result.text).map((p) => p.path)).toContain("src/codemode.ts");
    expectNoSecret(result.text, read);
  });

  test("naming the directory or a file in it as a path does not search it", async () => {
    const root = repo();
    for (const paths of [
      [".opengeni"],
      [".opengeni/codemode-tokens"],
      [".opengeni/codemode-tokens/0f3a"],
      ["./.opengeni/"],
      [".//.opengeni"],
      ["src/../.opengeni"],
      ["repos/app/.opengeni"],
      [".azure"],
      [".config/opengeni/agent"],
    ]) {
      const { result, read } = await search(root, paths);
      expectNoSecret(result.text, read);
    }
  });

  test("a symlink into it is not followed, as a path or during the walk", async () => {
    const root = repo();
    symlinkSync(join(root, ".opengeni"), join(root, "state"));
    symlinkSync(join(root, ".opengeni/codemode-tokens/0f3a"), join(root, "src/token.txt"));
    const walk = await search(root);
    expectNoSecret(walk.result.text, walk.read);
    for (const paths of [["state"], ["state/codemode-tokens"], ["src/token.txt"]]) {
      const { result, read } = await search(root, paths);
      expectNoSecret(result.text, read);
    }
  });
});

describe("the exclusion rule", () => {
  test("every ripgrep call carries the excludes", () => {
    const args = excludeArgs(codeSearchConfig());
    for (const g of ["!**/.opengeni/**", "!**/.azure/**", "!**/.config/opengeni/**"])
      expect(args).toContain(g);
  });

  test("explicit paths into credential directories are refused, in any spelling", () => {
    for (const p of [
      ".opengeni",
      ".opengeni/codemode-tokens",
      "./.opengeni/x",
      ".//.opengeni",
      ".opengeni\\codemode-tokens",
      "repos/x/.opengeni",
      ".OpenGeni/x",
      ".azure",
      "home/.Azure",
      ".config/opengeni",
      ".config/OpenGeni/agent",
      ".config/./opengeni",
      ".config//opengeni/agent",
      "a/../.opengeni",
    ])
      expect(cleanPrefix(p)).toBeNull();
    expect(cleanPrefix("repos/x/src")).toBe("repos/x/src");
    expect(cleanPrefix(".config/other")).toBe(".config/other");
    expect(cleanPrefix(".opengeni-notes")).toBe(".opengeni-notes");
  });
});
