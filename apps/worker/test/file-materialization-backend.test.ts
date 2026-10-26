import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Manifest } from "@openai/agents/sandbox";
import {
  materializeSandboxFileDownloads,
  sandboxFileDownloadFailureNote,
  type SandboxFileDownloadFailure,
} from "@opengeni/runtime";
import type { Settings } from "@opengeni/config";
import { parseSync, type Node } from "oxc-parser";

// Execute the actual worker call with the real runtime materializer. Extracting
// this bounded seam avoids booting Temporal/DB or copying the option wiring into
// the test (which would miss a regression at the worker call site).
const path = "../src/activities/agent-turn/run.ts";
const source = readFileSync(new URL(path, import.meta.url), "utf8");
const parsed = parseSync("run.ts", source);
expect(parsed.errors).toEqual([]);
const calls: Node[] = [];
function visit(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(visit);
    return;
  }
  const node = value as Node;
  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "materializeSandboxFileDownloads"
  )
    calls.push(node);
  Object.values(value).forEach(visit);
}
visit(parsed.program);
expect(calls).toHaveLength(1);
const call = calls[0]!;
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `async function materialize() { return await ${source.slice(call.start, call.end)}; }`,
);
const workerMaterialize = new Function(
  "materializeSandboxFileDownloads",
  "sandboxState",
  "downloadsToMaterialize",
  "eventing",
  "activeSandboxBackend",
  "groupBoxBackend",
  "runSettings",
  "runAs",
  `${compiled}; return materialize();`,
);

describe("worker pre-materialization effective backend", () => {
  test.each([
    {
      name: "Modal home switched to a root Connected Machine",
      home: "modal",
      active: "selfhosted",
      group: "modal",
      root: "/",
      guidance: true,
    },
    {
      name: "Connected Machine home at root",
      home: "selfhosted",
      active: "selfhosted",
      group: "selfhosted",
      root: "/",
      guidance: true,
    },
    {
      name: "managed root workspace",
      home: "modal",
      active: undefined,
      group: "modal",
      root: "/",
      guidance: false,
    },
    {
      name: "machine home falling back to managed compute",
      home: "selfhosted",
      active: undefined,
      group: "modal",
      root: "/",
      guidance: false,
    },
    {
      name: "non-root Connected Machine folder",
      home: "modal",
      active: "selfhosted",
      group: "modal",
      root: "/Users/example",
      guidance: false,
    },
  ] as const)("$name", async ({ home, active, group, root, guidance }) => {
    const raw = "mkdir: .opengeni: Read-only file system";
    const commands: Array<{ workdir?: string }> = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const result: { failures: SandboxFileDownloadFailure[] } = await workerMaterialize(
      materializeSandboxFileDownloads,
      {
        setupBoxSession: {
          state: { manifest: new Manifest({ root }) },
          exec: async (command: { workdir?: string }) => {
            commands.push(command);
            return { output: raw, exitCode: 1 };
          },
        },
      },
      [
        {
          fileId: "file-1",
          mountPath: ".opengeni/files/file-1",
          filename: "input.txt",
          url: "https://storage.example/input.txt?sig=not-for-events",
        },
      ],
      {
        toolCancellationFenceRef: { current: null },
        publish: async (batch: typeof events) => events.push(...batch),
      },
      active,
      group,
      { sandboxBackend: home } satisfies Pick<Settings, "sandboxBackend">,
      undefined,
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]?.workdir).toBe(root);
    expect(result.failures).toHaveLength(1);
    const failure = result.failures[0]!;
    expect(failure.path).toBe(`${root === "/" ? "" : root}/.opengeni/files/file-1/input.txt`);
    expect(failure.exitCode).toBe(1);
    expect(failure.output).toBe(raw);
    expect(failure.reason).toContain(raw);
    expect(failure.reason.includes("working directory is the filesystem root (/)")).toBe(guidance);
    expect(
      sandboxFileDownloadFailureNote(result.failures).includes(
        "start a new session on this machine",
      ),
    ).toBe(guidance);
    expect(events.map((event) => event.type)).toEqual([
      "sandbox.operation.started",
      "sandbox.operation.failed",
    ]);
    expect(events[1]?.payload.error).toBe(failure.reason);
    expect(events[1]?.payload.exitCode).toBe(1);
    expect(events[1]?.payload.output).toBe(raw);
    expect(JSON.stringify(events)).not.toContain("sig=not-for-events");
  });
});
