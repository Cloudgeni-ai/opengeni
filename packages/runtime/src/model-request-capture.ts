import { AsyncLocalStorage } from "node:async_hooks";
import type { Model, ModelProvider, ModelRequest, StreamEvent } from "@openai/agents";

const modelRequestCapture = new AsyncLocalStorage<
  (request: ModelRequest) => void | Promise<void>
>();

export function withModelRequestCapture<T>(
  capture: ((request: ModelRequest) => void | Promise<void>) | undefined,
  fn: () => T,
): T {
  return capture ? modelRequestCapture.run(capture, fn) : fn();
}

export async function notifyModelRequestCapture(request: ModelRequest): Promise<void> {
  const capture = modelRequestCapture.getStore();
  if (!capture) return;
  try {
    // Copy the on-the-wire prefix immediately. The SDK may reuse the request
    // object after we yield to persistence.
    await capture(snapshotModelRequestPrefix(request));
  } catch {
    // Observational. A failure must never change model execution.
  }
}

function snapshotModelRequestPrefix(request: ModelRequest): ModelRequest {
  return {
    ...request,
    tools: Array.isArray(request.tools) ? [...request.tools] : request.tools,
  };
}

export class ModelRequestCaptureModel implements Model {
  constructor(private readonly inner: Model) {}

  async getResponse(request: ModelRequest) {
    void notifyModelRequestCapture(request);
    return this.inner.getResponse(request);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    void notifyModelRequestCapture(request);
    yield* this.inner.getStreamedResponse(request);
  }

  getRetryAdvice(args: Parameters<NonNullable<Model["getRetryAdvice"]>>[0]) {
    return this.inner.getRetryAdvice?.(args);
  }
}

/**
 * Wrap every name-resolved model so Debug capture sees the ModelRequest the
 * provider client actually receives. OpenGeni agents almost always set
 * `agent.model` to a string; wrapping only `agent.model` is a no-op there.
 */
export class ModelRequestCaptureProvider implements ModelProvider {
  constructor(private readonly inner: ModelProvider) {}

  async getModel(modelName?: string): Promise<Model> {
    const model = await this.inner.getModel(modelName);
    if (model instanceof ModelRequestCaptureModel) return model;
    return new ModelRequestCaptureModel(model);
  }
}
