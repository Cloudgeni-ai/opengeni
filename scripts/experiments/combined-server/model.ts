// Reproducible inference only; production turn admission, tools, and persistence run unchanged.
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "@openai/agents";
import { ScriptedModel, functionCall } from "../../../packages/testing/src/scripted-model";

export class ExperimentModel implements Model {
  private model(request: ModelRequest) {
    const blockMs = Number(process.env.EXPERIMENT_BLOCK_MS ?? 0);
    if (blockMs > 0) {
      const deadline = performance.now() + blockMs;
      while (performance.now() < deadline) {
        /* Separate synthetic contention probe. */
      }
    }
    const items = Array.isArray(request.input) ? request.input : [];
    const completedTool = items.some((item) => item.type === "function_call_result");
    return new ScriptedModel([
      completedTool
        ? {
            id: crypto.randomUUID(),
            chunks: Array.from(
              { length: Number(process.env.EXPERIMENT_STREAM_CHUNKS ?? 30) },
              () => "Measured work completed. ",
            ),
            delayMs: 100,
          }
        : {
            id: crypto.randomUUID(),
            output: [functionCall("bench__make_sheet", { title: "Experiment sheet" })],
          },
    ]);
  }
  getResponse(request: ModelRequest): Promise<ModelResponse> {
    return this.model(request).getResponse(request);
  }
  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    return this.model(request).getStreamedResponse(request);
  }
}
