import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regenerateMerge } from "./regenerate-merge";

// A generator that writes every source file into one line, like a minified
// bundle: two branches that change different sources conflict in its output.
const GENERATOR = `
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const parts = readdirSync("src").sort().map((f) => readFileSync("src/" + f, "utf8").trim());
if (parts.includes("fail")) { console.error("generator failed"); process.exit(2); }
writeFileSync("gen/out.gen.txt", parts.join("|") + "\\n");
writeFileSync("unrelated.txt", "touched by the generator\\n");
`;
const REGISTRY = [{ name: "Toy", artifacts: ["gen/out.gen.txt"], regenerate: "bun gen.ts" }];

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "regenerate-merge-"));
  repos.push(cwd);
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
    return child.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  const write = (path: string, text: string) => {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const generate = () => {
    const child = Bun.spawnSync(["bun", "gen.ts"], { cwd, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  write("gen.ts", GENERATOR);
  write("src/a.txt", "a1\n");
  write("notes.md", "base\n");
  mkdirSync(join(cwd, "gen"));
  generate();
  write("unrelated.txt", "base\n");
  commit("base");
  return { cwd, git, write, generate, commit };
}

/** main adds a source and regenerates; the PR branch changes another source and regenerates. */
function divergent(prNotes?: string, mainNotes?: string) {
  const repo = repository();
  repo.git("checkout", "-q", "-b", "pr");
  repo.write("src/a.txt", "a2\n");
  if (prNotes) repo.write("notes.md", prNotes);
  repo.generate();
  repo.write("unrelated.txt", "base\n");
  const head = repo.commit("pr change");
  repo.git("checkout", "-q", "main");
  repo.write("src/b.txt", "b\n");
  if (mainNotes) repo.write("notes.md", mainNotes);
  repo.generate();
  repo.write("unrelated.txt", "base\n");
  const main = repo.commit("main change");
  repo.git("checkout", "-q", "--detach", head);
  return { ...repo, head, main };
}

const options = (repo: { cwd: string; head: string; main: string }) => ({
  cwd: repo.cwd,
  pull: 7,
  head: repo.head,
  main: repo.main,
  registry: REGISTRY,
  install: null,
  log: () => {},
});

describe("regenerating a merge of main", () => {
  test("takes main's generated file, merges main and regenerates it from both sides", async () => {
    const repo = divergent();
    const result = await regenerateMerge(options(repo));
    if (result.outcome !== "regenerated") throw new Error(`unexpected ${result.outcome}`);
    expect(result.conflicted).toEqual(["gen/out.gen.txt"]);
    expect(result.commands).toEqual(["bun gen.ts"]);
    // Only the registered artifact is reported, never what else the generator touched.
    expect(result.files).toEqual([
      {
        path: "gen/out.gen.txt",
        mode: "100644",
        content: Buffer.from("a2|b\n").toString("base64"),
      },
    ]);

    // The batcher's way on GitHub: commit main's version on the branch, then
    // merge main. Its tree must be the one the result was regenerated on.
    repo.git("checkout", "-q", "--force", "-B", "batcher", repo.head);
    repo.git("checkout", repo.main, "--", "gen/out.gen.txt");
    repo.git("commit", "-q", "-m", "take main's version");
    repo.git("merge", "-q", "--no-edit", repo.main);
    expect(repo.git("rev-parse", "HEAD^{tree}")).toBe(result.mergedTree);
  });

  test("a conflict outside generated files is reported with every conflicting path", async () => {
    const repo = divergent("pr notes\n", "main notes\n");
    expect(await regenerateMerge(options(repo))).toEqual({
      version: 1,
      pull: 7,
      head: repo.head,
      main: repo.main,
      outcome: "conflict",
      conflicted: ["gen/out.gen.txt", "notes.md"],
    });
  });

  test("a merge without a conflict needs nothing", async () => {
    const repo = repository();
    const main = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", "-b", "pr");
    repo.write("notes.md", "pr notes\n");
    const head = repo.commit("pr change");
    expect(await regenerateMerge(options({ cwd: repo.cwd, head, main }))).toMatchObject({
      outcome: "clean",
    });
  });

  test("a failing generator or the wrong checkout fails the run", async () => {
    const repo = divergent();
    repo.write("src/c.txt", "fail\n");
    await expect(regenerateMerge(options(repo))).rejects.toThrow("`bun gen.ts` exited 2");
    await expect(regenerateMerge({ ...options(repo), head: repo.main })).rejects.toThrow(
      "is not checked out at",
    );
  });

  test("a blobless clone is refused before merging, since its merge can't check out", async () => {
    const repo = divergent();
    repo.git("config", "uploadpack.allowFilter", "true");
    const cwd = mkdtempSync(join(tmpdir(), "regenerate-merge-clone-"));
    repos.push(cwd);
    const git = (...args: string[]) => {
      const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      if (child.exitCode !== 0)
        throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
    };
    git("clone", "-q", "--no-checkout", "--filter=blob:none", `file://${repo.cwd}`, ".");
    git("checkout", "-q", "--detach", repo.head);
    await expect(regenerateMerge({ ...options(repo), cwd })).rejects.toThrow(
      "The checkout is a partial clone",
    );
  });
});
