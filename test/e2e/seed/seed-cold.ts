// seed-cold — a session with a real changeset whose box is left to drain, so the
// next UI open is a COLD open served from the turn-end snapshot/capture (the
// headline instant-paint case, acceptance A1). The turn produces the fixture and
// then settles; the sandbox box drains on idle a short time later with no viewer
// holding it warm. Open the printed link a minute after running to observe the
// cold path (today: the "Sandbox connection unavailable / Connecting…" states).
import { runSeed, seedSessionWithBash } from "./harness";

const BASH = String.raw`
set -e
git init -q; git config user.email seed@opengeni.dev; git config user.name seed; git config commit.gpgsign false
mkdir -p app
printf 'def greet(name):\n    return f"hi {name}"\n' > app/greet.py
printf 'from app.greet import greet\nprint(greet("cold"))\n' > main.py
printf '# Cold Seed\n\nOpened cold, served from capture.\n' > README.md
git add -A; git commit -q -m "cold base"
# Leave a dirty working tree so the Changes tab has content on cold open.
printf 'def greet(name):\n    # localized greeting\n    return f"hei {name}"\n' > app/greet.py
printf 'notes: scratch\n' > SCRATCH.txt
echo "cold seed changeset:"; git status --porcelain
`;

await runSeed("cold", ({ client, workspaceId }) =>
  seedSessionWithBash(client, workspaceId, {
    title: "Cold-open session (box drains; served from capture)",
    origin: "workbench-seed-cold",
    bashScript: BASH,
  }),
);
