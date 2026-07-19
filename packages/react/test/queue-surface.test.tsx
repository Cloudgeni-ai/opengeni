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

  test("bounds hostile prompt previews and discloses the exact source only on demand", async () => {
    const prompt = [
      "# Multiline prompt 👩🏽‍💻",
      "```sh",
      `curl https://example.test/${"unbroken".repeat(300)}`,
      "```",
      `Bidirectional source: ${String.fromCodePoint(0x202e)}isolated${String.fromCodePoint(0x202c)}`,
      "Exact trailing line.",
    ].join("\n");
    const state = queue({
      queue: [
        fakeTurn({
          id: "33333333-3333-4333-8333-333333333333",
          prompt,
        }),
      ],
    });
    mounted = await renderComponent(<QueueSurface queue={state} composer={composer()} />);

    const collapsed = mounted.container.querySelector('[data-testid="queue-collapsed-preview"]');
    const collapsedToggle = mounted.container.querySelector('button[aria-expanded="false"]');
    expect(collapsed?.getAttribute("aria-hidden")).toBe("true");
    expect(collapsedToggle?.getAttribute("aria-description")).toBe(collapsed?.textContent);
    expect(collapsedToggle?.getAttribute("aria-describedby")).toBeNull();
    expect(collapsedToggle?.getAttribute("aria-label")).toBe("1 queued prompt");
    expect(collapsed?.textContent).toContain(" … ");
    expect(collapsed?.textContent).toContain("Exact trailing line.");
    expect(Array.from(collapsed?.textContent ?? "").length).toBeLessThanOrEqual(180);
    expect(collapsed?.textContent).not.toBe(prompt);

    await click(collapsedToggle);
    const preview = mounted.container.querySelector('[data-testid="queue-prompt-preview-1"]');
    expect(preview?.classList.contains("line-clamp-1")).toBe(true);
    expect(preview?.classList.contains("sm:line-clamp-3")).toBe(true);
    expect(preview?.classList.contains("break-all")).toBe(true);
    expect(preview?.getAttribute("aria-hidden")).toBeNull();
    expect(preview?.getAttribute("role")).toBe("note");
    expect(preview?.getAttribute("dir")).toBe("auto");
    expect(preview?.textContent).toContain(" … ");
    expect(preview?.querySelector('[aria-hidden="true"]')?.textContent).toBe(preview?.textContent);
    expect(preview?.textContent).not.toBe(prompt);
    expect(preview?.getAttribute("aria-label")).toBe(
      `Queued prompt 1 summary: ${preview?.textContent}`,
    );
    expect(mounted.container.querySelector('[data-testid="queue-prompt-full-1"]')).toBeNull();

    const disclosure = mounted.container.querySelector(
      'button[aria-label="Show full content for queued prompt 1"]',
    );
    await click(disclosure);
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");

    const full = mounted.container.querySelector('[data-testid="queue-prompt-full-1"]');
    expect(full?.textContent).toBe(prompt);
    expect(full?.getAttribute("role")).toBe("region");
    expect(full?.getAttribute("aria-label")).toBe("Full content for queued prompt 1");
    expect(full?.getAttribute("tabindex")).toBe("0");
    expect(full?.getAttribute("dir")).toBe("auto");
    expect(full?.classList.contains("max-h-64")).toBe(true);
    expect(full?.classList.contains("max-w-full")).toBe(true);
    expect(full?.classList.contains("overflow-auto")).toBe(true);
    expect(full?.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(full?.classList.contains("break-all")).toBe(true);
    expect(mounted.container.textContent).toContain("Full content for queued prompt 1 shown.");

    await click(disclosure);
    expect(mounted.container.querySelector('[data-testid="queue-prompt-full-1"]')).toBeNull();
    expect(mounted.container.textContent).toContain("Full content for queued prompt 1 hidden.");
  });

  test("keeps a 100-row queue inside one bounded scroll region", async () => {
    const sharedPrefix = `${"x".repeat(236)}😀${"x".repeat(1_800)}`;
    const items = Array.from({ length: 100 }, (_, index) =>
      fakeTurn({
        id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
        prompt: `${sharedPrefix}\nQueued destination fingerprint: ${String(index + 1).padStart(3, "0")} 😀`,
      }),
    );
    expect(new Set(items.map((turn) => Array.from(turn.prompt).slice(0, 500).join(""))).size).toBe(
      1,
    );
    mounted = await renderComponent(
      <QueueSurface queue={queue({ queue: items })} composer={composer()} />,
    );

    await click(mounted.container.querySelector('button[aria-expanded="false"]'));
    const list = mounted.container.querySelector('[data-testid="queue-list"]');
    expect(list?.className).toContain("max-h-[min(30rem,60dvh)]");
    expect(list?.classList.contains("overflow-y-auto")).toBe(true);
    expect(list?.classList.contains("overscroll-contain")).toBe(true);
    expect(
      mounted.container.querySelectorAll('[data-testid^="queue-prompt-preview-"]'),
    ).toHaveLength(100);
    expect(mounted.container.querySelectorAll('[data-testid^="queue-prompt-full-"]')).toHaveLength(
      0,
    );
    const accessibleContent = new Set<string>();
    let index = 0;
    for (const preview of mounted.container.querySelectorAll(
      '[data-testid^="queue-prompt-preview-"]',
    )) {
      expect(Array.from(preview.textContent ?? "").length).toBeLessThanOrEqual(360);
      expect(preview.textContent).toContain("😀 … ");
      expect(preview.textContent?.endsWith(`${String(index + 1).padStart(3, "0")} 😀`)).toBe(true);
      const label = preview.getAttribute("aria-label") ?? "";
      expect(label).toContain(" summary: ");
      expect(label.endsWith(preview.textContent ?? "")).toBe(true);
      expect(label.length).toBeLessThan(410);
      expect(preview.querySelector('[aria-hidden="true"]')?.textContent).toBe(preview.textContent);
      accessibleContent.add(label.replace(/^Queued prompt \d+ summary: /, ""));
      index += 1;
    }
    expect(accessibleContent.size).toBe(100);
  });

  test("explains the durable Steer shutdown fence instead of looking stuck in an ordinary queue", async () => {
    mounted = await renderComponent(
      <QueueSurface queue={queue({ stoppingPreviousAttempt: true })} composer={composer()} />,
    );

    const status = mounted.container.querySelector('[data-testid="stopping-previous-attempt"]');
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toContain("Stopping previous attempt…");
    expect(status?.textContent).toContain("Queued work is saved and starts automatically.");
    expect(mounted.container.textContent).toContain("2 queued prompts");
  });

  test("explains that Pause keeps queued work inert while physical cancellation settles", async () => {
    const blocker = {
      kind: "session" as const,
      sessionId: "22222222-2222-4222-8222-222222222222",
      displayName: "Paused here",
      actor: null,
      reason: null,
      changedAt: null,
      revision: 1,
    };
    mounted = await renderComponent(
      <QueueSurface
        queue={queue({
          effectiveControl: {
            state: "paused",
            directState: "paused",
            controlVersion: 1,
            controlEtag: "paused:1",
            primaryBlocker: blocker,
            additionalBlockerCount: 0,
            blockers: [blocker],
            resumeOptions: [],
            override: null,
            settlement: { state: "stopping", attemptCount: 1 },
          },
          stoppingPreviousAttempt: true,
        })}
        composer={composer()}
      />,
    );

    const status = mounted.container.querySelector('[data-testid="stopping-previous-attempt"]');
    expect(status?.textContent).toContain("Stopping current attempt…");
    expect(status?.textContent).toContain("Queued work stays saved until you resume.");
    expect(status?.textContent).not.toContain("starts automatically");
  });
});
