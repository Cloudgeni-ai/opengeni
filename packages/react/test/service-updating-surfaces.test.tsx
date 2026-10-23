/* ----------------------------------------------------------------------------
   What people see while Opengeni is updating: the composer shows one calm
   "updating" line (no red error, no Reference), the queue chip does not ask
   for attention, and both surface a real problem only when the failure is
   definitive or outlasts a normal update.
   -------------------------------------------------------------------------- */
import { afterEach, describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import { ChatComposer } from "../src/components/chat-composer";
import { SessionChrome } from "../src/components/session-chrome";
import type { ComposerState } from "../src/hooks/use-composer";
import type { UseTurnQueueResult } from "../src/hooks/use-turn-queue";
import { SERVICE_UPDATING_CALM_WINDOW_MS } from "../src/lib/transient-retry";
import { fakeTurn } from "./fake-client";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom({ clock: "virtual" });

const UPDATING = "Opengeni is updating. We'll reconnect automatically.";
const parked = () =>
  new OpenGeniApiError(503, JSON.stringify({ error: "maintenance" }), {
    mutation: true,
    correlationId: "ingress-1",
  });
const unavailable = () =>
  new OpenGeniApiError(503, "", { mutation: false, correlationId: "edge-1" });

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
});

function composer(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    value: "",
    setValue: () => {},
    hasDraftContent: () => false,
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: true,
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
  return {
    snapshot: null,
    queue: [fakeTurn({ id: "11111111-1111-4111-8111-111111111111", prompt: "queued prompt" })],
    pendingInputs: [],
    pendingInputAttachment: null,
    effectiveControl: null,
    stoppingPreviousAttempt: false,
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
    activePersonalConnections: [],
    ...overrides,
  } as UseTurnQueueResult;
}

function updatingLine(root: HTMLElement): HTMLElement | null {
  return root.querySelector('[data-og-composer-status="updating"]');
}

/** Live-region text (not animated, unlike the visible line's exit). */
function announced(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".sr-only p")].map((node) => node.textContent ?? "");
}

function failedLines(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".text-og-status-failed")].map((node) => node.textContent ?? "");
}

describe("composer while Opengeni is updating", () => {
  test("the maintenance marker shows one calm line, never a red error or Reference", async () => {
    mounted = await renderComponent(<ChatComposer composer={composer({ error: parked() })} />);
    await flush(10);
    const root = mounted.container;
    expect(updatingLine(root)?.textContent).toBe(UPDATING);
    expect(updatingLine(root)?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(failedLines(root)).toEqual([]);
    expect(root.textContent).not.toContain("Reference");
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect([...root.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toContain(
      UPDATING,
    );
    // However long the update lasts.
    await flush(30 * 60_000);
    expect(updatingLine(root)?.textContent).toBe(UPDATING);
    expect(failedLines(root)).toEqual([]);
  });

  test("a reconnecting send or stream shows the same line and it clears on recovery", async () => {
    mounted = await renderComponent(<ChatComposer composer={composer({ reconnecting: true })} />);
    await flush(10);
    expect(updatingLine(mounted.container)?.textContent).toBe(UPDATING);
    expect(announced(mounted.container)).toEqual([UPDATING]);
    await mounted.rerender(<ChatComposer composer={composer({ reconnecting: false })} />);
    await flush(1_000);
    expect(announced(mounted.container)).toEqual([]);
  });

  test("a transient failure stays calm for an update window, then shows its error", async () => {
    const error = unavailable();
    mounted = await renderComponent(<ChatComposer composer={composer({ error })} />);
    await flush(10);
    expect(updatingLine(mounted.container)?.textContent).toBe(UPDATING);
    expect(failedLines(mounted.container)).toEqual([]);
    await flush(SERVICE_UPDATING_CALM_WINDOW_MS);
    expect(announced(mounted.container)).not.toContain(UPDATING);
    const [line] = failedLines(mounted.container);
    expect(line).toContain("temporarily unavailable");
    expect(line).toContain("Reference: edge-1");
  });

  test("a definitive error stays red at once", async () => {
    const error = new OpenGeniApiError(
      400,
      JSON.stringify({ error: { code: "invalid_request", message: "That model is not allowed" } }),
      { mutation: true },
    );
    mounted = await renderComponent(<ChatComposer composer={composer({ error })} />);
    await flush(10);
    expect(updatingLine(mounted.container)).toBeNull();
    expect(failedLines(mounted.container)).toHaveLength(1);
    expect(mounted.container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe("queue chip while Opengeni is updating", () => {
  test("a transient queue read failure does not ask for attention until it lasts", async () => {
    mounted = await renderComponent(<SessionChrome queue={queue({ error: unavailable() })} />);
    await flush(10);
    expect(mounted.container.textContent).toContain("1 queued");
    expect(mounted.container.textContent).not.toContain("needs attention");
    await flush(SERVICE_UPDATING_CALM_WINDOW_MS);
    expect(mounted.container.textContent).toContain("needs attention");
  });

  test("the maintenance marker never asks for attention", async () => {
    const error = new OpenGeniApiError(503, JSON.stringify({ error: "maintenance" }), {
      mutation: false,
    });
    mounted = await renderComponent(<SessionChrome queue={queue({ error })} />);
    await flush(30 * 60_000);
    expect(mounted.container.textContent).toContain("1 queued");
    expect(mounted.container.textContent).not.toContain("needs attention");
  });

  test("a definitive queue failure asks for attention at once", async () => {
    const error = new OpenGeniApiError(403, "", { mutation: false });
    mounted = await renderComponent(<SessionChrome queue={queue({ error })} />);
    await flush(10);
    expect(mounted.container.textContent).toContain("needs attention");
  });
});
