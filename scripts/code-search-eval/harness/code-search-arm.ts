import { spawn } from "node:child_process";
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

/** Opengeni's existing code_search pipeline (rg recall, Jev triage and verification) with Jev via Gateway. */
export function codeSearchArm(
  decisionModel: DecisionModel,
  name = "code-search",
): Arm {
  return {
    name,
    live: true,
    async run(task, { repoDir, signal }) {
      const usage = zeroUsage();
      const result = await runCodeSearch({
        question: task.query.slice(0, 4000),
        keywords: queryKeywords(task.query),
        workspace: localWorkspace(repoDir),
        decisionModel,
        signal,
        onDecisionUsage: (u) => {
          addUsage(usage, {
            modelCalls: u.requests,
            inputTokens: u.inputTokens ?? 0,
            cashUsd: u.costUsd ?? 0,
            apiEquivalentUsd: u.costUsd ?? 0,
          });
        },
      });
      return {
        prediction: predictionFromSpans(spansFromPack(result.text)),
        usage,
      };
    },
  };
}
