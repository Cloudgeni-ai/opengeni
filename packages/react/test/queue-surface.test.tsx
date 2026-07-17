import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";

import { QueueSurface } from "../src/components/queue-surface";
import type { ComposerState } from "../src/hooks/use-composer";
import type { UseTurnQueueResult } from "../src/hooks/use-turn-queue";
import { fakeTurn } from "./fake-client";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
  document.body.replaceChildren();
});

function composer(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    value: "",
    setValue: () => {},
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: false,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    applyDraft: () => {},
    reloadDraft: async () => {},
    resolveDraftConflict: async () => {},
    restoredResources: [],
    removeRestoredResource: () => {},
    error: null,
    clearError: () => {},
    ...overrides,
  };
}

function queue(overrides: Partial<UseTurnQueueResult> = {}): UseTurnQueueResult {
  const items = [
    fakeTurn({ id: "11111111-1111-4111-8111-111111111111", prompt: "first queued prompt" }),
    fakeTurn({ id: "22222222-2222-4222-8222-222222222222", prompt: "second queued prompt" }),
  ];
  return {
    snapshot: null,
    queue: items,
    effectiveControl: null,
    loading: false,
    error: null,
    refresh: async () => {},
    moveTurn: async () => true,
    editTurn: async () => null,
    steerTurn: async () => true,
    removeTurn: async () => true,
    pendingByTurn: {},
    mutationFor: () => null,
    mutating: false,
    mutationError: null,
    clearMutationError: () => {},
    ...overrides,
  };
}

async function click(target: Element | null): Promise<void> {
  expect(target).not.toBeNull();
  await act(async () => {
    (target as HTMLElement).click();
    await Promise.resolve();
  });
}

describe("QueueSurface", () => {
  test("is the one compact queue and exposes visible row Steer and Delete actions", async () => {
    const calls: string[] = [];
    const state = queue({
      steerTurn: async (turnId) => {
        calls.push(`steer:${turnId}`);
        return true;
      },
      removeTurn: async (turnId) => {
        calls.push(`delete:${turnId}`);
        return true;
      },
    });
    mounted = await renderComponent(<QueueSurface queue={state} composer={composer()} />);

    expect(mounted.container.textContent).toContain("2 queued prompts");
    expect(mounted.container.querySelector('[aria-label="Queued prompts"]')).toBeNull();
    await click(mounted.container.querySelector('button[aria-expanded="false"]'));
    expect(mounted.container.querySelectorAll("[data-queue-turn-id]")).toHaveLength(2);

    await click(mounted.container.querySelector('button[aria-label="Steer queued prompt 2"]'));
    await click(mounted.container.querySelector('button[aria-label="Delete queued prompt 1"]'));
    expect(calls).toEqual([
      "steer:22222222-2222-4222-8222-222222222222",
      "delete:11111111-1111-4111-8111-111111111111",
    ]);
    expect(mounted.container.textContent).toContain("Queued prompt deleted.");
  });

  test("renders the same authoritative queue without mutation affordances for read-only consumers", async () => {
    mounted = await renderComponent(<QueueSurface queue={queue()} readOnly />);

    expect(mounted.container.textContent).toContain("Read-only");
    await click(mounted.container.querySelector('button[aria-expanded="false"]'));
    expect(mounted.container.querySelectorAll('[aria-label^="Steer queued prompt"]')).toHaveLength(
      0,
    );
    expect(mounted.container.querySelectorAll('[aria-label^="Delete queued prompt"]')).toHaveLength(
      0,
    );
    expect(mounted.container.textContent).toContain("first queued prompt");
    expect(mounted.container.textContent).toContain("second queued prompt");
  });
});
