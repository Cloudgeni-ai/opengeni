import { expect, test } from "bun:test";
import type { WorkspaceInteractionRevisionEvent } from "@opengeni/sdk";
import { useCallback } from "react";
import { useInteractionInvalidation } from "../src/hooks/use-interaction-invalidation";
import { flush, registerDom, renderHook } from "./render-hook";

registerDom();

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function event(sequence: number): WorkspaceInteractionRevisionEvent {
  return {
    workspaceId: WORKSPACE_ID,
    sequence,
    revision: sequence,
    type: "workspace.interaction.changed",
    occurredAt: "2026-08-10T00:00:00.000Z",
  };
}

test("interaction invalidation refreshes only catalogs older than the shared cursor", async () => {
  let refreshes = 0;
  const hook = await renderHook<
    void,
    { knownRevision: number; event: WorkspaceInteractionRevisionEvent | null }
  >(
    (props: { knownRevision: number; event: WorkspaceInteractionRevisionEvent | null }) => {
      const refresh = useCallback(async () => {
        refreshes += 1;
      }, []);
      useInteractionInvalidation({
        workspaceId: WORKSPACE_ID,
        key: WORKSPACE_ID,
        enabled: true,
        event: props.event,
        connectionState: "live",
        knownRevision: props.knownRevision,
        refresh,
      });
    },
    { knownRevision: 1, event: null },
  );

  await hook.rerender({ knownRevision: 1, event: event(3) });
  await flush(5);
  expect(refreshes).toBe(1);

  await hook.rerender({ knownRevision: 3, event: event(3) });
  await flush(5);
  expect(refreshes).toBe(1);

  await hook.rerender({ knownRevision: 3, event: event(8) });
  await flush(5);
  expect(refreshes).toBe(2);
  await hook.unmount();
});

test("unversioned live lists consume each workspace invalidation once per filter", async () => {
  let refreshes = 0;
  const hook = await renderHook<
    void,
    { key: string; event: WorkspaceInteractionRevisionEvent | null }
  >(
    (props: { key: string; event: WorkspaceInteractionRevisionEvent | null }) => {
      const refresh = useCallback(async () => {
        refreshes += 1;
      }, []);
      useInteractionInvalidation({
        workspaceId: WORKSPACE_ID,
        key: props.key,
        enabled: true,
        event: props.event,
        connectionState: "live",
        refresh,
      });
    },
    { key: "open", event: null },
  );

  await hook.rerender({ key: "open", event: event(5) });
  await hook.rerender({ key: "open", event: event(5) });
  expect(refreshes).toBe(1);
  await hook.rerender({ key: "settled", event: event(5) });
  expect(refreshes).toBe(2);
  await hook.unmount();
});
