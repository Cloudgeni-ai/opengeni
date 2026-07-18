import { getSettings } from "@opengeni/config";
import { createDb } from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { createOpenGeniWorker } from "@opengeni/worker-bundle";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "@openai/agents";
import {
  functionCall,
  latestExecCommandState,
  ScriptedModel,
  type ScriptedModelStep,
} from "./scripted-model";

const settings = getSettings();
const role = process.env.OPENGENI_WORKER_ROLE;
if (role !== "control" && role !== "turn") {
  throw new Error("OPENGENI_WORKER_ROLE must be 'control' or 'turn' for the E2E worker");
}
const dbClient = createDb(settings.databaseUrl);
const bus = await createNatsEventBus(settings.natsUrl);
const model = scriptedModelForScenario(process.env.OPENGENI_TEST_SCENARIO ?? "default");
const runtime = createProductionAgentRuntime({ model });
const { worker, connection } = await createOpenGeniWorker({
  role,
  settings,
  activityDependencies: {
    settings,
    db: dbClient.db,
    bus,
    runtime,
  },
});

console.log(
  `OpenGeni ${role} test worker listening on ${settings.temporalTaskQueue} ` +
    `(ownership=${settings.sandboxOwnershipEnabled} capture=${settings.workspaceCaptureEnabled} storage=${Boolean(settings.objectStorageEndpoint)})`,
);
try {
  await worker.run();
} finally {
  await Promise.allSettled([bus.close(), dbClient.close(), connection.close()]);
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
        outputText:
          "slow **stream**\n\n| Name | Value |\n| --- | --- |\n| inline code | `ok` |\n\n```ts\nconst ok = true;\n```\n\nstill running long enough to interrupt",
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
  const completionMarkers = [
    "sandbox-ok",
    "file-mounted-ok",
    "sandbox-view-image",
    "workbench-capture-e2e-complete",
  ];
  const execState = latestExecCommandState(body);
  if (execState?.status === "running") {
    return {
      output: [
        functionCall(
          "write_stdin",
          {
            session_id: execState.sessionId,
            chars: "",
            yield_time_ms: 10_000,
            max_output_tokens: 20_000,
          },
          `sandbox-shell-poll-${execState.sessionId}-${execState.occurrence}`,
        ),
      ],
    };
  }
  if (execState?.status === "exited") {
    if (completionMarkers.some((marker) => body.lastIndexOf(marker) > execState.index)) {
      return sandboxDoneStep();
    }
    return {
      chunks: ["sandbox command exited without its acceptance marker"],
      outputText: "sandbox command exited without its acceptance marker",
    };
  }
  if (completionMarkers.some((marker) => body.includes(marker))) {
    return sandboxDoneStep();
  }
  if (body.includes("workbench capture acceptance fixture")) {
    return workspaceCaptureShellStep();
  }
  if (body.includes("verify mounted image")) {
    return {
      output: [
        functionCall(
          "view_image",
          {
            path: "/workspace/files/e2e-image/sandbox-image.png",
          },
          "sandbox-view-image",
        ),
      ],
    };
  }
  return sandboxShellStep();
}

function workspaceCaptureShellStep(): ScriptedModelStep {
  return {
    output: [
      functionCall(
        "exec_command",
        {
          cmd: [
            "set -euo pipefail",
            "rm -rf api web",
            "mkdir -p api web",
            "git -C api init -q",
            "git -C api config user.email e2e@opengeni.dev",
            "git -C api config user.name 'OpenGeni E2E'",
            "printf 'base api\\n' > api/app.txt",
            "git -C api add app.txt",
            "git -C api commit -qm base",
            "printf 'changed api\\n' > api/app.txt",
            "printf 'untracked api\\n' > api/notes.txt",
            "git -C web init -q",
            "git -C web config user.email e2e@opengeni.dev",
            "git -C web config user.name 'OpenGeni E2E'",
            "printf 'rename me\\n' > web/old.txt",
            "printf 'delete me\\n' > web/deleted.txt",
            "git -C web add -A",
            "git -C web commit -qm base",
            "git -C web mv old.txt renamed.txt",
            "git -C web rm -q deleted.txt",
            "printf 'workbench-capture-e2e-complete\\n'",
          ].join("\n"),
          yield_time_ms: 10_000,
          max_output_tokens: 20_000,
        },
        "workbench-capture-e2e-shell",
      ),
    ],
  };
}

function sandboxShellStep(): ScriptedModelStep {
  return {
    output: [
      functionCall(
        "exec_command",
        {
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
        },
        "sandbox-shell",
      ),
    ],
  };
}

function sandboxDoneStep(): ScriptedModelStep {
  return {
    chunks: ["sandbox ", "ok"],
    outputText: "sandbox ok",
  };
}
