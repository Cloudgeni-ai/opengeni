import type {
  AgentOutputItem,
  Model,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "@openai/agents";
import { Usage } from "@openai/agents";

export type ScriptedModelStep = {
  id?: string;
  chunks?: string[];
  outputText?: string;
  output?: AgentOutputItem[];
  inputTokens?: number;
  delayMs?: number;
  error?: unknown;
};

export class ScriptedModel implements Model {
  readonly steps: ScriptedModelStep[];
  calls = 0;
  requests: ModelRequest[] = [];

  constructor(steps: ScriptedModelStep[] | string) {
    this.steps = typeof steps === "string" ? [{ outputText: steps }] : steps;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const step = this.nextStep(request);
    if (step.error) {
      throw step.error;
    }
    return responseForStep(step, this.calls);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const step = this.nextStep(request);
    if (step.error) {
      throw step.error;
    }
    yield { type: "response_started" };
    for (const chunk of step.chunks ?? textChunks(step.outputText)) {
      if (step.delayMs) {
        await Bun.sleep(step.delayMs);
      }
      yield { type: "output_text_delta", delta: chunk };
    }
    yield {
      type: "response_done",
      response: responseEventForStep(step, this.calls),
    } as StreamEvent;
  }

  private nextStep(request: ModelRequest): ScriptedModelStep {
    this.requests.push(request);
    const index = this.calls++;
    return this.steps[Math.min(index, this.steps.length - 1)] ?? { outputText: "" };
  }
}

export function assistantMessage(text: string, id = crypto.randomUUID()): AgentOutputItem {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  } as AgentOutputItem;
}

export function shellCall(
  commands: string[],
  callId = `shell-${crypto.randomUUID()}`,
): AgentOutputItem {
  return {
    id: callId,
    type: "shell_call",
    callId,
    status: "completed",
    action: {
      commands,
      timeoutMs: 120_000,
      maxOutputLength: 20_000,
    },
  } as AgentOutputItem;
}

export function functionCall(
  name: string,
  args: unknown,
  callId = `fn-${crypto.randomUUID()}`,
): AgentOutputItem {
  return {
    id: callId,
    type: "function_call",
    callId,
    name,
    status: "completed",
    arguments: JSON.stringify(args ?? {}),
  } as AgentOutputItem;
}

function responseForStep(step: ScriptedModelStep, callNumber: number): ModelResponse {
  const text = step.outputText ?? step.chunks?.join("") ?? "";
  return {
    usage: new Usage({
      requests: 1,
      inputTokens: step.inputTokens ?? 1,
      outputTokens: Math.max(1, text.length),
      totalTokens: Math.max(2, text.length + (step.inputTokens ?? 1)),
    }),
    output: step.output ?? (text ? [assistantMessage(text)] : []),
    responseId: step.id ?? `scripted-response-${callNumber}`,
  };
}

function responseEventForStep(step: ScriptedModelStep, callNumber: number) {
  const response = responseForStep(step, callNumber);
  return {
    id: response.responseId ?? `scripted-response-${callNumber}`,
    usage: response.usage,
    output: response.output,
    providerData: response.providerData,
  };
}

function textChunks(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  return text.match(/.{1,8}/g) ?? [text];
}
