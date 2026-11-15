import type { ClientModel } from "@opengeni/sdk";
import type { ModelLevel } from "../../src/model-levels";

/** A runnable catalog model with low/medium/high effort and optional Ultrafast. */
export function levelModel(
  id: string,
  shortLabel: string,
  ultrafast: boolean,
  source = "codex",
): ClientModel {
  return {
    id,
    label: `${shortLabel} Model`,
    shortLabel,
    provider: source,
    providerLabel: source === "codex" ? "Codex" : source,
    source,
    api: "responses",
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        required: false,
      },
      functionCalling: { upstream: "supported", runnable: true },
      structuredOutput: { upstream: "supported", runnable: true },
      hostedTools: {
        webSearch: { upstream: "unsupported", runnable: false },
        xSearch: { upstream: "unsupported", runnable: false },
        codeExecution: { upstream: "unsupported", runnable: false },
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      transports: {
        sse: { upstream: "supported", runnable: true },
        responsesWebSocket: { upstream: "unsupported", runnable: false },
        realtimeAudio: { upstream: "unsupported", runnable: false },
      },
      latencyModes: [
        { id: "standard", upstream: "supported", runnable: true },
        ...(ultrafast
          ? [{ id: "ultrafast" as const, upstream: "supported" as const, runnable: true }]
          : []),
      ],
    },
  } as ClientModel;
}

/** Two levels over three models: only "Deep" can run Ultrafast. */
export const LEVEL_MODELS: ClientModel[] = [
  levelModel("codex/everyday", "Everyday", false),
  levelModel("codex/deep", "Deep", true),
  levelModel("codex/small", "Small", false),
];

export const LEVELS: ModelLevel[] = [
  { id: "standard", label: "Standard", model: "codex/everyday", effort: "high" },
  { id: "thorough", label: "Thorough", model: "codex/deep", effort: "high", ultrafast: true },
];
