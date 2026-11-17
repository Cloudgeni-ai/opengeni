#!/usr/bin/env bun
/**
 * Arms (a) and (d): the unchanged Opengeni agent finds the code for each task, as a real session on
 * a running Opengeni deployment. Per task: a snapshot of the repository at the task commit (no git
 * history, so the fix cannot be read from later commits), a disposable container enrolled as a
 * Connected Machine, a fresh workspace with learning, code search, delegation and human input off,
 * and one unattended session. The final answer's `path:start-end` lines are the prediction; what
 * the agent viewed is recorded as a second, diagnostic arm (`<arm>-viewed`).
 *
 *   bun scripts/code-search-eval/agent-run.ts --contextbench full.jsonl --split test --per-language 50 \
 *     --arm agent --model codex/gpt-6.1-sol --effort medium --api http://127.0.0.1:18400 \
 *     --account <account id> --agent-binary <opengeni-agent> --repo-cache DIR --out DIR
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  contextBenchTask,
  readJsonl,
  splitByRepo,
  stratifiedSample,
  type ContextBenchRow,
} from "./harness/datasets";
import {
  ATTEMPT_SETTINGS,
  OpengeniApi,
  TERMINAL_TURN,
  finalAnswer,
  findCodeInstruction,
  networkCommands,
  sessionBusy,
  usageFromEvents,
  type SessionSnapshot,
} from "./harness/opengeni-session";
import { RepoCache } from "./harness/repos";
import {
  codeGrepStats,
  localizeTrajectory,
  predictionFromAnswer,
  type AgentEvent,
} from "./harness/trajectory";
import type { ArmRun, Task } from "./harness/types";

const { values } = parseArgs({
  options: {
    contextbench: { type: "string" },
    split: { type: "string", default: "test" },
    "per-language": { type: "string" },
    limit: { type: "string" },
    arm: { type: "string", default: "agent" },
    model: { type: "string", default: "codex/gpt-6.1-sol" },
    effort: { type: "string", default: "medium" },
    api: { type: "string", default: "http://127.0.0.1:18400" },
    account: { type: "string" },
    "agent-binary": { type: "string" },
    image: { type: "string", default: "ubuntu:24.04" },
    "repo-cache": { type: "string", default: ".code-search-eval-repos" },
    out: { type: "string", default: "code-search-eval-agent" },
    concurrency: { type: "string", default: "4" },
    "timeout-sec": { type: "string", default: "1200" },
    smoke: { type: "boolean", default: false },
    /** Enable the deployment's code-search tool in each attempt workspace (the tool arms). */
    "code-search": { type: "boolean", default: false },
    /** A file of task ids, one per line: run only these (a paired subset shared by every arm). */
    "task-ids": { type: "string" },
  },
});

const sh = (cmd: string[], opts: { cwd?: string; check?: boolean } = {}) => {
  const r = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString();
  if (opts.check !== false && r.exitCode !== 0)
    throw new Error(
      `${cmd.slice(0, 3).join(" ")} failed (${r.exitCode}): ${r.stderr.toString().slice(0, 400)}`,
    );
  return { code: r.exitCode, out, err: r.stderr.toString() };
};

const api = new OpengeniApi(values.api!.replace(/\/$/, ""));
const out = resolve(values.out!);
mkdirSync(join(out, "events"), { recursive: true });
const runsPath = join(out, "runs.jsonl");
const detailPath = join(out, "attempts.jsonl");
const binary = resolve(values["agent-binary"] ?? "");
const timeoutMs = Number(values["timeout-sec"]) * 1000;

/** A git repository holding only the files at the task commit (no history, no remote). */
function snapshot(repoDir: string): string {
  const dir = mkdtempSync(join(out, "snap-"));
  const app = join(dir, "app");
  mkdirSync(app);
  const tar = Bun.spawnSync(
    ["git", "-C", repoDir, "archive", "--format=tar", "HEAD"],
    { stdout: "pipe" },
  );
  if (tar.exitCode !== 0) throw new Error("git archive failed");
  Bun.spawnSync(["tar", "-x", "-C", app], { stdin: tar.stdout });
  sh(["git", "init", "-q"], { cwd: app });
  sh(["git", "add", "-A"], { cwd: app });
  sh(
    [
      "git",
      "-c",
      "user.name=snapshot",
      "-c",
      "user.email=snapshot@localhost",
      "commit",
      "-qm",
      "snapshot",
      "--no-gpg-sign",
    ],
    { cwd: app },
  );
  return dir;
}

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  ms: number,
  every = 3000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(every);
  }
}

async function attempt(task: Task, repos: RepoCache) {
  const tag = createHash("sha1")
    .update(`${values.arm}:${task.id}`)
    .digest("hex")
    .slice(0, 10);
  const name = `cse-${tag}`;
  const record: Record<string, unknown> = {
    taskId: task.id,
    arm: values.arm,
    container: name,
  };
  let snap: string | null = null;
  let workspace: string | null = null;
  let session: string | null = null;
  let enrollment: string | null = null;
  const t0 = performance.now();
  record.startedAt = new Date().toISOString();
  try {
    const repoDir = repos.checkout(task.repo, task.repoUrl, task.commit);
    snap = snapshot(repoDir);
    const ws = (await api.call("POST", "/v1/workspaces", {
      accountId: values.account,
      name,
    })) as { id: string };
    workspace = ws.id;
    await api.call(
      "PATCH",
      `/v1/workspaces/${workspace}/settings`,
      { ...ATTEMPT_SETTINGS, codeSearchEnabled: values["code-search"] === true },
    );
    sh(["docker", "rm", "-f", name], { check: false });
    sh([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--network",
      "host",
      "--cpus",
      "2",
      "--memory",
      "4g",
      "-v",
      `${join(snap, "app")}:/app`,
      "-v",
      `${dirname(binary)}:/opt/og:ro`,
      "-w",
      "/app",
      "--label",
      "opengeni-cse=d300f70b",
      values.image!,
      "sleep",
      "infinity",
    ]);
    const minted = (await api.call(
      "POST",
      `/v1/workspaces/${workspace}/enrollments/token`,
      {},
    )) as { token: string };
    const env = [
      "env",
      "OPENGENI_CONFIG_DIR=/root/.og",
      `OPENGENI_API_URL=${values.api}`,
      "HOME=/root",
    ];
    sh([
      "docker",
      "exec",
      name,
      ...env,
      "/opt/og/opengeni-agent",
      "connect",
      "--non-interactive",
      "--token",
      minted.token,
      "--workspace-id",
      workspace,
      "--machine-name",
      name,
    ]);
    sh([
      "docker",
      "exec",
      "-d",
      name,
      "sh",
      "-c",
      `${env.join(" ")} /opt/og/opengeni-agent run > /root/agent.log 2>&1`,
    ]);
    const machine = await waitFor(async () => {
      const list = (await api.call(
        "GET",
        `/v1/workspaces/${workspace}/machines`,
      )) as { machines?: Record<string, string>[] };
      const m = list.machines?.find((x) => x.name === name);
      return m && ["online", "display_unavailable"].includes(m.state!)
        ? m
        : undefined;
    }, 180_000);
    enrollment = machine.enrollmentId ?? null;
    const created = (await api.call(
      "POST",
      `/v1/workspaces/${workspace}/sessions`,
      {
        initialMessage: values.smoke
          ? "Run `command -v rg && rg --version | head -1` in /app and report the output verbatim."
          : findCodeInstruction(task),
        model: values.model,
        reasoningEffort: values.effort,
        latencyMode: "standard",
        targetSandboxId: machine.sandboxId,
        workingDir: "/app",
        agentAccess: "session",
        agentLearning: { knowledge: "off", instructions: "off", skills: "off" },
        unattended: true,
        idempotencyKey: `cse:${name}`,
        metadata: {
          benchmark: "code-search-eval",
          arm: values.arm,
          task: task.id,
        },
      },
    )) as { id: string; model?: string; reasoningEffort?: string };
    session = created.id;
    record.session = session;
    record.createdModel = created.model;
    let events: AgentEvent[] = [];
    let quietSince = 0;
    const started = Date.now();
    let status = "timeout";
    while (Date.now() - started < timeoutMs) {
      await Bun.sleep(4000);
      const s = (await api.call(
        "GET",
        `/v1/workspaces/${workspace}/sessions/${session}`,
      )) as SessionSnapshot;
      events = await api.events(workspace, session);
      const terminal = events.some((e) => TERMINAL_TURN.has(e.type));
      if (terminal && !sessionBusy(s) && !s.inputWait) {
        quietSince ||= Date.now();
        if (Date.now() - quietSince > 8000) {
          status = String(s.status ?? "idle");
          break;
        }
      } else quietSince = 0;
    }
    record.status = status;
    if (status === "timeout")
      await api
        .call(
          "POST",
          `/v1/workspaces/${workspace}/sessions/${session}/control`,
          {
            action: "cancel",
            reason: "benchmark deadline",
            clientEventId: crypto.randomUUID(),
          },
        )
        .catch(() => undefined);
    events = await api.events(workspace, session);
    writeFileSync(
      join(out, "events", `${tag}.jsonl`),
      events.map((e) => JSON.stringify(e)).join("\n"),
    );
    const latencyMs = performance.now() - t0;
    const answer = finalAnswer(events);
    const usage = usageFromEvents(events);
    const roots = ["/app"];
    const { purposes, models, ...plain } = usage;
    const viewed = localizeTrajectory(events, roots);
    record.answer = answer.slice(0, 4000);
    record.purposes = purposes;
    record.models = models;
    record.network = networkCommands(events);
    record.turnsFailed = events.filter((e) => e.type === "turn.failed").length;
    record.calls = viewed.calls;
    record.codeGrep = codeGrepStats(events);
    const failed = status === "timeout" || !answer;
    const runs: ArmRun[] = [
      {
        taskId: task.id,
        arm: values.arm!,
        prediction: predictionFromAnswer(answer, roots),
        usage: plain,
        latencyMs,
        ...(failed
          ? { error: status === "timeout" ? "timeout" : "no final answer" }
          : {}),
      },
      {
        taskId: task.id,
        arm: `${values.arm}-viewed`,
        prediction: viewed.viewed,
        usage: plain,
        latencyMs,
      },
    ];
    for (const r of runs) appendFileSync(runsPath, `${JSON.stringify(r)}\n`);
  } catch (error) {
    record.error = String(error).slice(0, 600);
    appendFileSync(
      runsPath,
      `${JSON.stringify({
        taskId: task.id,
        arm: values.arm,
        prediction: { files: [], spans: [] },
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          cashUsd: 0,
          apiEquivalentUsd: 0,
          modelCalls: 0,
          toolCalls: 0,
        },
        latencyMs: performance.now() - t0,
        error: `infra: ${String(error).slice(0, 200)}`,
      })}\n`,
    );
  } finally {
    if (session && workspace && record.status === undefined)
      await api
        .call(
          "POST",
          `/v1/workspaces/${workspace}/sessions/${session}/control`,
          {
            action: "cancel",
            reason: "benchmark adapter failure",
            clientEventId: crypto.randomUUID(),
          },
        )
        .catch(() => undefined);
    if (enrollment && workspace)
      await api
        .call(
          "POST",
          `/v1/workspaces/${workspace}/enrollments/${enrollment}/revoke`,
          { idempotencyKey: `cse-revoke:${name}` },
        )
        .catch(() => undefined);
    if (session && workspace)
      await api
        .call(
          "PUT",
          `/v1/workspaces/${workspace}/sessions/${session}/archive`,
          { archived: true },
        )
        .catch(() => undefined);
    sh(["docker", "rm", "-f", name], { check: false });
    if (snap) {
      // Files the container created are root-owned; remove them from inside a throwaway container.
      sh(
        [
          "docker",
          "run",
          "--rm",
          "-v",
          `${snap}:/s`,
          values.image!,
          "rm",
          "-rf",
          "/s/app",
        ],
        { check: false },
      );
      rmSync(snap, { recursive: true, force: true });
    }
    appendFileSync(
      detailPath,
      `${JSON.stringify({ ...record, workspace, endedAt: new Date().toISOString(), wallMs: Math.round(performance.now() - t0) })}\n`,
    );
  }
}

const rows = await readJsonl<ContextBenchRow>(values.contextbench!);
let tasks = splitByRepo(
  rows.map(contextBenchTask).filter((t) => t.oracle.files.length),
);
if (values.split !== "all")
  tasks = tasks.filter((t) => t.split === values.split);
if (values["per-language"])
  tasks = stratifiedSample(tasks, Number(values["per-language"]));
if (values["task-ids"]) {
  const wanted = new Set(
    readFileSync(values["task-ids"], "utf8").split("\n").map((l) => l.trim()).filter(Boolean),
  );
  tasks = tasks.filter((t) => wanted.has(t.id));
}
if (values.limit) tasks = tasks.slice(0, Number(values.limit));
const done = new Set(
  existsSync(runsPath)
    ? readFileSync(runsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ArmRun)
        .filter(
          (r) =>
            r.arm === values.arm && !String(r.error ?? "").startsWith("infra:"),
        )
        .map((r) => r.taskId)
    : [],
);
const config = await api.init();
console.log(
  `runtime ${config.deploymentRevision}; ${tasks.length} tasks, ${done.size} done`,
);
if (!existsSync(binary)) throw new Error("--agent-binary is required");
const repos = new RepoCache(resolve(values["repo-cache"]!));
const queue = tasks.filter((t) => !done.has(t.id));
let next = 0;
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < queue.length) {
      const task = queue[next++]!;
      await attempt(task, repos);
      console.log(
        `${new Date().toISOString()} ${task.id} done (${next}/${queue.length})`,
      );
    }
  }),
);
