import { AsyncLocalStorage } from "node:async_hooks";
import type { Model, ModelRequest, StreamEvent } from "@openai/agents";

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
    await capture(request);
  } catch {
    // Observational. A failure must never change model execution.
  }
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
