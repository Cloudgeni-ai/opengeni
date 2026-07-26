// seed-dense — a large tree (>3k files) including a node_modules residue dir
// (listed but never content-descended by capture) plus a ~40-file changeset.
// Stresses Files-tree virtualization and Changes windowing (acceptance D2).
import { runSeed, seedSessionWithBash } from "./harness";

const BASH = String.raw`
set -e
git init -q; git config user.email seed@opengeni.dev; git config user.name seed; git config commit.gpgsign false

# ~3000 source files across a nested tree.
for d in $(seq 1 30); do
  mkdir -p "src/mod$d"
  for f in $(seq 1 100); do
    printf 'export const v_%d_%d = %d;\n' "$d" "$f" "$((d*100+f))" > "src/mod$d/f$f.ts"
  done
done

# node_modules residue: many files the capture lists but must NOT descend into.
for p in $(seq 1 20); do
  mkdir -p "node_modules/pkg$p"
  printf '{"name":"pkg%d","version":"1.0.0"}\n' "$p" > "node_modules/pkg$p/package.json"
  for f in $(seq 1 40); do printf 'module.exports = %d;\n' "$f" > "node_modules/pkg$p/f$f.js"; done
done

printf 'node_modules/\n' > .gitignore
git add -A; git commit -q -m "dense base"

# A ~40-file changeset: modify 40 tracked source files.
for d in $(seq 1 4); do
  for f in $(seq 1 10); do
    printf 'export const v_%d_%d = %d; // touched\n' "$d" "$f" "$((d*100+f+9999))" > "src/mod$d/f$f.ts"
  done
done

echo "dense seed: tracked=$(git ls-files | wc -l) changed=$(git status --porcelain | wc -l) residue=$(find node_modules -type f | wc -l)"
`;

await runSeed("dense", ({ client, workspaceId }) =>
  seedSessionWithBash(client, workspaceId, {
    title: "Dense tree (>3k files + node_modules residue) with a 40-file diff",
    origin: "workbench-seed-dense",
    bashScript: BASH,
    timeoutMs: 300_000,
  }),
);
