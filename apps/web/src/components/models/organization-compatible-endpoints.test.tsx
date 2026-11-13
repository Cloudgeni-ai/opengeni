import "@/app-host";
import type { ChatClient } from "@opengeni/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OrganizationCompatibleEndpoint } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useConsoleSharedQueries } from "@opengeni/react/app/lib/shared-query";
import { dollars, listPriceSummary, parseDollars, suggestedPriceBasis } from "./model-list-price";
import {
  reasoningSummary,
  useCompatibleEndpointConnection,
  useOrganizationCompatibleEndpoints,
} from "./organization-compatible-endpoints";

// The dialog renders its real form frame inline: the Radix dialog around it is a portal.
const actualFormDialog = await import("@opengeni/react/ui/form-dialog");
mock.module("@opengeni/react/ui/form-dialog", () => ({
  ...actualFormDialog,
  FormDialog: ({
    open,
    onOpenChange,
    size: _size,
    trigger,
    ...frame
  }: Parameters<typeof actualFormDialog.FormDialog>[0]) => (
    <>
      {trigger
        ? cloneElement(trigger as ReactElement<{ onClick?: () => void }>, {
            onClick: () => onOpenChange?.(true),
          })
        : null}
      {open ? (
        <div role="dialog">
          <actualFormDialog.FormFrame
            variant="inline"
            {...frame}
            onCancel={() => onOpenChange?.(false)}
          />
        </div>
      ) : null}
    </>
  ),
}));

/* ----------------------------------------------------------------------------
   A compatible endpoint model's reasoning levels: the row's summary and the
   dialog that saves them, against a mocked client.
   -------------------------------------------------------------------------- */

const endpoint: OrganizationCompatibleEndpoint = {
  id: "00000000-0000-4000-8000-0000000000e1",
  status: "active",
  version: 1,
  baseUrl: "https://inference.example.com/v1",
  api: "chat",
  label: "Inference",
  models: [
    {
      id: "00000000-0000-4000-8000-0000000000f1",
      upstreamModelId: "acme/thinker",
      label: null,
      reasoning: null,
      listPrice: null,
      listPriceKnown: false,
      version: 1,
      createdAt: "2026-11-05T00:00:00.000Z",
      updatedAt: "2026-11-05T00:00:00.000Z",
    },
  ],
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
};

let saved: unknown[] = [];
let client: ChatClient<OpenGeniBrowserClient>;

/** A client whose endpoint list reflects what was saved, like the API. */
function freshClient(): ChatClient<OpenGeniBrowserClient> {
  let current = structuredClone(endpoint);
  saved = [];
  return {
    listOrganizationCompatibleEndpoints: async () => ({
      endpoints: [current],
      priceBasisModelIds: ["gpt-6-astra", "gpt-6-sol"],
    }),
    setOrganizationCompatibleEndpointModelListPrice: async (
      _organizationId: string,
      _connectionId: string,
      _customModelId: string,
      request: { expectedVersion: number; listPrice: unknown },
    ) => {
      saved.push(request);
      const model = {
        ...current.models[0]!,
        version: current.models[0]!.version + 1,
        listPrice:
          request.listPrice as OrganizationCompatibleEndpoint["models"][number]["listPrice"],
        listPriceKnown: request.listPrice !== null,
      };
      current = { ...current, models: [model] };
      return model;
    },
    setOrganizationCompatibleEndpointModelReasoning: async (
      _organizationId: string,
      _connectionId: string,
      _customModelId: string,
      request: { expectedVersion: number; reasoning?: unknown },
    ) => {
      saved.push(request);
      const model = {
        ...current.models[0]!,
        version: current.models[0]!.version + 1,
        reasoning: (request.reasoning === undefined
          ? { efforts: ["low", "high"], defaultEffort: "high" }
          : request.reasoning) as OrganizationCompatibleEndpoint["models"][number]["reasoning"],
      };
      current = { ...current, models: [model] };
      return model;
    },
  } as unknown as ChatClient<OpenGeniBrowserClient>;
}

function Harness({ show }: { show: (node: ReactNode, detail: ReactNode) => ReactNode }) {
  useConsoleSharedQueries(client);
  const endpoints = useOrganizationCompatibleEndpoints({
    client,
    organizationId: "organization-a",
    enabled: true,
  });
  const state = useCompatibleEndpointConnection({ endpoints, connectionId: endpoint.id });
  const model = state.customModels[0];
  return model ? show(state.customModelAction?.(model), state.customModelDetail?.(model)) : null;
}

let root: Root, container: HTMLDivElement;
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  client = freshClient();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await act(async () => await Bun.sleep(10));
};

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

test("a row summarizes its reasoning levels", () => {
  expect(reasoningSummary(null)).toBe("No reasoning levels");
  expect(
    reasoningSummary({ efforts: ["none", "low", "high", "xhigh", "max"], defaultEffort: "high" }),
  ).toBe("Reasoning: None, Low, High, Extra high, Max · default High");
});

test("the reasoning dialog saves the chosen levels with the model's version", async () => {
  await act(async () =>
    root.render(
      <Harness
        show={(action, detail) => (
          <div>
            <p data-testid="detail">{detail}</p>
            {action}
          </div>
        )}
      />,
    ),
  );
  await settle();
  expect(container.querySelector("[data-testid=detail]")?.textContent).toBe(
    "No reasoning levelsNo price yet, so spend limits can’t count its usage",
  );
  await act(async () => button("Reasoning levels for acme/thinker").click());
  await settle();
  for (const level of ["None", "Low", "High", "Max"]) await act(async () => button(level).click());
  expect(button("High").getAttribute("aria-pressed")).toBe("true");
  expect(button("Medium").getAttribute("aria-pressed")).toBe("false");
  await act(async () => button("Save levels").click());
  await settle();
  expect(saved).toEqual([
    {
      expectedVersion: 1,
      // With no default chosen yet, the middle thinking level is the default.
      reasoning: { efforts: ["none", "low", "high", "max"], defaultEffort: "high" },
    },
  ]);
  expect(container.querySelector("[data-testid=detail]")?.textContent).toBe(
    "Reasoning: None, Low, High, Max · default HighNo price yet, so spend limits can’t count its usage",
  );
});

test("Read from endpoint asks the API to read the levels again", async () => {
  await act(async () => root.render(<Harness show={(action) => <div>{action}</div>} />));
  await settle();
  await act(async () => button("Reasoning levels for acme/thinker").click());
  await settle();
  await act(async () => button("Read from endpoint").click());
  await settle();
  expect(saved).toEqual([{ expectedVersion: 1 }]);
});

test("saving no levels turns reasoning off for the model", async () => {
  await act(async () => root.render(<Harness show={(action) => <div>{action}</div>} />));
  await settle();
  await act(async () => button("Reasoning levels for acme/thinker").click());
  await settle();
  await act(async () => button("Save levels").click());
  await settle();
  expect(saved).toEqual([{ expectedVersion: 1, reasoning: null }]);
});

test("the default can be changed among the chosen levels", async () => {
  await act(async () => root.render(<Harness show={(action) => <div>{action}</div>} />));
  await settle();
  await act(async () => button("Reasoning levels for acme/thinker").click());
  await settle();
  for (const level of ["Low", "High"]) await act(async () => button(level).click());
  const select = document.querySelector("select") as HTMLSelectElement;
  expect([...select.options].map((option) => option.value)).toEqual(["low", "high"]);
  await act(async () => {
    select.value = "high";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Save levels").click());
  await settle();
  expect(saved).toEqual([
    { expectedVersion: 1, reasoning: { efforts: ["low", "high"], defaultEffort: "high" } },
  ]);
});

test("a row says how its usage is priced, and never calls an unknown price free", () => {
  const model = { id: "m", upstreamModelId: "prod-reasoning", version: 1 };
  expect(listPriceSummary(model)).toBeNull();
  expect(listPriceSummary({ ...model, listPriceKnown: false, listPrice: null })).toBe(
    "No price yet, so spend limits can’t count its usage",
  );
  expect(listPriceSummary({ ...model, listPriceKnown: true, listPrice: null })).toBe(
    "Priced at its list rate",
  );
  expect(
    listPriceSummary({
      ...model,
      listPriceKnown: true,
      listPrice: { basis: "model", modelId: "gpt-6-astra" },
    }),
  ).toBe("Priced like gpt-6-astra");
  expect(
    listPriceSummary({
      ...model,
      listPriceKnown: true,
      listPrice: {
        basis: "custom",
        pricing: {
          inputMicrosPerMillionTokens: 2_500_000,
          outputMicrosPerMillionTokens: 10_000_000,
        },
      },
    }),
  ).toBe("Priced at $2.5 input · $10 output per 1M tokens");
});

test("prices are typed in dollars and a matching model name is suggested", () => {
  expect(parseDollars("2.50")).toBe(2_500_000);
  expect(parseDollars(" $0.075 ")).toBe(75_000);
  expect(parseDollars("-1")).toBeNull();
  expect(parseDollars("two")).toBeNull();
  expect(dollars(1_250_000)).toBe("$1.25");
  expect(suggestedPriceBasis("gpt-6-astra", ["gpt-6-astra"])).toBe("gpt-6-astra");
  expect(suggestedPriceBasis("gpt-6-astra-2026-03-05", ["gpt-6-astra"])).toBe("gpt-6-astra");
  expect(suggestedPriceBasis("prod-reasoning", ["gpt-6-astra"])).toBeNull();
});

test("the price dialog saves an administrator's own rate in micros", async () => {
  await act(async () =>
    root.render(
      <Harness
        show={(action, detail) => (
          <div>
            <p data-testid="detail">{detail}</p>
            {action}
          </div>
        )}
      />,
    ),
  );
  await settle();
  await act(async () => button("Price for acme/thinker").click());
  await settle();
  expect(button("Save price").disabled).toBe(true);
  await act(async () => button("Your own rate").click());
  const inputs = [...document.querySelectorAll<HTMLInputElement>("[role=dialog] input")];
  // React reads typing through its own change handler, which happy-dom's events don't reach.
  const type = async (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(
        input,
        value,
      );
      const props = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
      (input as unknown as Record<string, { onChange?: (event: unknown) => void }>)[
        props!
      ]!.onChange?.({ target: input });
    });
  await type(inputs[0]!, "2.50");
  await type(inputs[2]!, "10");
  await act(async () => button("Save price").click());
  await settle();
  expect(saved).toEqual([
    {
      expectedVersion: 1,
      listPrice: {
        basis: "custom",
        pricing: {
          inputMicrosPerMillionTokens: 2_500_000,
          outputMicrosPerMillionTokens: 10_000_000,
        },
      },
    },
  ]);
  expect(container.querySelector("[data-testid=detail]")?.textContent).toContain(
    "Priced at $2.5 input · $10 output per 1M tokens",
  );

  // Removing the price makes its usage unknown again, never free.
  await act(async () => button("Price for acme/thinker").click());
  await settle();
  await act(async () => button("Remove price").click());
  await settle();
  expect(saved.at(-1)).toEqual({ expectedVersion: 2, listPrice: null });
  expect(container.querySelector("[data-testid=detail]")?.textContent).toContain("No price yet");
});
