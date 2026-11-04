import { expect, test } from "bun:test";
import { ScheduledTaskAgentConfig } from "@opengeni/contracts";
import { scheduledGeneratedChatSettings } from "../src/activities/scheduled-tasks";

// A chat a schedule starts gets the task's chat settings, never wider than
// what the task's creator had.

const config = (fields: Record<string, unknown>) =>
  ScheduledTaskAgentConfig.parse({ prompt: "Check", ...fields });

test("keeps the narrower agent access and memory scope", () => {
  expect(
    scheduledGeneratedChatSettings(config({ agentAccess: "session", memoryScope: "off" }), {
      agentAccess: "workspace",
      memoryScope: "user",
    }),
  ).toMatchObject({ agentAccess: "session", memoryScope: "off" });
  expect(
    scheduledGeneratedChatSettings(config({ agentAccess: "workspace", memoryScope: "user" }), {
      agentAccess: "user",
      memoryScope: "workspace",
    }),
  ).toMatchObject({ agentAccess: "user", memoryScope: "workspace" });
  // An ownerless creator has no policy: the task's settings apply.
  expect(
    scheduledGeneratedChatSettings(config({ agentAccess: "session", memoryScope: "off" }), {}),
  ).toEqual({ agentAccess: "session", memoryScope: "off" });
});

test("attaches the task's servers without headers and its skills", () => {
  const settings = scheduledGeneratedChatSettings(
    config({
      mcpServers: [{ id: "product", url: "https://product.example/mcp" }],
      skills: [],
    }),
    {},
  );
  expect(settings.mcpServers).toEqual([
    expect.objectContaining({
      id: "product",
      url: "https://product.example/mcp",
      headersEncrypted: {},
    }),
  ]);
  expect(settings).not.toHaveProperty("skills");
  expect(scheduledGeneratedChatSettings(config({}), {})).toEqual({});
});
