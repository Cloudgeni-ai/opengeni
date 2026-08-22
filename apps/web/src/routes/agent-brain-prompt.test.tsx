import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LatencyMode, ReasoningEffort, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { resolveAgentBrainPromptModel } from "@/lib/agent-brain-prompt-model";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const supported = { upstream: "supported", runnable: true } as const;
const unsupported = { upstream: "unsupported", runnable: false } as const;

function catalogModel(
  id: string,
  overrides: {
    selectable?: boolean;
    source?: WorkspaceModelCatalogModel["source"];
    efforts?: ReasoningEffort[];
    defaultEffort?: ReasoningEffort | null;
    latencyModes?: Array<{ id: LatencyMode; runnable: boolean }>;
  } = {},
): WorkspaceModelCatalogModel {
  const selectable = overrides.selectable ?? true;
  const source =
    overrides.source ??
    (id.startsWith("codex/") ? "codex" : id.startsWith("supergrok/") ? "supergrok" : "opengeni");
  return {
    id,
    label: id === "gpt-5.5" ? "GPT-5.5" : id === "codex/gpt-5.6-luna" ? "GPT-5.6 Luna" : id,
    provider: source,
    providerLabel: source === "codex" ? "Codex" : source === "supergrok" ? "SuperGrok" : "OpenGeni",
    source,
    api: "responses",
    credentialReadiness: {
      status: "ready",
      reason: null,
      basis: "configuration",
      checkedAt: null,
    },
    policyAllowed: selectable,
    availability: {
      status: selectable ? "available" : "unavailable",
      selectable,
      reason: selectable ? null : "policy_blocked",
      checkedAt: null,
    },
    ...(overrides.efforts || overrides.latencyModes
      ? {
          capabilities: {
            reasoning: {
              upstream: "supported",
              runnable: true,
              efforts: overrides.efforts ?? ["low", "medium", "high"],
              defaultEffort: overrides.defaultEffort ?? "medium",
              required: false,
            },
            functionCalling: supported,
            structuredOutput: supported,
            hostedTools: {
              webSearch: unsupported,
              xSearch: unsupported,
              codeExecution: unsupported,
            },
            inputModalities: ["text"],
            outputModalities: ["text"],
            transports: {
              sse: supported,
              responsesWebSocket: unsupported,
              realtimeAudio: unsupported,
            },
            latencyModes: (overrides.latencyModes ?? [{ id: "standard", runnable: true }]).map(
              (mode) => ({ ...mode, upstream: mode.runnable ? "supported" : "unsupported" }),
            ),
          } satisfies NonNullable<WorkspaceModelCatalogModel["capabilities"]>,
        }
      : {}),
  };
}

describe("resolveAgentBrainPromptModel", () => {
  test("keeps the preferred model when the workspace catalog marks it selectable", () => {
    const models = [catalogModel("gpt-5.6-sol"), catalogModel("codex/gpt-5.6-luna")];
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        latencyMode: "standard",
      }),
    ).toEqual({
      model: "gpt-5.6-sol",
      label: "gpt-5.6-sol",
      paymentSource: "OpenGeni credits",
      reasoningEffort: "low",
      latencyMode: "standard",
    });
  });

  test("falls back to the first selectable catalog model when the preferred model is blocked", () => {
    const models = [
      catalogModel("gpt-5.6-sol", { selectable: false }),
      catalogModel("codex/gpt-5.6-luna"),
      catalogModel("supergrok/grok-4"),
    ];
    const selection = resolveAgentBrainPromptModel(models, {
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      latencyMode: "standard",
    });
    expect(selection?.model).toBe("codex/gpt-5.6-luna");
  });

  test("falls back when the preferred model is absent from the catalog", () => {
    const models = [catalogModel("codex/gpt-5.6-luna")];
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "legacy-model",
        reasoningEffort: "low",
        latencyMode: "standard",
      })?.model,
    ).toBe("codex/gpt-5.6-luna");
  });

  test("returns null when no row is selectable", () => {
    const models = [
      catalogModel("gpt-5.6-sol", { selectable: false }),
      catalogModel("codex/gpt-5.6-luna", { selectable: false }),
    ];
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        latencyMode: "standard",
      }),
    ).toBeNull();
    expect(
      resolveAgentBrainPromptModel([], {
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        latencyMode: "standard",
      }),
    ).toBeNull();
  });

  test("coerces reasoning effort and latency mode to what the chosen model supports", () => {
    const models = [
      catalogModel("codex/gpt-5.6-luna", {
        efforts: ["medium", "high"],
        defaultEffort: "high",
        latencyModes: [
          { id: "standard", runnable: true },
          { id: "fast", runnable: false },
        ],
      }),
    ];
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        latencyMode: "fast",
      }),
    ).toEqual({
      model: "codex/gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      paymentSource: "Codex subscription",
      reasoningEffort: "high",
      latencyMode: "standard",
    });
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "codex/gpt-5.6-luna",
        reasoningEffort: "medium",
        latencyMode: "standard",
      }),
    ).toEqual({
      model: "codex/gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      paymentSource: "Codex subscription",
      reasoningEffort: "medium",
      latencyMode: "standard",
    });
  });

  test("keeps a non-standard latency mode only when the chosen model can run it", () => {
    const models = [
      catalogModel("codex/gpt-5.6-luna", {
        efforts: ["low"],
        latencyModes: [
          { id: "standard", runnable: true },
          { id: "priority", runnable: true },
        ],
      }),
    ];
    expect(
      resolveAgentBrainPromptModel(models, {
        model: "codex/gpt-5.6-luna",
        reasoningEffort: "low",
        latencyMode: "priority",
      })?.latencyMode,
    ).toBe("priority");
  });
});

/* ---------------------------------------------------------------------------
   Component render: the submit button stays disabled while the catalog loads,
   enables once a selectable row arrives, and the start request carries the
   resolved model instead of the blocked app-context default.
   ------------------------------------------------------------------------- */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const catalogRequest = deferred<{ models: WorkspaceModelCatalogModel[] }>();
const getWorkspaceModelCatalog = mock(async (_workspaceId: string) => catalogRequest.promise);
const startSession = mock(
  async (_workspaceId: string, _submission: Record<string, unknown>, _options: unknown) => ({
    id: "00000000-0000-4000-8000-000000000099",
  }),
);
const navigate = mock(async (_target: unknown) => undefined);

const appContext: Record<string, any> = {
  client: { getWorkspaceModelCatalog },
  model: "gpt-5.5",
  reasoningEffort: "low",
  latencyMode: "standard",
  busy: false,
  startSession,
};

mock.module("@/context", () => ({
  useAppContext: () => appContext,
}));
mock.module("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

const { AgentBrainPrompt } = await import("./agent-brain-prompt");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  startSession.mockClear();
  navigate.mockClear();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function setValue(element: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = Object.getPrototypeOf(element) as object;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    const reactPropsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const onChange = reactPropsKey
      ? (
          element as unknown as Record<
            string,
            { onChange?: (event: { target: typeof element }) => void }
          >
        )[reactPropsKey]?.onChange
      : undefined;
    if (onChange) {
      onChange({ target: element });
    } else {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await Promise.resolve();
  });
}

describe("AgentBrainPrompt", () => {
  test("waits for the workspace catalog and starts with a workspace-selectable model", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<AgentBrainPrompt kind="workspace_instructions" workspaceId={workspaceId} />);
    });
    await settle();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const button = container.querySelector("button[type=submit]") as HTMLButtonElement;
    await setValue(textarea, "Keep updates concise.");
    expect(button.disabled).toBe(true);

    catalogRequest.resolve({
      models: [
        catalogModel("gpt-5.5", { selectable: false }),
        catalogModel("codex/gpt-5.6-luna", { source: "codex" }),
      ],
    });
    await settle();
    expect(button.disabled).toBe(false);
    expect(container.textContent).not.toContain("No model is available");
    expect(container.textContent).toContain("Model: GPT-5.6 Luna · Codex subscription");
    expect(container.textContent).not.toContain("GPT-5.5");

    await act(async () => {
      (container.querySelector("form") as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(startSession).toHaveBeenCalledTimes(1);
    const [calledWorkspaceId, submission, options] = startSession.mock.calls[0]!;
    expect(calledWorkspaceId).toBe(workspaceId);
    expect(submission.model).toBe("codex/gpt-5.6-luna");
    expect(submission.reasoningEffort).toBe("low");
    expect(submission.latencyMode).toBe("standard");
    expect(String(submission.text)).toContain("Keep updates concise.");
    expect(options).toEqual(expect.objectContaining({ instructions: expect.any(String) }));
    expect(navigate).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test("shows the no-model message and keeps the button disabled when nothing is selectable", async () => {
    getWorkspaceModelCatalog.mockImplementationOnce(async () => ({
      models: [catalogModel("gpt-5.6-sol", { selectable: false })],
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<AgentBrainPrompt kind="company_profile" workspaceId={workspaceId} />);
    });
    await settle();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const button = container.querySelector("button[type=submit]") as HTMLButtonElement;
    await setValue(textarea, "We build agents.");
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("No model is available for this workspace.");
    expect(container.textContent).not.toContain("Could not load the workspace model catalog");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test("fails closed with a retry control when the allowed model cannot be resolved", async () => {
    getWorkspaceModelCatalog.mockImplementationOnce(async () => {
      throw new Error("catalog unavailable");
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<AgentBrainPrompt kind="preference" workspaceId={workspaceId} />);
    });
    await settle();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const button = container.querySelector("button[type=submit]") as HTMLButtonElement;
    await setValue(textarea, "Lead with the outcome.");
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Could not resolve an allowed workspace model: catalog unavailable. Retry before creating with OpenGeni.",
    );
    expect(container.textContent).not.toContain("No model is available");

    await act(async () => {
      (container.querySelector("form") as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(startSession).not.toHaveBeenCalled();

    // Retry re-fetches the catalog; a successful reload clears the error and
    // switches to the catalog-resolved model.
    const callsBeforeRetry = getWorkspaceModelCatalog.mock.calls.length;
    getWorkspaceModelCatalog.mockImplementationOnce(async () => ({
      models: [
        catalogModel("gpt-5.5", { selectable: false }),
        catalogModel("codex/gpt-5.6-luna", { source: "codex" }),
      ],
    }));
    const retry = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Retry",
    ) as HTMLButtonElement;
    expect(retry).toBeDefined();
    await act(async () => {
      retry.click();
    });
    await settle();
    expect(getWorkspaceModelCatalog.mock.calls.length).toBe(callsBeforeRetry + 1);
    expect(container.textContent).not.toContain("Could not resolve an allowed workspace model");
    expect(container.textContent).toContain("Model: GPT-5.6 Luna · Codex subscription");
    expect(button.disabled).toBe(false);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
