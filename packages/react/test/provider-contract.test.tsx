import { describe, expect, test } from "bun:test";
import { act } from "react";
import {
  OPENGENI_API_CONTRACT_REVISION,
  type StreamConnectionState,
  type WorkspaceLiveEvent,
} from "@opengeni/sdk";
import { useOpenGeni } from "../src/session-context";
import { useClientConfigFlags } from "../src/hooks/use-client-config-flags";
import { OpenGeniProvider } from "../src/provider";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

describe("OpenGeniProvider deployment contract", () => {
  test("commit hints expose capability only while the workspace stream is live", async () => {
    let deliver: ((event: WorkspaceLiveEvent) => void) | undefined;
    let state: ((state: StreamConnectionState) => void) | undefined;
    let observed: ReturnType<typeof useOpenGeni>["workspaceSessionListEvent"];
    function Observe() {
      observed = useOpenGeni().workspaceSessionListEvent;
      return null;
    }
    const client = fakeClient({
      getWorkspace: async () => ({ inferenceControl: { revision: 0 } }) as never,
      streamWorkspaceLiveEvents: (_workspaceId, options) => {
        state = options?.onStateChange;
        return (async function* () {
          while (!options?.signal?.aborted) {
            const event = await new Promise<WorkspaceLiveEvent | null>((resolve) => {
              deliver = resolve;
              options?.signal?.addEventListener("abort", () => resolve(null), { once: true });
            });
            if (event) yield event;
          }
        })();
      },
    });
    const rendered = await renderComponent(
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
        <Observe />
      </OpenGeniProvider>,
    );
    const emit = async (event?: WorkspaceLiveEvent, connection?: StreamConnectionState) => {
      await act(async () => {
        if (connection) state?.(connection);
        if (event) deliver?.(event);
      });
    };
    try {
      await flush();
      expect(observed).toBeNull();
      await emit(
        {
          type: "workspace.sessions.changed",
          workspaceId: WORKSPACE_ID,
          available: true,
          sessionIds: null,
        },
        "live",
      );
      expect(observed).toMatchObject({ available: true, sessionIds: null });
      await emit(undefined, "connecting");
      expect(observed).toBeNull();
      await emit(
        {
          type: "workspace.sessions.changed",
          workspaceId: WORKSPACE_ID,
          available: true,
          sessionIds: ["changed-session"],
        },
        "live",
      );
      expect(observed?.sessionIds).toEqual(["changed-session"]);
      await emit({
        type: "workspace.sessions.changed",
        workspaceId: "other-workspace",
        available: true,
        sessionIds: ["hidden"],
      });
      expect(observed?.sessionIds).toEqual(["changed-session"]);
      await emit({
        type: "workspace.sessions.changed",
        workspaceId: WORKSPACE_ID,
        available: false,
        sessionIds: null,
      });
      expect(observed?.available).toBe(false);
    } finally {
      await rendered.unmount();
    }
  });

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

  test("the stock console opt-in blocks stale clients with reload guidance before reconnect", async () => {
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
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID} reloadOnApiContractChange>
        <div>stale child</div>
      </OpenGeniProvider>,
    );
    await flush();

    const screen = rendered.container.querySelector<HTMLElement>(
      "[data-opengeni-api-contract-mismatch]",
    );
    expect(screen).not.toBeNull();
    expect(screen?.textContent).toContain("Opengeni updated");
    expect(screen?.textContent).toContain(`Client ${OPENGENI_API_CONTRACT_REVISION}`);
    expect(screen?.textContent).toContain(`API ${actual}`);
    expect(workspaceReads).toBe(0);

    await rendered.unmount();
    sessionStorage.removeItem(`opengeni.reloadForApiContract:${actual}`);
  });

  test("embedded hosts are never blocked or reloaded when Opengeni changes its contract", async () => {
    const actual = "future-contract-embedded";
    let workspaceReads = 0;
    const client = fakeClient({
      getClientConfig: async () => ({ apiContractRevision: actual }) as never,
      getWorkspace: async () => {
        workspaceReads += 1;
        return { inferenceControl: { revision: 0 } } as never;
      },
      streamWorkspaceLiveEvents: (_workspaceId, options) =>
        (async function* () {
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          yield* [];
        })(),
    });
    const rendered = await renderComponent(
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
        <div>host child</div>
      </OpenGeniProvider>,
    );
    await flush(200);
    expect(rendered.container.querySelector("[data-opengeni-api-contract-mismatch]")).toBeNull();
    expect(sessionStorage.getItem(`opengeni.reloadForApiContract:${actual}`)).toBeNull();
    expect(rendered.container.textContent).toContain("host child");
    expect(workspaceReads).toBe(1);
    await rendered.unmount();
  });

  test("the contract check and the conversation flags share one config read", async () => {
    let configReads = 0;
    let release: (() => void) | undefined;
    const client = fakeClient({
      getClientConfig: async () => {
        configReads += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { apiContractRevision: OPENGENI_API_CONTRACT_REVISION } as never;
      },
      getWorkspace: async () => ({ inferenceControl: { revision: 0 } }) as never,
      streamWorkspaceLiveEvents: (_workspaceId, options) =>
        (async function* () {
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          yield* [];
        })(),
    });
    function Flags() {
      const flags = useClientConfigFlags(client);
      return <div>{flags.loaded ? "flags loaded" : "flags loading"}</div>;
    }
    const rendered = await renderComponent(
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
        <Flags />
      </OpenGeniProvider>,
    );
    await flush();
    expect(configReads).toBe(1);
    release?.();
    await flush(50);
    expect(rendered.container.textContent).toContain("flags loaded");
    expect(configReads).toBe(1);
    await rendered.unmount();
  });
});
