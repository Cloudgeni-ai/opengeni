import { describe, expect, test } from "bun:test";
import { Agent, tool, type Tool } from "@openai/agents";
import {
  installSandboxSetupNoticeDelivery,
  queueSandboxSetupNotice,
  takeSandboxSetupNotices,
} from "../src/sandbox-setup-notices";

const textTool = (name: string, output: unknown = `${name} done`) =>
  tool({
    name,
    description: name,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
    execute: async () => output as string,
  }) as Tool;

async function invoke(candidate: Tool): Promise<unknown> {
  if (candidate.type !== "function") throw new Error("not a function tool");
  return await candidate.invoke({ context: {} } as never, "{}", {
    toolCall: { type: "function_call", callId: crypto.randomUUID(), name: candidate.name },
  } as never);
}

describe("sandbox setup notices", () => {
  test("held notices join one take, once, without duplicates", () => {
    const agent = new Agent({ name: "a" });
    expect(takeSandboxSetupNotices(agent)).toBeNull();
    queueSandboxSetupNotice(agent, "moved A");
    queueSandboxSetupNotice(agent, "moved A");
    queueSandboxSetupNotice(agent, "  ");
    queueSandboxSetupNotice(agent, "moved B");
    expect(takeSandboxSetupNotices(agent)).toBe("moved A\n\nmoved B");
    expect(takeSandboxSetupNotices(agent)).toBeNull();
  });

  test("a notice held during a tool call follows that call's plain-text result, once", async () => {
    const agent = new Agent({ name: "a" });
    const delivered: string[] = [];
    let exec: Tool | undefined;
    const execTool = tool({
      name: "exec_command",
      description: "exec",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      strict: true,
      // The box is established, and set up, by the first sandbox operation.
      execute: async () => {
        queueSandboxSetupNotice(agent, "[Opengeni setup notice] moved");
        return "ls output";
      },
    }) as Tool;
    const json = textTool("json_tool", '{"ok":true}');
    agent.tools = [execTool, json];
    installSandboxSetupNoticeDelivery(agent, { onDelivered: (text) => delivered.push(text) });
    installSandboxSetupNoticeDelivery(agent);
    [exec] = await agent.getAllTools({ context: {} } as never);
    const [again, jsonTool] = await agent.getAllTools({ context: {} } as never);
    expect(again).toBe(exec!);
    // Only the sandbox shell tools are wrapped; others keep their identity.
    expect(jsonTool).toBe(json);
    expect(await invoke(exec!)).toBe("ls output\n\n[Opengeni setup notice] moved");
    expect(delivered).toEqual(["[Opengeni setup notice] moved"]);

    // Other tools never carry the notice; it waits for a shell result.
    queueSandboxSetupNotice(agent, "later");
    expect(await invoke(jsonTool!)).toBe('{"ok":true}');
    // A shell result that is not plain text stays as returned, too.
    const clone = agent.clone({
      tools: [
        textTool("exec_command", { type: "image", image: "data:image/png;base64,AA==" }),
        textTool("write_stdin"),
      ],
    });
    const [image, stdin] = await clone.getAllTools({ context: {} } as never);
    expect(await invoke(image!)).toEqual({ type: "image", image: "data:image/png;base64,AA==" });
    expect(await invoke(stdin!)).toBe("write_stdin done\n\nlater");
    expect(takeSandboxSetupNotices(agent)).toBeNull();
    expect(delivered).toEqual(["[Opengeni setup notice] moved", "later"]);
  });
});
