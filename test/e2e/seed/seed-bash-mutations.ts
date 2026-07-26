// seed-bash-mutations — every change made via raw bash (sed/echo/rm), NOT via a
// structured file-edit tool. Proves the M1 capture probes the disk at turn end
// rather than reconstructing from tool-call events (acceptance B1): the agent's
// in-box `sed -i` edits emit no fs.changed events, so only a live re-probe sees
// them.
import { runSeed, seedSessionWithBash } from "./harness";

const BASH = String.raw`
set -e
git init -q; git config user.email seed@opengeni.dev; git config user.name seed; git config commit.gpgsign false
printf 'alpha\nbeta\ngamma\ndelta\n' > data.txt
printf 'line one\nline two\nline three\n' > notes.txt
printf 'KEEP=1\nDROP=1\n' > .config
git add -A; git commit -q -m "base"

# Mutate purely through bash — the change source the capture must catch.
sed -i 's/beta/BETA-CHANGED/' data.txt
echo 'epsilon' >> data.txt
printf 'brand new file created by echo\n' > created-by-echo.txt
sed -i '/DROP=1/d' .config
rm notes.txt

echo "bash mutations applied:"; git status --porcelain
`;

await runSeed("bash-mutations", ({ client, workspaceId }) =>
  seedSessionWithBash(client, workspaceId, {
    title: "All changes via bash (sed/echo/rm) — disk-probe proof",
    origin: "workbench-seed-bash-mutations",
    bashScript: BASH,
  }),
);
