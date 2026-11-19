import { describe, expect, test } from "bun:test";
import { applyDiff } from "@openai/agents";
import type { Tool } from "@openai/agents";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import {
  closestContextRegion,
  parseRobustPatch,
  reorderHunksByFile,
} from "../src/apply-patch-robust";
import { buildAgentCapabilities } from "../src/index";

type FunctionTool = Extract<Tool<unknown>, { type: "function" }>;
type Operation = { type: string; path: string; diff?: string; moveTo?: string };

const PY = [
  "def a():",
  "    return 1",
  "",
  "def b():",
  "    return 2",
  "",
  "def c():",
  "    return 3",
  "",
].join("\n");

/** A session whose editor applies V4A diffs with the SDK's applyDiff over an in-memory tree. */
function memorySession(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const reads: string[] = [];
  const commands: string[] = [];
  const editor = {
    createFile: async (operation: Operation) => {
      if (files.has(operation.path)) throw new Error(`${operation.path} already exists`);
      files.set(operation.path, applyDiff("", operation.diff ?? "", "create"));
      return {};
    },
    updateFile: async (operation: Operation) => {
      const current = files.get(operation.path);
      if (current === undefined) throw new Error(`${operation.path} not found`);
      const next = applyDiff(current, operation.diff ?? "");
      files.delete(operation.path);
      files.set(operation.moveTo ?? operation.path, next);
      return {};
    },
    deleteFile: async (operation: Operation) => {
      files.delete(operation.path);
      return {};
    },
  };
  const session = {
    createEditor: () => editor,
    readFile: async ({ path }: { path: string }) => {
      reads.push(path);
      const content = files.get(path);
      if (content === undefined) throw new Error(`${path} not found`);
      return new TextEncoder().encode(content);
    },
    execCommand: async ({ cmd }: { cmd: string }) => {
      commands.push(cmd);
      return "Chunk ID: c1\nWall time: 0.0100 seconds\nProcess exited with code 0\nOutput:\nok\n";
    },
  };
  return { session, files, reads, commands };
}

function applyPatchTool(session: object, settings: Settings): FunctionTool {
  const caps = buildAgentCapabilities(settings, [], { structuredToolTransport: false });
  const tools = caps
    .filter((cap) => cap.type === "filesystem" || cap.type === "shell")
    .flatMap((cap) =>
      cap
        .clone()
        .bind(session as never)
        .tools(),
    );
  const found = tools.find(
    (candidate): candidate is FunctionTool =>
      candidate.type === "function" && candidate.name === "apply_patch",
  );
  if (!found) throw new Error("no apply_patch");
  return found;
}

const robust = () => testSettings({ experimentApplyPatchRobust: true });
const call = (tool: FunctionTool, args: Record<string, unknown>) =>
  tool.invoke({} as never, JSON.stringify(args), {
    toolCall: { type: "function_call", callId: "c1", name: "apply_patch", arguments: "{}" },
  } as never) as Promise<string>;

describe("parseRobustPatch", () => {
  test("parses like the SDK and reads an empty Add File as an empty file", () => {
    expect(
      parseRobustPatch(
        "*** Begin Patch\n*** Add File: empty.txt\n*** Add File: a.txt\n+a\n*** Update File: b.py\n*** Move to: c.py\n@@\n-x\n+y\n*** Delete File: d.txt\n*** End Patch\n",
      ),
    ).toEqual([
      { type: "create_file", path: "empty.txt", diff: "" },
      { type: "create_file", path: "a.txt", diff: "+a\n" },
      { type: "update_file", path: "b.py", diff: "@@\n-x\n+y\n", moveTo: "c.py" },
      { type: "delete_file", path: "d.txt" },
    ]);
  });

  test("leaves input the SDK rejects for other reasons to the SDK", () => {
    expect(parseRobustPatch("*** Add File: a.txt\n+a\n*** End Patch")).toBeNull();
    expect(parseRobustPatch("*** Begin Patch\n*** Update File: a.txt\n*** End Patch")).toBeNull();
    expect(parseRobustPatch("*** Begin Patch\n*** Delete File: a\n-x\n*** End Patch")).toBeNull();
    expect(parseRobustPatch("*** Begin Patch\n*** End Patch")).toBeNull();
  });
});

describe("closestContextRegion", () => {
  test("shows the best fuzzy match with line numbers and the path", () => {
    const region = closestContextRegion(PY, ["def b():", "    return 22"], "m.py");
    expect(region.split("\n")[0]).toBe("Closest match in m.py (lines 1-8):");
    expect(region).toContain("4| def b():");
    expect(region).toContain("5|     return 2");
  });

  test("is bounded and says so when nothing is close", () => {
    const big = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    const region = closestContextRegion(
      big,
      Array.from({ length: 60 }, (_, i) => `line ${i + 100}`),
      "big",
    );
    expect(region.split("\n").length).toBeLessThanOrEqual(41);
    expect(region).toContain("101| line 100");
    expect(closestContextRegion(PY, ["zzzz qqqq"], "m.py")).toBe(
      "No close match for these context lines in m.py.",
    );
  });
});

describe("reorderHunksByFile", () => {
  test("puts uniquely matching hunks in file order", () => {
    const diff =
      "@@\n def c():\n-    return 3\n+    return 30\n@@\n def a():\n-    return 1\n+    return 10\n";
    const reordered = reorderHunksByFile(PY, diff);
    expect(reordered).toBe(
      "@@\n def a():\n-    return 1\n+    return 10\n@@\n def c():\n-    return 3\n+    return 30\n",
    );
    expect(applyDiff(PY, reordered!)).toContain("return 10");
  });

  test("does nothing for ordered, ambiguous or single hunks", () => {
    expect(reorderHunksByFile(PY, "@@\n def a():\n@@\n def c():\n")).toBeNull();
    expect(reorderHunksByFile(PY, "@@\n def c():\n@@\n-\n+x\n")).toBeNull();
    expect(reorderHunksByFile(PY, "@@\n def c():\n-    return 3\n+    return 4\n")).toBeNull();
  });
});

describe("robust apply_patch", () => {
  test("an empty Add File creates an empty file and the other sections apply", async () => {
    const { session, files } = memorySession();
    const tool = applyPatchTool(session, robust());
    const output = await call(tool, {
      patch:
        "*** Begin Patch\n*** Add File: pkg/__init__.py\n*** Add File: pkg/a.py\n+x = 1\n*** End Patch",
    });
    expect(output).toBe("Patch applied.\nPatch applied.");
    expect(files.get("pkg/__init__.py")).toBe("");
    expect(files.get("pkg/a.py")).toBe("x = 1\n");
  });

  test("off by default: the SDK still rejects the whole patch", async () => {
    const { session, files } = memorySession();
    const output = await call(applyPatchTool(session, testSettings()), {
      patch:
        "*** Begin Patch\n*** Add File: pkg/__init__.py\n*** Add File: pkg/a.py\n+x = 1\n*** End Patch",
    });
    expect(output).toContain("must include at least one + line");
    expect(files.size).toBe(0);
  });

  test("a failed create is reported, not faked", async () => {
    const { session } = memorySession({ "e.txt": "already" });
    const output = await call(applyPatchTool(session, robust()), {
      patch: "*** Begin Patch\n*** Add File: e.txt\n*** End Patch",
    });
    expect(output).toBe("Failed to apply patch: e.txt already exists");
  });

  test("an Invalid Context failure shows the closest region; other sections still apply", async () => {
    const { session, files } = memorySession({ "m.py": PY });
    const output = await call(applyPatchTool(session, robust()), {
      patch:
        "*** Begin Patch\n*** Update File: m.py\n@@\n def b():\n-    return 22\n+    return 3\n*** Add File: n.txt\n+n\n*** End Patch",
    });
    const [first, ...rest] = output.split("\n");
    expect(first).toBe("Failed to apply patch: Invalid Context 0:");
    expect(output).toContain("Closest match in m.py (lines 1-8):");
    expect(output).toContain("5|     return 2");
    expect(rest.at(-1)).toBe("Patch applied.");
    expect(files.get("m.py")).toBe(PY);
    expect(files.get("n.txt")).toBe("n\n");
  });

  test("out-of-order hunks are applied in file order", async () => {
    const { session, files } = memorySession({ "m.py": PY });
    const output = await call(applyPatchTool(session, robust()), {
      patch:
        "*** Begin Patch\n*** Update File: m.py\n@@\n def c():\n-    return 3\n+    return 30\n@@\n def a():\n-    return 1\n+    return 10\n*** End Patch",
    });
    expect(output).toBe("Patch applied.");
    expect(files.get("m.py")).toBe(
      PY.replace("return 1", "return 10").replace("return 3", "return 30"),
    );
  });

  test("`then` runs after a robust patch that fully applied", async () => {
    const { session, files, commands } = memorySession();
    const output = await call(applyPatchTool(session, robust()), {
      patch: "*** Begin Patch\n*** Add File: empty.txt\n*** End Patch",
      then: "ls",
    });
    expect(files.get("empty.txt")).toBe("");
    expect(commands).toEqual(["ls"]);
    expect(output.startsWith("Patch applied.\n\nthen:\n")).toBe(true);
  });
});
