import { appendFileSync, readFileSync } from "node:fs";
import { classifyPrWorkflow, fastBudget, type FastObservation } from "./pr-fast-budget";

class IncompleteInventory extends Error {}
class GitHubReadError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`GitHub GET ${status}: ${path}`);
  }
}

type Run = {
  id: number;
  path: string;
  event: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion?: string | null;
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
  return (
    paths.length > 0 &&
    paths.every((p) => /^(?:docs\/(?!merge-batcher-admin\/).+\.mdx?|[^/]+\.md)$/.test(p))
  );
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
  timing = { now: Date.now, sleep: (ms: number) => Bun.sleep(ms) },
) {
  const repo = env.GITHUB_REPOSITORY,
    token = env.GITHUB_TOKEN;
  if (!repo || !token) throw Error("Repository and GitHub token required");
  const admissionStartedAt = timing.now();
  const deadline = admissionStartedAt + (action === "admit-fast" ? 110 : 300) * 60 * 1000;
  const prPriorityYieldDeadline = admissionStartedAt + 15 * 60 * 1000;
  let readAfter = 0;
  async function api(path: string, method = "GET", body?: unknown): Promise<any> {
    for (;;) {
      if (method === "GET" && readAfter > timing.now()) {
        if (readAfter >= deadline) throw Error("Provider rate budget exceeds admission deadline");
        await timing.sleep(readAfter - timing.now());
      }
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
      const remaining = r.headers.get("x-ratelimit-remaining"),
        reset = Number(r.headers.get("x-ratelimit-reset")) * 1000;
      const retry = Number(r.headers.get("retry-after")) * 1000;
      if (
        remaining !== null &&
        Number(remaining) <= 25 &&
        Number.isFinite(reset) &&
        reset > timing.now()
      )
        readAfter = reset + 1000;
      if (
        method === "GET" &&
        (r.status === 429 || (r.status === 403 && (remaining === "0" || retry > 0)))
      ) {
        readAfter = Math.max(
          readAfter,
          timing.now() + Math.max(60000, Number.isFinite(retry) ? retry : 0),
        );
        continue; // authenticated reads only; never replay a mutation
      }
      if (!r.ok) {
        if (method === "GET") throw new GitHubReadError(r.status, path);
        throw Error(`GitHub ${method} ${r.status}`);
      }
      return r.status === 204 ? null : r.json();
    }
  }
  async function activeRuns(workflow: string, filter = ""): Promise<Run[]> {
    const all: Run[] = [];
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"])
      all.push(
        ...(await pages(
          `actions/workflows/${workflow}/runs?status=${status}${filter}`,
          "workflow_runs",
        )),
      );
    return [...new Map(all.map((r) => [r.id, r])).values()];
  }
  async function pages(path: string, key?: string): Promise<any[]> {
    const all: any[] = [];
    for (let p = 1; p <= 100; p++) {
      const data = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${p}`);
      const rows = key ? data[key] : data;
      if (!Array.isArray(rows)) throw Error("Malformed provider page");
      if (key === "workflow_runs" && Number(data.total_count) > 1000)
        throw Error("Filtered provider run inventory exceeds search bound");
      all.push(...rows);
      if (rows.length < 100) {
        if (key && Number(data.total_count) > all.length)
          throw new IncompleteInventory(
            `Incomplete provider inventory: ${path} page=${p} reported=${data.total_count} observed=${all.length}`,
          );
        return all;
      }
    }
    throw Error("Incomplete provider pagination");
  }
  const output = (name: string, value: string) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  };
  if (action === "admit-fast") {
    const ownRun = Number(env.GITHUB_RUN_ID);
    if (!Number.isSafeInteger(ownRun) || ownRun <= 0) throw Error("Run identity required");
    const definitions = new Map<string, ReturnType<typeof classifyPrWorkflow>>();
    while (timing.now() < deadline) {
      try {
        const observationStartedAt = timing.now();
        const all = new Map<number, Run>();
        for (const status of ["queued", "in_progress", "waiting", "pending", "requested"])
          for (const run of await pages(`actions/runs?status=${status}`, "workflow_runs"))
            all.set(run.id, run);
        if (all.size > 256) throw new IncompleteInventory("Active run inventory exceeds256");
        const observations: FastObservation[] = [];
        for (const run of all.values()) {
          if (run.id === ownRun || run.status === "completed") continue;
          if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt))
            throw new IncompleteInventory("Invalid run identity");
          const path = run.path.split("@")[0];
          let kind: FastObservation["kind"] = "other";
          if (path === ".github/workflows/pr-ci.yml") {
            if (!/^[a-f0-9]{40}$/.test(run.head_sha))
              throw new IncompleteInventory("Invalid PR source identity");
            if (!definitions.has(run.head_sha)) {
              let source;
              try {
                source = await api(`contents/.github/workflows/pr-ci.yml?ref=${run.head_sha}`);
              } catch (error) {
                if (!(error instanceof GitHubReadError) || error.status !== 404) throw error;
                const current = await api(`actions/runs/${run.id}`);
                if (current.id === run.id && current.status === "completed") continue;
                throw new IncompleteInventory(
                  `Workflow source unavailable for active run ${run.id} head ${run.head_sha}; ${error.message}`,
                );
              }
              if (source.encoding !== "base64" || source.size > 100000)
                throw new IncompleteInventory("Unbounded workflow source");
              definitions.set(
                run.head_sha,
                classifyPrWorkflow(
                  Bun.YAML.parse(Buffer.from(source.content, "base64").toString("utf8")),
                ),
              );
            }
            const classified = definitions.get(run.head_sha);
            if (!classified)
              throw new IncompleteInventory(`Unknown PR workflow budget for run ${run.id}`);
            kind = classified;
          } else if (
            path === ".github/workflows/ci.yml" &&
            run.event === "push" &&
            run.head_branch === "main"
          )
            kind = "main";
          else if (path === ".github/workflows/batch-ci.yml") kind = "batch";
          observations.push({
            id: run.id,
            kind,
            jobs: await pages(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs"),
            ...(kind === "legacy-pr" ? { legacyGroup: "pr-ci-fanout" } : {}),
          });
        }
        if (timing.now() - observationStartedAt > 60000)
          throw new IncompleteInventory("Runner observation exceeded60seconds");
        const decision = fastBudget(observations, ownRun);
        console.log(decision.reason);
        if (decision.allowed) return;
      } catch (error) {
        if (!(error instanceof IncompleteInventory)) throw error;
        console.log(`${error.message}; admission remains held`);
      }
      await timing.sleep(60000);
    }
    throw Error("Fast admission budget did not clear before deadline");
  }
  if (action === "priority") {
    const lane = laneArgument;
    if (lane !== "pr" && lane !== "batch") throw Error("Invalid priority lane");
    while (timing.now() < deadline) {
      const raw: Run[] = [];
      try {
        raw.push(...(await activeRuns("ci.yml", "&branch=main&event=push")));
        if (lane === "pr") raw.push(...(await activeRuns("batch-ci.yml", "&event=push")));
      } catch (error) {
        if (!(error instanceof IncompleteInventory)) throw error;
        // Status-filtered inventories can change while GitHub computes a page.
        // Missing demand never grants admission: discard the partial snapshot
        // and rescan at the normal bounded, rate-aware read cadence.
        console.log(`${error.message}; priority remains held`);
        await timing.sleep(300000);
        continue;
      }
      const unique = [...new Map(raw.map((r) => [r.id, r])).values()].filter(
        (r) =>
          r.id !== Number(env.GITHUB_RUN_ID) &&
          ((r.path.split("@")[0] === ".github/workflows/ci.yml" &&
            r.event === "push" &&
            r.head_branch === "main") ||
            (lane === "pr" &&
              r.path.split("@")[0] === ".github/workflows/batch-ci.yml" &&
              r.event === "push" &&
              r.head_branch.startsWith("queue/"))),
      );
      const observations = [];
      for (const run of unique)
        observations.push({
          run,
          // Known queued/running demand needs no per-job inventory. Only waiting
          // runs can be cleared by proving every remaining job waits on approval.
          jobs:
            run.status === "waiting"
              ? await pages(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs")
              : [],
        });
      const hold = priorityHold(lane, observations, Number(env.GITHUB_RUN_ID));
      if (!hold) {
        console.log("Higher-priority observed demand clear; repository admission granted");
        return;
      }
      // Retained for older callers; current PR CI uses admit-fast. Main priority is a
      // bounded courtesy, not a provider scheduling guarantee: continuous main
      // pushes must not starve the PRs that repair main. Only a complete known
      // inventory reaches this branch; unknown demand still holds above.
      if (lane === "pr" && timing.now() >= prPriorityYieldDeadline) {
        console.log("PR priority yield reached 15 minutes; admitting the bounded legacy fanout");
        return;
      }
      console.log(hold);
      await timing.sleep(300000);
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
    const runs = await activeRuns("pr-ci.yml", `&branch=${encodeURIComponent(p.head.ref)}`);
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
    const runs = await activeRuns("pr-ci.yml", `&branch=${encodeURIComponent(p.head.ref)}`);
    const validations = await activeRuns(
      "ci.yml",
      `&event=workflow_dispatch&branch=${encodeURIComponent(p.head.ref)}`,
    );
    const exact: Run[] = await pages(
      `actions/workflows/pr-ci.yml/runs?head_sha=${head}&event=workflow_dispatch`,
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
    if (
      !exact.some(
        (r) =>
          r.event === "workflow_dispatch" &&
          r.head_sha === head &&
          (r.status !== "completed" || r.conclusion === "success"),
      )
    )
      await api("actions/workflows/pr-ci.yml/dispatches", "POST", {
        ref: p.head.ref,
        inputs: { pr_number: String(number), head_sha: head },
      });
    if ((await api(`pulls/${number}`)).head.sha !== head)
      throw Error("Version head changed before readiness label");
    await api(`issues/${number}/labels`, "POST", { labels: ["queue-ready"] });
    return;
  }
  throw Error("Unknown PR CI command");
}
if (import.meta.main) await runPrCiCommand();
