import { describe, expect, test } from "bun:test";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { OpenGeniProvider } from "../src/provider";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

describe("OpenGeniProvider deployment contract", () => {
  test("uses one multiplexed workspace stream when the SDK exposes it", async () => {
    let liveStreams = 0;
    let legacyControlStreams = 0;
    let legacyInteractionStreams = 0;
    const controlEvents: number[] = [];
    const interactionEvents: number[] = [];
    const client = fakeClient({
      getWorkspace: async () => ({ inferenceControl: { revision: 4 } }) as never,
      streamWorkspaceLiveEvents: (_workspaceId, options) => {
        liveStreams += 1;
        return (async function* () {
          yield {
            id: "00000000-0000-4000-8000-000000000001",
            workspaceId: WORKSPACE_ID,
            sequence: 5,
            revision: 5,
            type: "workspace.control.changed" as const,
            scope: "workspace" as const,
            rootSessionId: null,
            action: "pause" as const,
            automatic: false,
            reason: null,
            actor: "operator" as const,
            occurredAt: "2026-08-13T00:00:00.000Z",
          };
          yield {
            workspaceId: WORKSPACE_ID,
            sequence: 8,
            revision: 8,
            type: "workspace.interaction.changed" as const,
            occurredAt: "2026-08-13T00:00:00.000Z",
          };
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        })();
      },
      streamWorkspaceControlEvents: () => {
        legacyControlStreams += 1;
        throw new Error("legacy control stream should not open");
      },
      streamWorkspaceInteractionRevisions: () => {
        legacyInteractionStreams += 1;
        throw new Error("legacy interaction stream should not open");
      },
    });
    const rendered = await renderComponent(
      <OpenGeniProvider
        client={client}
        workspaceId={WORKSPACE_ID}
        onWorkspaceControlEvent={(event) => controlEvents.push(event.sequence)}
        onWorkspaceInteractionEvent={(event) => interactionEvents.push(event.sequence)}
      >
        <div>live child</div>
      </OpenGeniProvider>,
    );
    await flush(10);

    expect(liveStreams).toBe(1);
    expect(legacyControlStreams).toBe(0);
    expect(legacyInteractionStreams).toBe(0);
    expect(controlEvents).toEqual([5]);
    expect(interactionEvents).toEqual([8]);
    await rendered.unmount();
  });

  test("blocks stale embedded clients with explicit reload guidance before reconnect", async () => {
    const actual = "future-contract";
    sessionStorage.setItem(
      `opengeni.reloadForApiContract:${actual}`,
      OPENGENI_API_CONTRACT_REVISION,
    );
    let workspaceReads = 0;
    const client = fakeClient({
      getClientConfig: async () => ({ apiContractRevision: actual }) as never,
      getWorkspace: async () => {
        workspaceReads += 1;
        return {} as never;
      },
    });
    const rendered = await renderComponent(
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
        <div>stale child</div>
      </OpenGeniProvider>,
    );
    await flush();

    const screen = rendered.container.querySelector<HTMLElement>(
      "[data-opengeni-api-contract-mismatch]",
    );
    expect(screen).not.toBeNull();
    expect(screen?.textContent).toContain("OpenGeni updated");
    expect(screen?.textContent).toContain(`Client ${OPENGENI_API_CONTRACT_REVISION}`);
    expect(screen?.textContent).toContain(`API ${actual}`);
    expect(workspaceReads).toBe(0);

    await rendered.unmount();
    sessionStorage.removeItem(`opengeni.reloadForApiContract:${actual}`);
  });
});
