#!/usr/bin/env bun
/**
 * For the merge batcher: merge main into a queued PR whose conflicts with
 * main are all in generated files, and regenerate those files. Two PRs that
 * both regenerated one file conflict in Git although neither did anything
 * wrong, and ejecting the second one costs it a trip to the back of the queue.
 *
 * .github/workflows/regenerate-generated.yml runs this script and the registry
 * it reads from a checkout of main, in a checkout of the PR head, with a
 * read-only token. It runs the PR's own install and generators, writes the
 * result as JSON and pushes nothing: the batcher checks the result and commits
 * it to the PR's branch itself (scripts/batcher/pass.ts). The result is one of:
 *
 * - clean: main merges without a conflict, so there is nothing to regenerate;
 * - conflict: a file that is not generated conflicts, so a person must merge;
 * - regenerated: each conflicted file takes main's version, main is merged
 *   (`mergedTree` is that tree), the generators of those files run, and every
 *   file they changed is listed with its new content.
 *
 *   bun scripts/ci/regenerate-merge.ts --pull 123 --head <sha> --main <sha> --out result.json
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { RegeneratedFile, Regeneration } from "../batcher/regenerate";
import {
  REGENERATED_ON_CONFLICT,
  regenerates,
  type RegeneratedArtifact,
} from "./check-generated-artifacts";

export interface RegenerateMergeOptions {
  /** The checkout of the PR head. */
  cwd: string;
  pull: number;
  head: string;
  main: string;
  registry?: readonly RegeneratedArtifact[];
  /** Installs the PR's dependencies before its generators run; null skips it. */
  install?: readonly string[] | null;
  log?: (line: string) => void;
}

const SHA = /^[0-9a-f]{40}$/;

function spawn(argv: readonly string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawnSync([...argv], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exit: child.exitCode, stdout: child.stdout, stderr: child.stderr.toString() };
}

export async function regenerateMerge(options: RegenerateMergeOptions): Promise<Regeneration> {
  const { cwd, pull, head, main } = options;
  const registry = options.registry ?? REGENERATED_ON_CONFLICT;
  const install =
    options.install === undefined ? ["bun", "install", "--frozen-lockfile"] : options.install;
  const log = options.log ?? ((line: string) => console.log(line));
  if (!Number.isSafeInteger(pull) || pull < 1 || !SHA.test(head) || !SHA.test(main))
    throw new Error("--pull must be a PR number and --head and --main commit SHAs");
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[], ok: number[] = [0]) => {
    const result = spawn(["git", ...args], cwd, env);
    if (!ok.includes(result.exit))
      throw new Error(`git ${args.join(" ")} exited ${result.exit}: ${result.stderr.trim()}`);
    return { exit: result.exit, text: result.stdout.toString(), bytes: result.stdout };
  };
  if (git(["rev-parse", "HEAD"]).text.trim() !== head)
    throw new Error(`The working directory is not checked out at ${head}`);
  // In a partial clone, git merge's checkout can ask the remote for blobs the
  // merge has just written itself, which the remote never had and refuses.
  // Which merges hit it depends on Git's object lookups, so refuse them all.
  const promisor = git(
    ["config", "--get-regexp", String.raw`^(extensions\.partialclone|remote\..*\.promisor)$`],
    [0, 1],
  );
  const partialClone = promisor.text
    .split("\n")
    .some((line) => line.startsWith("extensions.partialclone ") || / (true|yes|on|1)$/i.test(line));
  if (partialClone)
    throw new Error(
      "The checkout is a partial clone: regenerating needs every file's contents, so check out the PR head without a filter",
    );
  git(["cat-file", "-e", `${main}^{commit}`]);
  const base = { version: 1 as const, pull, head, main };

  const merge = git(
    [
      "-c",
      "user.name=Merge batcher",
      "-c",
      "user.email=merge-batcher@users.noreply.github.com",
      "merge",
      "--no-ff",
      "--no-commit",
      main,
    ],
    [0, 1],
  );
  if (merge.exit === 0) {
    log(`Main ${main.slice(0, 10)} merges into #${pull} without a conflict`);
    return { ...base, outcome: "clean" };
  }
  const conflicted = git(["diff", "--name-only", "--diff-filter=U", "-z"])
    .text.split("\0")
    .filter(Boolean);
  if (!conflicted.length) throw new Error("git merge failed without a conflicted file");
  const other = conflicted.filter((path) => !registry.some((entry) => regenerates(entry, path)));
  if (other.length) {
    log(`Files that are not generated conflict: ${other.join(", ")}`);
    return { ...base, outcome: "conflict", conflicted };
  }

  // Take main's version of each conflicted file, as the batcher does on the
  // PR's branch before it merges main; the tree must come out the same.
  for (const path of conflicted) {
    if (git(["cat-file", "-e", `${main}:${path}`], [0, 128]).exit === 0)
      git(["checkout", main, "--", path]);
    else git(["rm", "-q", "--force", "--", path]);
  }
  const mergedTree = git(["write-tree"]).text.trim();

  const entries = registry.filter((entry) => conflicted.some((path) => regenerates(entry, path)));
  const commandEnv = { ...env, OPENGENI_PUBLIC_API_BASE_REF: main };
  const steps = [
    ...(install ? [install] : []),
    ...entries.map((entry) => entry.regenerate.split(" ")),
  ];
  for (const argv of steps) {
    log(`$ ${argv.join(" ")}`);
    const result = spawn(argv, cwd, commandEnv);
    if (result.exit !== 0) {
      const output = `${result.stdout.toString()}${result.stderr}`.trim().slice(-4000);
      throw new Error(`\`${argv.join(" ")}\` exited ${result.exit}:\n${output}`);
    }
  }

  // Everything else the commands touched is ignored: only their artifacts move.
  git(["add", "-A"]);
  const regeneratedTree = git(["write-tree"]).text.trim();
  const artifacts = entries.flatMap((entry) => [...entry.artifacts]);
  const raw = git([
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    mergedTree,
    regeneratedTree,
    "--",
    ...artifacts,
  ])
    .text.split("\0")
    .filter(Boolean);
  const files: RegeneratedFile[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    // ":<old mode> <new mode> <old blob> <new blob> <status>", then the path.
    const fields = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])/.exec(raw[index]!);
    const path = raw[index + 1]!;
    if (!fields) throw new Error(`Unexpected git diff-tree output: ${raw[index]}`);
    const [, mode, blob, status] = fields;
    if (status === "D") {
      files.push({ path, deleted: true });
      continue;
    }
    if (mode !== "100644" && mode !== "100755")
      throw new Error(`Regenerating made ${path} mode ${mode}, not a regular file`);
    files.push({
      path,
      mode,
      content: Buffer.from(git(["cat-file", "blob", blob!]).bytes).toString("base64"),
    });
  }
  log(
    `Merged main ${main.slice(0, 10)} into #${pull} taking main's ${conflicted.join(", ")}; regenerating changed ${files.length ? files.map((f) => f.path).join(", ") : "nothing"}`,
  );
  return {
    ...base,
    outcome: "regenerated",
    conflicted,
    mergedTree,
    commands: entries.map((entry) => entry.regenerate),
    files,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pull: { type: "string" },
      head: { type: "string" },
      main: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.out) throw new Error("--out is required");
  const result = await regenerateMerge({
    cwd: process.cwd(),
    pull: Number(values.pull),
    head: values.head ?? "",
    main: values.main ?? "",
  });
  writeFileSync(values.out, JSON.stringify(result));
}
