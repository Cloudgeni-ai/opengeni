import { expect, test } from "bun:test";
import { collectConnectorToolPages } from "../src/domain/connector-tool-permissions";

const tools = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, index) => ({
    name: `tool_${index + offset}`,
    inputSchema: { type: "object" as const },
  }));

test("permissions discovery retains the full shared catalog allowance across pages", async () => {
  const seen: Array<string | undefined> = [];
  const result = await collectConnectorToolPages(
    {
      async listTools(params) {
        seen.push(params?.cursor);
        return params?.cursor
          ? { tools: tools(2048, 2048) }
          : { tools: tools(2048), nextCursor: "page2" };
      },
    },
    new AbortController().signal,
  );
  expect(result).toHaveLength(4096);
  expect(result.at(-1)?.name).toBe("tool_4095");
  expect(seen).toEqual([undefined, "page2"]);
});

test("permissions discovery still rejects overflow, duplicate names and repeated cursors", async () => {
  for (const page of [
    { tools: tools(4097) },
    { tools: [...tools(1), ...tools(1)] },
    { tools: [], nextCursor: "repeat" },
  ]) {
    await expect(
      collectConnectorToolPages(
        {
          async listTools() {
            return page;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
});
