import { describe, expect, test } from "bun:test";
import { getSettings } from "@infra-agents/config";
import { buildInfraAgent, configureOpenAI, runAgentStream } from "@infra-agents/runtime";
import { listGitHubAppRepositories } from "@infra-agents/github";
import { functionCall, ScriptedModel } from "@infra-agents/testing";

describe("live provider smoke tests", () => {
  const live = process.env.INFRA_AGENT_ENABLE_LIVE_TESTS === "true";

  test.skipIf(!live)("runs a real configured OpenAI/Azure model smoke", async () => {
    const settings = getSettings();
    configureOpenAI(settings);
    const agent = buildInfraAgent({ ...settings, sandboxBackend: "none" }, []);
    const stream = await runAgentStream(agent, "Reply with exactly: live-ok", { ...settings, sandboxBackend: "none" });
    for await (const _event of stream.toStream()) {
      // Drain stream.
    }
    await stream.completed;
    expect(String(stream.finalOutput).toLowerCase()).toContain("live-ok");
  }, 120_000);

  test.skipIf(!live || !process.env.INFRA_AGENT_GITHUB_APP_ID)("lists real GitHub App repositories when configured", async () => {
    const repositories = await listGitHubAppRepositories(getSettings());
    expect(Array.isArray(repositories)).toBe(true);
  }, 60_000);

  test.skipIf(!live || process.env.INFRA_AGENT_SANDBOX_BACKEND !== "modal")("runs a real Modal sandbox smoke", async () => {
    const settings = { ...getSettings(), sandboxBackend: "modal" as const, openaiModel: "scripted-model" };
    const agent = buildInfraAgent(settings, [], {
      model: new ScriptedModel([
        {
          output: [functionCall("exec_command", { cmd: "echo modal-ok" }, "modal-shell")],
        },
        {
          outputText: "modal-ok",
        },
      ]),
    });
    const stream = await runAgentStream(agent, "verify modal sandbox", settings);
    for await (const _event of stream.toStream()) {
      // Drain stream.
    }
    await stream.completed;
    expect(JSON.stringify(stream.finalOutput ?? "")).toContain("modal-ok");
  }, 180_000);

  test.skipIf(!live || !hasAzureServicePrincipal() || process.env.INFRA_AGENT_SANDBOX_BACKEND === "none")("pre-authenticates normal Azure CLI inside the sandbox", async () => {
    const settings = { ...getSettings(), openaiModel: "scripted-model" };
    const agent = buildInfraAgent(settings, [], {
      model: new ScriptedModel([
        {
          output: [functionCall("exec_command", { cmd: "az account show --output json" }, "azure-shell")],
        },
        {
          outputText: "azure-ok",
        },
      ]),
    });
    const stream = await runAgentStream(agent, "verify azure cli auth", settings);
    for await (const _event of stream.toStream()) {
      // Drain stream.
    }
    await stream.completed;
    expect(JSON.stringify(stream.finalOutput ?? "")).toContain("azure-ok");
  }, 180_000);
});

function hasAzureServicePrincipal(): boolean {
  const env = process.env;
  return Boolean((env.AZURE_CLIENT_ID || env.ARM_CLIENT_ID) &&
    (env.AZURE_CLIENT_SECRET || env.ARM_CLIENT_SECRET) &&
    (env.AZURE_TENANT_ID || env.ARM_TENANT_ID));
}
