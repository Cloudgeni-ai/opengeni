import { getSettings } from "@opengeni/config";
import { createDb } from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { createOpenGeniWorker } from "@opengeni/worker";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "@openai/agents";
import { functionCall, ScriptedModel, type ScriptedModelStep } from "./scripted-model";

const settings = getSettings();
const dbClient = createDb(settings.databaseUrl);
const bus = await createNatsEventBus(settings.natsUrl);
const model = scriptedModelForScenario(process.env.OPENGENI_TEST_SCENARIO ?? "default");
const runtime = createProductionAgentRuntime({ model });
const { worker, connection } = await createOpenGeniWorker({
  settings,
  activityDependencies: {
    settings,
    db: dbClient.db,
    bus,
    runtime,
  },
});

console.log(`OpenGeni test worker listening on ${settings.temporalTaskQueue}`);
try {
  await worker.run();
} finally {
  await Promise.allSettled([
    bus.close(),
    dbClient.close(),
    connection.close(),
  ]);
}

function scriptedModelForScenario(scenario: string): Model {
  if (scenario === "sandbox") {
    return new SandboxScriptedModel();
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

class SandboxScriptedModel implements Model {
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    return await new ScriptedModel([sandboxStepForRequest(request)]).getResponse(request);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    yield* new ScriptedModel([sandboxStepForRequest(request)]).getStreamedResponse(request);
  }
}

function sandboxStepForRequest(request: ModelRequest): ScriptedModelStep {
  const body = JSON.stringify(request.input ?? request);
  if (
    body.includes("sandbox-ok") ||
    body.includes("file-mounted-ok") ||
    body.includes("sandbox-view-image")
  ) {
    return sandboxDoneStep();
  }
  if (body.includes("verify mounted image")) {
    return {
      output: [functionCall("view_image", {
        path: "/workspace/files/e2e-image/sandbox-image.png",
      }, "sandbox-view-image")],
    };
  }
  return sandboxShellStep();
}

function sandboxShellStep(): ScriptedModelStep {
  return {
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
}

function sandboxDoneStep(): ScriptedModelStep {
  return {
    chunks: ["sandbox ", "ok"],
    outputText: "sandbox ok",
  };
}
