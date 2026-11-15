import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function git(args: string[], cwd?: string): string {
  const r = Bun.spawnSync(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0)
    throw new Error(
      `git ${args.slice(0, 3).join(" ")} failed: ${r.stderr.toString().slice(0, 400)}`,
    );
  return r.stdout.toString();
}

/**
 * Repository checkouts at task commits. One blobless mirror per repository; each commit gets its
 * own detached worktree, removed by `release` once that commit's tasks are done.
 */
export class RepoCache {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private mirror(repo: string, url: string): string {
    const path = join(this.dir, "mirrors", repo.replace("/", "__"));
    if (!existsSync(path))
      git([
        "clone",
        "--quiet",
        "--filter=blob:none",
        "--no-checkout",
        url,
        path,
      ]);
    return path;
  }

  checkout(repo: string, url: string, commit: string): string {
    const mirror = this.mirror(repo, url);
    const path = join(
      this.dir,
      "checkouts",
      `${repo.replace("/", "__")}@${commit.slice(0, 12)}`,
    );
    if (existsSync(path)) return path;
    try {
      git(["cat-file", "-e", `${commit}^{commit}`], mirror);
    } catch {
      git(["fetch", "--quiet", "--filter=blob:none", "origin", commit], mirror);
    }
    git(["worktree", "add", "--quiet", "--detach", path, commit], mirror);
    return path;
  }

  release(repo: string, url: string, commit: string): void {
    const mirror = this.mirror(repo, url);
    const path = join(
      this.dir,
      "checkouts",
      `${repo.replace("/", "__")}@${commit.slice(0, 12)}`,
    );
    if (existsSync(path)) git(["worktree", "remove", "--force", path], mirror);
  }
}
