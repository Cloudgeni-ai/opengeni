import { appendFileSync, readFileSync } from "node:fs";

type Run = {
  id: number;
  path: string;
  event: string;
  head_branch: string;
  head_sha: string;
  status: string;
  pull_requests?: { number: number }[];
  run_attempt: number;
  display_title?: string;
};
type Job = { status: string; conclusion: string | null; name: string };
export function supersededPrRuns(
  runs: Run[],
  number: number,
  head: string,
  branch: string,
): number[] {
  return runs
    .filter(
      (r) =>
        Number.isSafeInteger(r.id) &&
        r.id > 0 &&
        /^[a-f0-9]{40}$/.test(r.head_sha) &&
        r.path.split("@")[0] === ".github/workflows/pr-ci.yml" &&
        r.status !== "completed" &&
        r.head_sha !== head &&
        ((r.event === "pull_request" && r.pull_requests?.some((p) => p.number === number)) ||
          (r.event === "workflow_dispatch" &&
            r.head_branch === branch &&
            branch === "changeset-release/main")),
    )
    .map((r) => r.id);
}
export function priorityHold(
  lane: "pr" | "batch",
  runs: { run: Run; jobs: Job[] }[],
  ownRun: number,
): string | null {
  for (const { run, jobs } of runs) {
    if (run.id === ownRun || run.status === "completed") continue;
    const path = run.path.split("@")[0];
    const main =
      path === ".github/workflows/ci.yml" && run.event === "push" && run.head_branch === "main";
    const batch =
      path === ".github/workflows/batch-ci.yml" &&
      run.event === "push" &&
      run.head_branch.startsWith("queue/");
    if (!main && !(lane === "pr" && batch)) continue;
    // Completed testing plus only environment-approval waits is not runner demand.
    // An empty/pre-fanout or unknown job observation is not proof of spare capacity.
    if (!jobs.length || jobs.some((j) => !["completed", "waiting"].includes(j.status)))
      return `${main ? "main" : "batch"} run ${run.id} has priority`;
  }
  return null;
}
export function docsOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => p.startsWith("docs/") || /^[^/]+\.md$/.test(p));
}
export function supersededVersionValidationRuns(
  runs: Run[],
  number: number,
  head: string,
): number[] {
  return runs
    .filter((r) => {
      if (
        r.path.split("@")[0] !== ".github/workflows/ci.yml" ||
        r.event !== "workflow_dispatch" ||
        r.status === "completed" ||
        !Number.isSafeInteger(r.id) ||
        r.id <= 0
      )
        return false;
      const match = r.display_title?.match(/^Version PR ([1-9][0-9]*) head ([a-f0-9]{40})$/);
      return match && Number(match[1]) === number && match[2] !== head;
    })
    .map((r) => r.id);
}

export async function runPrCiCommand(
  action = process.argv[2],
  env: Record<string, string | undefined> = process.env,
  transport: typeof fetch = fetch,
  laneArgument = process.argv[3],
) {
  const repo = env.GITHUB_REPOSITORY,
    token = env.GITHUB_TOKEN;
  if (!repo || !token) throw Error("Repository and GitHub token required");
  async function api(path: string, method = "GET", body?: unknown): Promise<any> {
    const r = await transport(`https://api.github.com/repos/${repo}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw Error(`GitHub ${method} ${r.status}`);
    return r.status === 204 ? null : r.json();
  }
  async function pages(path: string, key?: string): Promise<any[]> {
    const all: any[] = [];
    for (let p = 1; p <= 100; p++) {
      const data = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${p}`);
      const rows = key ? data[key] : data;
      if (!Array.isArray(rows)) throw Error("Malformed provider page");
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw Error("Incomplete provider pagination");
  }
  const output = (name: string, value: string) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  };
  if (action === "priority") {
    const lane = laneArgument;
    if (lane !== "pr" && lane !== "batch") throw Error("Invalid priority lane");
    const deadline = Date.now() + 5 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      const raw: Run[] = [];
      for (const status of ["queued", "in_progress", "waiting", "pending", "requested"])
        raw.push(...(await pages(`actions/runs?status=${status}`, "workflow_runs")));
      const unique = [...new Map(raw.map((r) => [r.id, r])).values()].filter((r) =>
        [".github/workflows/ci.yml", ".github/workflows/batch-ci.yml"].includes(
          r.path.split("@")[0]!,
        ),
      );
      const observations = [];
      for (const run of unique)
        observations.push({
          run,
          jobs: await pages(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs"),
        });
      const hold = priorityHold(lane, observations, Number(env.GITHUB_RUN_ID));
      if (!hold) {
        console.log("Higher-priority observed demand clear; repository admission granted");
        return;
      }
      console.log(hold);
      await Bun.sleep(30000);
    }
    throw Error("Higher-priority demand did not clear within admission deadline");
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, "utf8"));
  if (action === "superseded") {
    if (env.GITHUB_EVENT_NAME !== "pull_request_target" || event.action !== "synchronize")
      throw Error("Only a new PR push may cancel superseded runs");
    const p = event.pull_request,
      live = await api(`pulls/${p.number}`);
    if (live.head.sha !== p.head.sha) throw Error("Supersession event is stale");
    const runs = await pages("actions/workflows/pr-ci.yml/runs", "workflow_runs");
    for (const id of supersededPrRuns(runs, p.number, p.head.sha, p.head.ref)) {
      if ((await api(`pulls/${p.number}`)).head.sha !== p.head.sha)
        throw Error("Head changed before cancellation");
      await api(`actions/runs/${id}/cancel`, "POST");
    }
    return;
  }
  if (action === "identity") {
    const number = Number(event.pull_request?.number ?? event.inputs?.pr_number),
      head = event.pull_request?.head.sha ?? event.inputs?.head_sha;
    const p = await api(`pulls/${number}`);
    if (p.state !== "open" || p.head.sha !== head || p.base.ref !== "main")
      throw Error("PR CI exact-head identity changed");
    if (
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      (p.head.ref !== "changeset-release/main" || env.GITHUB_SHA !== head)
    )
      throw Error("Version dispatch must run its exact head");
    const files = await pages(`pulls/${number}/files`);
    output("head", head);
    output("base", p.base.sha);
    output(
      "docs_only",
      String(
        files.length === p.changed_files &&
          docsOnly(
            files.flatMap((f) => [
              f.filename,
              ...(f.previous_filename ? [f.previous_filename] : []),
            ]),
          ),
      ),
    );
    return;
  }
  if (action === "queue-version") {
    const number = Number(env.VERSION_PR_NUMBER),
      head = env.VERSION_HEAD_SHA;
    const p = await api(`pulls/${number}`);
    if (
      p.state !== "open" ||
      p.head.sha !== head ||
      p.head.ref !== "changeset-release/main" ||
      p.head.repo?.full_name !== repo ||
      p.user?.login !== "github-actions[bot]"
    )
      throw Error("Version identity changed");
    await api(`issues/${number}/labels`, "POST", { labels: ["queue-ready"] });
    const runs: Run[] = await pages("actions/workflows/pr-ci.yml/runs", "workflow_runs");
    const validations: Run[] = await pages(
      "actions/workflows/ci.yml/runs?event=workflow_dispatch",
      "workflow_runs",
    );
    for (const id of [
      ...supersededPrRuns(runs, number, head!, p.head.ref),
      ...supersededVersionValidationRuns(validations, number, head!),
    ]) {
      if ((await api(`pulls/${number}`)).head.sha !== head)
        throw Error("Version head changed before cancellation");
      await api(`actions/runs/${id}/cancel`, "POST");
    }
    // GITHUB_TOKEN label/push events do not recursively start CI. Explicit dispatch
    // does, with ref pinned again by the identity job and admission at exact SHA.
    if (!runs.some((r) => r.event === "workflow_dispatch" && r.head_sha === head))
      await api("actions/workflows/pr-ci.yml/dispatches", "POST", {
        ref: p.head.ref,
        inputs: { pr_number: String(number), head_sha: head },
      });
    return;
  }
  throw Error("Unknown PR CI command");
}
if (import.meta.main) await runPrCiCommand();
