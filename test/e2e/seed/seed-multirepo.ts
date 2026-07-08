// seed-multirepo — two git repos under the workspace root with mixed edits
// (staged, unstaged, untracked, deleted). Exercises per-repo diff discovery
// (detectRepos: find -maxdepth 3 -name .git) and grouped Changes rendering.
import { runSeed, seedSessionWithBash } from "./harness";

const BASH = String.raw`
set -e
mk_repo() {
  local dir="$1"; mkdir -p "$dir"; cd "$dir"
  git init -q; git config user.email seed@opengeni.dev; git config user.name seed; git config commit.gpgsign false
}

# Repo A: an unstaged modification + an untracked file.
mk_repo api
printf 'export function handler() {\n  return 200;\n}\n' > server.ts
printf '# API\n\nService repo.\n' > README.md
git add -A; git commit -q -m "api: base"
printf 'export function handler() {\n  // TODO: auth\n  return 204;\n}\n' > server.ts
printf 'name = "api"\nversion = "0.1.0"\n' > config.toml
cd ..

# Repo B: a staged change + a deleted file.
mk_repo web
printf 'const app = document.getElementById("app");\napp.textContent = "hi";\n' > main.js
printf 'body { margin: 0; }\n.legacy { color: red; }\n' > styles.css
git add -A; git commit -q -m "web: base"
printf 'const app = document.getElementById("app");\napp.textContent = "hello, world";\napp.classList.add("ready");\n' > main.js
git add main.js
git rm -q styles.css
cd ..

echo "multirepo seed ready:"; git -C api status --porcelain; echo "---"; git -C web status --porcelain
`;

await runSeed("multirepo", ({ client, workspaceId }) =>
  seedSessionWithBash(client, workspaceId, {
    title: "Multi-repo workspace (api + web) with mixed edits",
    origin: "workbench-seed-multirepo",
    bashScript: BASH,
  }),
);
