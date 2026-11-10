import "@/app-host";
import type { ChatClient } from "@opengeni/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OrganizationCompatibleEndpoint } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useConsoleSharedQueries } from "@opengeni/react/app/lib/shared-query";
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
    listOrganizationCompatibleEndpoints: async () => ({ endpoints: [current] }),
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
  expect(container.querySelector("[data-testid=detail]")?.textContent).toBe("No reasoning levels");
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
    "Reasoning: None, Low, High, Max · default High",
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
