import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, relative } from "node:path";
import { runCodeSearch } from "../../../packages/jev/src/code-search/search";
import type { CodeSearchWorkspace } from "../../../packages/jev/src/code-search/workspace";
import type { DecisionModel } from "../../../packages/decisions/src/types";
import { predictionFromSpans, queryKeywords, spansFromPack } from "./arms";
import { addUsage, zeroUsage, type Arm } from "./types";

/** A local-directory CodeSearchWorkspace: ripgrep and file reads confined to the checkout. */
export function localWorkspace(
  root: string,
  byteCap = 4 * 1024 * 1024,
): CodeSearchWorkspace {
  const inside = (path: string) => {
    const full = normalize(join(root, path));
    return relative(root, full).startsWith("..") ? null : full;
  };
  return {
    ripgrep(args, { signal, timeoutMs }) {
      return new Promise((resolve, reject) => {
        const child = spawn("rg", [...args], {
          cwd: root,
          ...(signal ? { signal } : {}),
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        const out: Buffer[] = [];
        let size = 0;
        let truncated = false;
        child.stdout.on("data", (d: Buffer) => {
          if (size >= byteCap) return void (truncated = true);
          out.push(d);
          size += d.length;
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            stdout: Buffer.concat(out).toString("utf8").slice(0, byteCap),
            exitCode: code,
            truncated,
            timedOut,
          });
        });
      });
    },
    async readText(path, { maxBytes }) {
      const full = inside(path);
      if (!full) return null;
      const buffer = await readFile(full).catch(() => null);
      if (!buffer) return null;
      const binary = buffer.subarray(0, 8000).includes(0);
      return {
        text: buffer.subarray(0, maxBytes).toString("utf8"),
        truncated: buffer.length > maxBytes,
        binary,
      };
    },
    async pathKinds(paths) {
      const kinds: Record<string, "file" | "directory" | "missing"> = {};
      for (const path of paths) {
        const full = inside(path);
        const info = full ? await stat(full).catch(() => null) : null;
        kinds[path] = info?.isFile()
          ? "file"
          : info?.isDirectory()
            ? "directory"
            : "missing";
      }
      return kinds;
    },
  } as CodeSearchWorkspace;
}

/** Bounded copy of a trace value: long strings and arrays are cut so a sidecar stays readable. */
function boundTrace(value: unknown, depth = 0): unknown {
  if (typeof value === "string")
    return value.length > 2000 ? `${value.slice(0, 2000)}…[${value.length}]` : value;
  if (Array.isArray(value))
    return value.slice(0, 200).map((v) => boundTrace(v, depth + 1));
  if (value && typeof value === "object" && depth < 8)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, boundTrace(v, depth + 1)]),
    );
  return value;
}

/**
 * Opengeni's existing code_search pipeline (rg recall, typed triage and verification). With traceDir,
 * each task's stage events, status, stats and pack are written to <traceDir>/<task>.json, also on failure.
 */
export function codeSearchArm(
  decisionModel: DecisionModel,
  name = "code-search",
  options: { traceDir?: string } = {},
): Arm {
  if (options.traceDir) mkdirSync(options.traceDir, { recursive: true });
  return {
    name,
    live: true,
    async run(task, { repoDir, signal }) {
      const usage = zeroUsage();
      const events: Array<{ ms: number; stage: string; data: unknown }> = [];
      const t0 = performance.now();
      const save = (extra: Record<string, unknown>) => {
        if (!options.traceDir) return;
        const file = join(
          options.traceDir,
          `${task.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`,
        );
        writeFileSync(
          file,
          JSON.stringify({ taskId: task.id, arm: name, events, ...extra }),
        );
      };
      let result: Awaited<ReturnType<typeof runCodeSearch>>;
      try {
        result = await runCodeSearch({
          question: task.query.slice(0, 4000),
          keywords: queryKeywords(task.query),
          workspace: localWorkspace(repoDir),
          decisionModel,
          signal,
          onStage: (stage, data) =>
            events.push({
              ms: Math.round(performance.now() - t0),
              stage,
              data: boundTrace(data),
            }),
          onDecisionUsage: (u) => {
            addUsage(usage, {
              modelCalls: u.requests,
              inputTokens: u.inputTokens ?? 0,
              cashUsd: u.costUsd ?? 0,
              apiEquivalentUsd: u.costUsd ?? 0,
            });
          },
        });
      } catch (error) {
        save({ error: String((error as Error)?.message ?? error).slice(0, 500), usage });
        throw error;
      }
      save({
        status: result.status,
        stats: result.stats,
        statusCheckError: result.statusCheckError
          ? String(result.statusCheckError.message).slice(0, 500)
          : null,
        pack: result.text,
        usage,
      });
      return {
        prediction: predictionFromSpans(spansFromPack(result.text)),
        usage,
      };
    },
  };
}
