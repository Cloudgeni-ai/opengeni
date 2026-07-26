// seed-empty — a chat-only turn that touches no files. The workspace stays a
// clean git repo with zero changes. Exercises the designed empty Changes state
// and the M1 empty-turn skip (no new capture revision; acceptance B3).
import { runSeed, seedSessionWithBash } from "./harness";

// Initialise a clean repo but make NO working-tree changes. The turn runs bash
// that only reports status, so `git status` is clean at turn end.
const BASH = String.raw`
set -e
git init -q; git config user.email seed@opengeni.dev; git config user.name seed; git config commit.gpgsign false
printf '# Empty seed\n\nNothing has changed here.\n' > README.md
printf 'export const ready = true;\n' > index.ts
git add -A; git commit -q -m "clean base"
echo "empty seed: working tree is clean ->"; git status --porcelain; echo "(no output above means clean)"
`;

await runSeed("empty", ({ client, workspaceId }) =>
  seedSessionWithBash(client, workspaceId, {
    title: "Chat-only / clean working tree (empty Changes state)",
    origin: "workbench-seed-empty",
    bashScript: BASH,
  }),
);
