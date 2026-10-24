import { describe, expect, test } from "bun:test";

import type { EventSource, EventTrigger } from "@opengeni/sdk";

import { EventTriggerSummary } from "../src/automations";
import { registerDom, renderComponent } from "./render-hook";

registerDom();

const SOURCE_ID = "8f0c2a4e-0d55-4b8e-9d55-1a2b3c4d5e6f";

const source = {
  id: SOURCE_ID,
  workspaceId: "3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d",
  kind: "github",
  adapter: null,
  name: "Acme GitHub",
  ownerSubjectId: null,
  visibility: "workspace",
  status: "active",
  statusReason: null,
  webhookUrl: null,
  awaitingSigningSecret: false,
  mcp: null,
  lastDeliveryAt: null,
  createdAt: "2026-10-23T10:00:00.000Z",
  updatedAt: "2026-10-23T10:00:00.000Z",
} as EventSource;

function trigger(overrides: Partial<EventTrigger> = {}): EventTrigger {
  return {
    id: "0e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b",
    sourceId: SOURCE_ID,
    sourceKind: "github",
    eventTypes: ["pull_request.opened"],
    conditions: [{ field: "data.repository", op: "equals", value: "acme/api" }],
    includeOwnEvents: false,
    arguments: null,
    status: "active",
    statusReason: null,
    createdAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    ...overrides,
  };
}

describe("EventTriggerSummary", () => {
  test("reads each trigger as its events, where they come from and when", async () => {
    const opened: string[] = [];
    const view = await renderComponent(
      <EventTriggerSummary
        triggers={[trigger()]}
        sources={[source]}
        sourceHref={(id) => `/sources/${id}`}
        onOpenSource={(id, event) => {
          event.preventDefault();
          opened.push(id);
        }}
      />,
    );
    const items = view.container.querySelectorAll("li");
    expect(items).toHaveLength(1);
    expect([...(items[0]?.querySelectorAll("p") ?? [])].map((line) => line.textContent)).toEqual([
      "pull_request.opened",
      "From Acme GitHub, only when data.repository is acme/api",
    ]);
    const link = view.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(`/sources/${SOURCE_ID}`);
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(opened).toEqual([SOURCE_ID]);
    await view.unmount();
  });

  test("a source the viewer can't see reads in lower case, without a link", async () => {
    const view = await renderComponent(
      <EventTriggerSummary
        triggers={[trigger({ conditions: [] })]}
        sources={[]}
        sourceHref={(id) => `/sources/${id}`}
      />,
    );
    expect(view.container.textContent).toContain("From a source you can't see");
    expect(view.container.querySelector("a")).toBeNull();
    await view.unmount();
  });

  test("a held trigger says why next to its line", async () => {
    const view = await renderComponent(
      <EventTriggerSummary
        triggers={[
          trigger({ status: "blocked", statusReason: "The GitHub connection was removed." }),
        ]}
        sources={[source]}
      />,
    );
    expect(view.container.textContent).toContain("Needs attention");
    expect(view.container.querySelector("a")).toBeNull();
    await view.unmount();
  });
});
