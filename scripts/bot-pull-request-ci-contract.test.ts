import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Pushes and pull requests made with the workflow's GITHUB_TOKEN start no
// pull_request workflows, so a PR such a workflow opens never gets PR CI and
// the merge batcher can never land it. Every workflow that opens one must
// dispatch PR CI on the exact head it pushed, and must not replace that head
// when nothing changed (a force push throws away a running merge batch).
const workflowDir = resolve(import.meta.dir, "../.github/workflows");

type Env = Record<string, string>;
type Step = { name?: string; uses?: string; run?: string; env?: Env };
type Job = { permissions?: Record<string, string>; env?: Env; steps?: Step[] };
type Workflow = { permissions?: Record<string, string>; env?: Env; jobs?: Record<string, Job> };

async function workflows(): Promise<[string, Workflow][]> {
  const files = (await readdir(workflowDir)).filter((file) => /\.ya?ml$/.test(file)).sort();
  return Promise.all(
    files.map(
      async (file) =>
        [file, Bun.YAML.parse(await readFile(resolve(workflowDir, file), "utf8")) as Workflow] as [
          string,
          Workflow,
        ],
    ),
  );
}

const WORKFLOW_TOKEN = /\$\{\{\s*(github\.token|secrets\.GITHUB_TOKEN)\s*\}\}/;

// gh reads GH_TOKEN (or GITHUB_TOKEN) from the environment at any level.
function ghUsesWorkflowToken(workflow: Workflow, job: Job, step: Step): boolean {
  const env = { ...workflow.env, ...job.env, ...step.env };
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  return token !== undefined && WORKFLOW_TOKEN.test(String(token));
}

const DISPATCH =
  'gh workflow run pr-ci.yml --ref "$branch" -f pr_number="$number" -f head_sha="$head_sha"';
const CAPTURE = 'head_sha="$(git rev-parse HEAD)"';

// PR CI is dispatched after the last push, on the head captured after that push.
function dispatchesPrCi(step: Step): boolean {
  const run = step.run ?? "";
  const dispatch = run.lastIndexOf(DISPATCH);
  const push = run.lastIndexOf("git push");
  const capture = run.indexOf(CAPTURE, push);
  return dispatch >= 0 && push >= 0 && capture > push && dispatch > capture;
}

async function prOpeners() {
  const openers: { id: string; workflow: Workflow; job: Job; step: Step }[] = [];
  for (const [file, workflow] of await workflows()) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!/\bgh pr create\b/.test(step.run ?? "")) continue;
        if (!ghUsesWorkflowToken(workflow, job, step)) continue;
        openers.push({ id: `${file}:${jobName}`, workflow, job, step });
      }
    }
  }
  return openers;
}

describe("pull requests opened with GITHUB_TOKEN", () => {
  test("every workflow that opens one dispatches PR CI on the exact pushed head", async () => {
    const openers = await prOpeners();
    for (const { id, workflow, job, step } of openers) {
      expect(dispatchesPrCi(step), id).toBe(true);
      const permissions = job.permissions ?? workflow.permissions ?? {};
      expect(permissions.actions, id).toBe("write");
      // Reads PR CI check runs to decide whether a kept head needs a run.
      if (/check-runs/.test(step.run ?? "")) expect(permissions.checks, id).toBe("read");
    }
    expect(openers.map(({ id }) => id)).toEqual([
      "browser-engine-pins.yml:update",
      "xai-client-version-pin.yml:update",
    ]);
  });

  test("the token check sees the workflow token at every env level", () => {
    const step = { run: "gh pr create" };
    const token = { GH_TOKEN: "${{ github.token }}" };
    expect(ghUsesWorkflowToken({ env: token }, {}, step)).toBe(true);
    expect(
      ghUsesWorkflowToken({}, { env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" } }, step),
    ).toBe(true);
    expect(
      ghUsesWorkflowToken(
        { env: token },
        {},
        { ...step, env: { GH_TOKEN: "${{ steps.app.outputs.token }}" } },
      ),
    ).toBe(false);
  });

  test("the dispatch check rejects a dispatch that is not on the head captured after the last push", () => {
    const run = [
      'git push --force origin "$branch"',
      CAPTURE,
      'gh pr create --base main --head "$branch"',
      'number="$(gh pr view "$branch" --json number --jq .number)"',
      DISPATCH,
    ].join("\n");
    expect(dispatchesPrCi({ run })).toBe(true);
    expect(dispatchesPrCi({ run: run.split("\n").slice(0, 3).join("\n") })).toBe(false);
    expect(dispatchesPrCi({ run: `${run}\ngit push origin other` })).toBe(false);
    expect(
      dispatchesPrCi({
        run: [CAPTURE, ...run.split("\n").filter((line) => line !== CAPTURE)].join("\n"),
      }),
    ).toBe(false);
  });
});

// Runs each workflow's real step script against a local remote, with gh and
// bun replaced by stubs that record their calls.
const STUB_GH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/gh.log"
case "$1 $2" in
  "pr view") echo 42 ;;
  "pr create") printf 'OPEN ' > "$STUB_DIR/pr_state" ;;
  "api "*pulls*)
    [ -f "$STUB_DIR/lookup_fails" ] && exit 1
    cat "$STUB_DIR/pr_state" 2>/dev/null || echo ;;
  "api "*check-runs*) cat "$STUB_DIR/checks" 2>/dev/null || printf '0\\t0\\t0\\n' ;;
esac
`;
const STUB_BUN = `#!/usr/bin/env bash
echo "Grok client version: 1.0.0"
`;

const PIN_WORKFLOWS = {
  "browser-engine-pins.yml": {
    branch: "chore/browser-engine-pins-auto",
    file: "docker/desktop.Dockerfile",
  },
  "xai-client-version-pin.yml": {
    branch: "chore/xai-client-version-auto",
    file: "packages/xai-subscription/src/constants.ts",
  },
} as const;
const SEEDED = [
  "docker/desktop.Dockerfile",
  "docker/sandbox.Dockerfile",
  "packages/xai-subscription/src/constants.ts",
  ".changeset/README.md",
];

async function sh(cwd: string, script: string, env: Env = {}) {
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr, code };
}

async function stepScript(file: keyof typeof PIN_WORKFLOWS) {
  const workflow = Bun.YAML.parse(await readFile(resolve(workflowDir, file), "utf8")) as Workflow;
  const step = workflow.jobs?.update?.steps?.find(
    (candidate) => candidate.name === "Open or update the pull request",
  );
  if (!step?.run) throw new Error(`${file} has no pull request step`);
  return step.run;
}

describe.each(Object.keys(PIN_WORKFLOWS) as (keyof typeof PIN_WORKFLOWS)[])(
  "%s refresh",
  (file) => {
    const { branch, file: pin } = PIN_WORKFLOWS[file];
    const identity = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };

    async function fixture() {
      const root = await mkdtemp(join(tmpdir(), "bot-pr-refresh-"));
      const stub = join(root, "stub");
      const bin = join(root, "bin");
      await mkdir(stub);
      await mkdir(bin);
      await writeFile(join(bin, "gh"), STUB_GH);
      await writeFile(join(bin, "bun"), STUB_BUN);
      await chmod(join(bin, "gh"), 0o755);
      await chmod(join(bin, "bun"), 0o755);
      await writeFile(join(bin, "sleep"), "#!/usr/bin/env bash\n");
      await chmod(join(bin, "sleep"), 0o755);
      const seed = join(root, "seed");
      for (const path of SEEDED) {
        await mkdir(dirname(join(seed, path)), { recursive: true });
        await writeFile(join(seed, path), "pin=1\n");
      }
      const setup = await sh(
        root,
        "git init -q -b main seed && git -C seed add -A && git -C seed commit -qm seed && git clone -q --bare seed remote.git",
        identity,
      );
      expect(setup.code, setup.stderr).toBe(0);
      const env = {
        ...identity,
        STUB_DIR: stub,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_REPOSITORY_OWNER: "o",
        PATH: `${bin}:${process.env.PATH}`,
      };

      // One scheduled run: a fresh shallow checkout of main with the given pin edits.
      async function refresh(edits: Record<string, string>, exitCode = 0) {
        await rm(join(root, "work"), { recursive: true, force: true });
        const clone = await sh(
          root,
          `git clone -q --depth 1 --branch main file://${join(root, "remote.git")} work`,
          env,
        );
        expect(clone.code, clone.stderr).toBe(0);
        for (const [path, content] of Object.entries(edits))
          await writeFile(join(root, "work", path), content);
        await rm(join(stub, "gh.log"), { force: true });
        const result = await sh(join(root, "work"), await stepScript(file), env);
        expect(result.code, result.stderr).toBe(exitCode);
        const log = await readFile(join(stub, "gh.log"), "utf8").catch(() => "");
        const head = await sh(
          root,
          `git --git-dir remote.git rev-parse --verify -q refs/heads/${branch}`,
        );
        return { log, head: head.stdout };
      }
      const setPr = (state: string) => writeFile(join(stub, "pr_state"), state);
      // PR CI check runs on the kept head: all of them, those still running, those that passed.
      const setChecks = (runs: number, active = 0, passed = 0) =>
        writeFile(join(stub, "checks"), `${runs}\t${active}\t${passed}\n`);
      const failLookup = () => writeFile(join(stub, "lookup_fails"), "");
      return { root, refresh, setPr, setChecks, failLookup };
    }

    test("opens the pull request and dispatches PR CI on the pushed head", async () => {
      const { root, refresh } = await fixture();
      try {
        const run = await refresh({ [pin]: "pin=2\n" });
        expect(run.head).not.toBe("");
        expect(run.log).toContain("pr create");
        expect(run.log).toContain(`head_sha=${run.head}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("keeps the head when the open pull request already carries the pins", async () => {
      const { root, refresh, setChecks, setPr } = await fixture();
      try {
        const first = await refresh({ [pin]: "pin=2\n" });
        await setPr("OPEN queue-ready,in-batch");
        await setChecks(1, 0, 1);
        const unchanged = await refresh({ [pin]: "pin=2\n" });
        expect(unchanged.head).toBe(first.head);
        expect(unchanged.log).not.toContain("workflow run");
        expect(unchanged.log).not.toContain("pr edit");

        // Without a PR CI run on that head, dispatch one there instead of pushing.
        await setPr("OPEN ");
        await setChecks(0);
        const dispatched = await refresh({ [pin]: "pin=2\n" });
        expect(dispatched.head).toBe(first.head);
        expect(dispatched.log).toContain(`head_sha=${first.head}`);

        // A running PR CI is left alone; a failed one is re-run, up to three runs.
        await setChecks(1, 1, 0);
        expect((await refresh({ [pin]: "pin=2\n" })).log).not.toContain("workflow run");
        await setChecks(2, 0, 0);
        const rerun = await refresh({ [pin]: "pin=2\n" });
        expect(rerun.head).toBe(first.head);
        expect(rerun.log).toContain(`head_sha=${first.head}`);
        await setChecks(3, 0, 0);
        expect((await refresh({ [pin]: "pin=2\n" })).log).not.toContain("workflow run");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("pushes new pins, except while the pull request is in a merge batch", async () => {
      const { root, refresh, setChecks, setPr } = await fixture();
      try {
        const first = await refresh({ [pin]: "pin=2\n" });
        await setChecks(1, 0, 1);
        await setPr("OPEN queue-ready,in-batch");
        const held = await refresh({ [pin]: "pin=3\n" });
        expect(held.head).toBe(first.head);
        expect(held.log).not.toContain("workflow run");

        await setPr("OPEN queue-ready");
        const moved = await refresh({ [pin]: "pin=3\n" });
        expect(moved.head).not.toBe(first.head);
        expect(moved.log).toContain("pr edit");
        expect(moved.log).toContain(`head_sha=${moved.head}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("fails without pushing when the pull request state cannot be read", async () => {
      const { root, refresh, setPr, failLookup } = await fixture();
      try {
        const first = await refresh({ [pin]: "pin=2\n" });
        await setPr("OPEN queue-ready,in-batch");
        await failLookup();
        const failed = await refresh({ [pin]: "pin=3\n" }, 1);
        expect(failed.head).toBe(first.head);
        expect(failed.log).not.toContain("workflow run");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    // Only the browser engine refresh commits more than one pin file.
    test.if(file === "browser-engine-pins.yml")(
      "pushes when the open pull request changes files this refresh no longer changes",
      async () => {
        const { root, refresh, setChecks, setPr } = await fixture();
        try {
          const first = await refresh({ [pin]: "pin=2\n", "docker/sandbox.Dockerfile": "pin=2\n" });
          await setPr("OPEN ");
          await setChecks(1, 0, 1);
          const narrowed = await refresh({ [pin]: "pin=2\n" });
          expect(narrowed.head).not.toBe(first.head);
          expect(narrowed.log).toContain(`head_sha=${narrowed.head}`);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  },
);
