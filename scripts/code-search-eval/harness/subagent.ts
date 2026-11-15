import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { budgetSpans } from "./arms";
import type { BudgetLedger } from "./budget";
import { predictionFromAnswer } from "./trajectory";
import { addUsage, zeroUsage, type Arm } from "./types";

/**
 * Arm (d): a read-only fast-context subagent on a small model, in the shape of Cognition's SWE-grep
 * (several parallel searches per turn, few turns). It is a candidate Opengeni product capability,
 * so its instructions are task-agnostic; nothing here names a dataset or a repository.
 */
export const SUBAGENT_INSTRUCTIONS = [
  "You find the code someone needs to read or change for a task in a repository. You cannot edit anything.",
  "Each turn, issue every independent search or read you need at once; you have a small number of turns.",
  "Tools: rg (ripgrep arguments, run at the repository root), read (path and optional line range), ls (directory).",
  "When you have found the relevant code, reply without tool calls, listing each relevant span as path:start-end, most important first.",
].join("\n");

export type ToolCall = {
  id: string;
  name: "rg" | "read" | "ls";
  args: Record<string, unknown>;
};
export type SubagentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };
export type SubagentStep = {
  text: string;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  };
};
export type SubagentModel = {
  name: string;
  worstCaseUsdPerTurn: number;
  step(input: {
    system: string;
    messages: SubagentMessage[];
    signal: AbortSignal;
  }): Promise<SubagentStep>;
};

const OUTPUT_CAP = 12_000;
const cap = (s: string) =>
  s.length > OUTPUT_CAP
    ? `${s.slice(0, OUTPUT_CAP)}\n[output truncated at ${OUTPUT_CAP} chars]`
    : s;

export function runTool(root: string, call: ToolCall): string {
  const inside = (p: unknown) => {
    const full = normalize(join(root, typeof p === "string" ? p : "."));
    return relative(root, full).startsWith("..") ? null : full;
  };
  if (call.name === "rg") {
    const args = Array.isArray(call.args.args)
      ? call.args.args.map(String)
      : [String(call.args.pattern ?? "")];
    const r = spawnSync("rg", ["-n", "--max-columns", "300", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 << 20,
    });
    return cap(
      r.stdout || (r.status === 1 ? "(no matches)" : r.stderr || "(rg failed)"),
    );
  }
  const full = inside(call.args.path);
  if (!full) return "path is outside the repository";
  if (call.name === "ls") {
    const r = spawnSync("ls", ["-p", full], { encoding: "utf8" });
    return cap(r.stdout || r.stderr);
  }
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    return "file not found";
  }
  const lines = text.split("\n");
  const start = Math.max(1, Number(call.args.start ?? 1) || 1);
  const end = Math.min(
    lines.length,
    Number(call.args.end ?? start + 199) || start + 199,
  );
  return cap(
    lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}: ${l}`)
      .join("\n"),
  );
}

export function subagentArm(
  model: SubagentModel,
  ledger: BudgetLedger,
  options: { maxTurns?: number; maxParallel?: number } = {},
): Arm {
  const maxTurns = options.maxTurns ?? 4;
  const maxParallel = options.maxParallel ?? 8;
  return {
    name: `subagent:${model.name}`,
    live: true,
    async run(task, { repoDir, signal }) {
      const usage = zeroUsage();
      const messages: SubagentMessage[] = [
        { role: "user", content: `Task:\n${task.query.slice(0, 8000)}` },
      ];
      let answer = "";
      for (let turn = 0; turn < maxTurns; turn++) {
        const last = turn === maxTurns - 1;
        if (last)
          messages.push({
            role: "user",
            content:
              "This is your last turn: answer now with the spans, without tool calls.",
          });
        const hold = ledger.reserve(
          `subagent:${model.name}`,
          task.id,
          model.worstCaseUsdPerTurn,
        );
        let step: SubagentStep;
        try {
          step = await model.step({
            system: SUBAGENT_INSTRUCTIONS,
            messages,
            signal,
          });
        } catch (error) {
          hold.settle(model.worstCaseUsdPerTurn);
          const stop = ledger.fail(`subagent:${model.name}`, task.id, error);
          throw stop ?? error;
        }
        const cost = step.usage.costUsd ?? model.worstCaseUsdPerTurn;
        hold.settle(cost);
        addUsage(usage, {
          modelCalls: 1,
          inputTokens: step.usage.inputTokens,
          cachedInputTokens: step.usage.cachedInputTokens,
          outputTokens: step.usage.outputTokens,
          cashUsd: cost,
          apiEquivalentUsd: cost,
        });
        const calls = last ? [] : step.toolCalls.slice(0, maxParallel);
        if (!calls.length) {
          answer = step.text;
          break;
        }
        messages.push({
          role: "assistant",
          content: step.text,
          toolCalls: calls,
        });
        usage.toolCalls += calls.length;
        for (const call of calls)
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: runTool(repoDir, call),
          });
      }
      const prediction = predictionFromAnswer(answer, [repoDir]);
      return {
        prediction: {
          files: prediction.files,
          spans: budgetSpans(prediction.spans),
        },
        usage,
      };
    },
  };
}
