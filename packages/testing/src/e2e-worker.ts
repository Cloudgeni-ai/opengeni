import { getSettings } from "@infra-agents/config";
import { createDb } from "@infra-agents/db";
import { createNatsEventBus } from "@infra-agents/events";
import { createProductionAgentRuntime } from "@infra-agents/runtime";
import { createInfraAgentWorker } from "@infra-agents/worker";
import { functionCall, ScriptedModel } from "./scripted-model";

const settings = getSettings();
const dbClient = createDb(settings.databaseUrl);
const bus = await createNatsEventBus(settings.natsUrl);
const model = scriptedModelForScenario(process.env.INFRA_AGENT_TEST_SCENARIO ?? "default");
const runtime = createProductionAgentRuntime({ model });
const { worker, connection } = await createInfraAgentWorker({
  settings,
  activityDependencies: {
    settings,
    db: dbClient.db,
    bus,
    runtime,
  },
});

console.log(`Infra Agents test worker listening on ${settings.temporalTaskQueue}`);
try {
  await worker.run();
} finally {
  await Promise.allSettled([
    bus.close(),
    dbClient.close(),
    connection.close(),
  ]);
}

function scriptedModelForScenario(scenario: string): ScriptedModel {
  if (scenario === "sandbox") {
    const shellStep = {
        output: [functionCall("exec_command", {
          cmd: [
          "set -e",
          "terraform version",
          "checkov --version",
          "az version --output none",
          "gh --version",
          "git --version",
          "jq --version",
          "curl --version",
          "if [ -d files ]; then find files -maxdepth 3 -type f -print -exec cat {} \\; ; fi",
          "mkdir -p repos/e2e/repo && echo sandbox-ok > repos/e2e/repo/agent-output.txt && cat repos/e2e/repo/agent-output.txt",
          ].join("\n"),
          yield_time_ms: 10_000,
          max_output_tokens: 20_000,
        }, "sandbox-shell")],
      };
    const doneStep = {
        chunks: ["sandbox ", "ok"],
        outputText: "sandbox ok",
      };
    return new ScriptedModel([shellStep, doneStep, shellStep, doneStep, shellStep, doneStep]);
  }
  if (scenario === "slow") {
    return new ScriptedModel([
      {
        chunks: [
          "slow **stream**\n\n",
          "| Name | Value |\n| --- | --- |\n| inline code | `ok` |\n\n",
          "```ts\nconst ok = true;\n```\n\n",
          "still ",
          "running ",
          "long ",
          "enough ",
          "to interrupt",
        ],
        outputText: "slow **stream**\n\n| Name | Value |\n| --- | --- |\n| inline code | `ok` |\n\n```ts\nconst ok = true;\n```\n\nstill running long enough to interrupt",
        delayMs: 1_000,
      },
    ]);
  }
  return new ScriptedModel([
    {
      chunks: ["hello ", "from ", "e2e"],
      outputText: "hello from e2e",
    },
  ]);
}
