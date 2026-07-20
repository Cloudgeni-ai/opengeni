import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";

import { QueueSurface } from "../src/components/queue-surface";
import type { ComposerState } from "../src/hooks/use-composer";
import type { UseTurnQueueResult } from "../src/hooks/use-turn-queue";
import { fakeTurn } from "./fake-client";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";
import {
  QUEUE_BOUNDARY_CLUSTERS,
  QUEUE_VISIBILITY_PROBE_KINDS,
  queueBoundaryPrompt,
  queueBoundarySummary,
  queueVisibilityProbePrompt,
  type QueueBoundaryMaximum,
} from "../demo/queue-fixtures";

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

async function waitForLoadedQueueSurface(rendered: RenderedComponent): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (
    rendered.container.querySelector('[data-testid="queue-surface-loading"]') &&
    performance.now() < deadline
  ) {
    await flush(10);
  }

  if (rendered.container.querySelector('[data-testid="queue-surface-loading"]')) {
    throw new Error("QueueSurface implementation did not load within 5 seconds");
  }
}

async function renderLoadedQueueSurface(node: ReactNode): Promise<RenderedComponent> {
  const rendered = await renderComponent(node);
  await waitForLoadedQueueSurface(rendered);
  return rendered;
}

async function renderedPromptSummary(
  prompt: string,
  maxCharacters: QueueBoundaryMaximum,
): Promise<{ accessibleSummary: string; summary: string; visualSummary: string }> {
  mounted = await renderLoadedQueueSurface(
    <QueueSurface
      queue={queue({
        queue: [
          fakeTurn({
            id: "33333333-3333-4333-8333-333333333333",
            prompt,
          }),
        ],
      })}
      composer={composer()}
    />,
  );

  let summaryElement: Element | null;
  let accessibleSummary: string;
  if (maxCharacters === 180) {
    summaryElement = mounted.container.querySelector('[data-testid="queue-collapsed-preview"]');
    accessibleSummary =
      mounted.container
        .querySelector('button[aria-label="1 queued prompt"]')
        ?.getAttribute("aria-description") ?? "";
  } else {
    await click(mounted.container.querySelector('button[aria-expanded="false"]'));
    summaryElement = mounted.container.querySelector('[data-testid="queue-prompt-preview-1"]');
    accessibleSummary = (summaryElement?.getAttribute("aria-label") ?? "").replace(
      /^Queued prompt 1 summary: /,
      "",
    );
  }
  const visualSummary = summaryElement?.textContent ?? "";
  const summary = accessibleSummary;

  const current = mounted;
  mounted = null;
  await current.unmount();
  document.body.replaceChildren();
  return { accessibleSummary, summary, visualSummary };
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      if (
        index + 1 >= value.length ||
        value.charCodeAt(index + 1) < 0xdc00 ||
        value.charCodeAt(index + 1) > 0xdfff
      ) {
        return false;
      }
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe("QueueSurface", () => {
  test("does not load or render queue UI for an ordinary empty session", async () => {
    mounted = await renderComponent(
      <QueueSurface queue={queue({ queue: [] })} composer={composer()} />,
    );

    expect(mounted.container.childElementCount).toBe(0);
    expect(mounted.container.querySelector('[data-testid="queue-surface-loading"]')).toBeNull();
  });

  test("exposes an accessible, layout-stable shell while the queue implementation loads", async () => {
    mounted = await renderComponent(<QueueSurface queue={queue()} composer={composer()} />);

    const fallback = mounted.container.querySelector('[data-testid="queue-surface-loading"]');
    expect(fallback?.getAttribute("role")).toBe("status");
    expect(fallback?.getAttribute("aria-live")).toBe("polite");
    expect(fallback?.textContent).toContain("Loading 2 queued prompts…");
    expect(
      fallback?.firstElementChild?.firstElementChild?.classList.contains(
        "pointer-coarse:min-h-[44px]",
      ),
    ).toBe(true);

    await waitForLoadedQueueSurface(mounted);
    expect(mounted.container.querySelector('[data-testid="queue-surface"]')).not.toBeNull();
  });

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
    mounted = await renderLoadedQueueSurface(<QueueSurface queue={state} composer={composer()} />);

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
    mounted = await renderLoadedQueueSurface(<QueueSurface queue={queue()} readOnly />);

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
    mounted = await renderLoadedQueueSurface(<QueueSurface queue={state} composer={composer()} />);

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
    const visibleStart = preview?.querySelector('[data-testid="queue-prompt-start-1"]');
    const visibleIdentity = preview?.querySelector('[data-testid="queue-prompt-identity-1"]');
    expect(visibleStart?.classList.contains("line-clamp-1")).toBe(true);
    expect(visibleStart?.classList.contains("sm:line-clamp-2")).toBe(true);
    expect(visibleStart?.classList.contains("break-all")).toBe(true);
    expect(preview?.getAttribute("aria-hidden")).toBeNull();
    expect(preview?.getAttribute("role")).toBe("note");
    expect(preview?.getAttribute("dir")).toBe("auto");
    const namedSummary = (preview?.getAttribute("aria-label") ?? "").replace(
      /^Queued prompt 1 summary: /,
      "",
    );
    expect(namedSummary).toContain(" … ");
    expect(namedSummary).toContain("Exact trailing line.");
    expect(visibleIdentity?.textContent).toBe("act trailing line.");
    expect(preview?.querySelector('[aria-hidden="true"]')?.textContent).toBe(preview?.textContent);
    expect(preview?.textContent).not.toBe(prompt);
    expect(preview?.getAttribute("aria-label")).toBe(`Queued prompt 1 summary: ${namedSummary}`);
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

  test("backs off whole graphemes at both preview cuts and both strict bounds", async () => {
    for (const maxCharacters of [180, 360] as const) {
      for (const edge of ["head", "tail"] as const) {
        for (const clusterName of Object.keys(QUEUE_BOUNDARY_CLUSTERS) as Array<
          keyof typeof QUEUE_BOUNDARY_CLUSTERS
        >) {
          const { accessibleSummary, summary } = await renderedPromptSummary(
            queueBoundaryPrompt(maxCharacters, edge, clusterName),
            maxCharacters,
          );
          expect(summary).toBe(queueBoundarySummary(maxCharacters, edge));
          expect(accessibleSummary).toBe(summary);
          expect(Array.from(summary)).toHaveLength(maxCharacters - 1);
          expect(Array.from(summary).length).toBeLessThanOrEqual(maxCharacters);
          expect(isWellFormedUnicode(summary)).toBe(true);
        }
      }
    }
  });

  test("sanitizes malformed summaries but discloses the exact durable source", async () => {
    const prompt = `${"a".repeat(116)}\ud800${"x".repeat(500)}\udc00${"z".repeat(59)}`;
    const state = queue({
      queue: [
        fakeTurn({
          id: "33333333-3333-4333-8333-333333333333",
          prompt,
        }),
      ],
    });
    mounted = await renderLoadedQueueSurface(<QueueSurface queue={state} composer={composer()} />);

    const collapsed = mounted.container.querySelector('[data-testid="queue-collapsed-preview"]');
    expect(collapsed?.textContent).toContain("�");
    expect(isWellFormedUnicode(collapsed?.textContent ?? "")).toBe(true);

    await click(mounted.container.querySelector('button[aria-expanded="false"]'));
    const preview = mounted.container.querySelector('[data-testid="queue-prompt-preview-1"]');
    const namedSummary = (preview?.getAttribute("aria-label") ?? "").replace(
      /^Queued prompt 1 summary: /,
      "",
    );
    expect(namedSummary).toContain("�");
    expect(isWellFormedUnicode(namedSummary)).toBe(true);
    expect(preview?.getAttribute("aria-label")).toBe(`Queued prompt 1 summary: ${namedSummary}`);

    await click(
      mounted.container.querySelector('button[aria-label="Show full content for queued prompt 1"]'),
    );
    expect(
      mounted.container.querySelector('[data-testid="queue-prompt-full-1"]')?.textContent,
    ).toBe(prompt);
  });

  test("bounds grapheme segmentation work for huge pathological clusters", async () => {
    const prototype = Intl.Segmenter.prototype;
    const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, "segment");
    const originalSegment = prototype.segment;
    const observedInputLengths: number[] = [];
    Object.defineProperty(prototype, "segment", {
      configurable: true,
      writable: true,
      value(this: Intl.Segmenter, input: string) {
        if (input.length > 800) throw new Error(`unbounded queue preview segment: ${input.length}`);
        observedInputLengths.push(input.length);
        return originalSegment.call(this, input);
      },
    });

    try {
      const longMarks = "\u0301".repeat(500_000);
      const regionalIndicator = String.fromCodePoint(0x1f1e6);
      const prompts = [
        `${"a".repeat(116)}e${longMarks}${"x".repeat(500_000)}${"z".repeat(120)}`,
        `${"a".repeat(237)}${"x".repeat(500_000)}e${longMarks}`,
        `${"a".repeat(237)}${"x".repeat(500_000)}${regionalIndicator.repeat(
          100,
        )}${"z".repeat(100)}`,
        "\u200d".repeat(500_000),
      ];
      const summaries: string[] = [];
      for (const prompt of prompts) {
        const { accessibleSummary, summary } = await renderedPromptSummary(prompt, 360);
        expect(accessibleSummary).toBe(summary);
        expect(Array.from(summary).length).toBeLessThanOrEqual(360);
        expect(isWellFormedUnicode(summary)).toBe(true);
        summaries.push(summary);
      }
      expect(summaries[2]).toBe(`${"a".repeat(237)} … ${"z".repeat(100)}`);
      expect(summaries[2]).not.toContain(regionalIndicator);
      expect(summaries[3]).toMatch(/^Content omitted at safe boundary · ref [0-9A-F]{8}$/);

      for (const maxCharacters of [180, 360] as const) {
        const suffixCharacters = maxCharacters / 3;
        const prefixCharacters = maxCharacters - 3 - suffixCharacters;
        const locallyRetainableFragment = `👩${"\u200d👩".repeat((suffixCharacters - 4) / 2)}`;
        const oversizedCluster = `👩${"\u0301".repeat(33)}\u200d${locallyRetainableFragment}`;
        const { accessibleSummary, summary } = await renderedPromptSummary(
          `${"a".repeat(prefixCharacters)}${"x".repeat(500_000)}${oversizedCluster}zz`,
          maxCharacters,
        );
        expect(summary).toBe(`${"a".repeat(prefixCharacters)} … zz`);
        expect(accessibleSummary).toBe(summary);
        expect(summary).not.toContain("👩");
        expect(summary).not.toContain("\u200d");
      }
    } finally {
      if (originalDescriptor) Object.defineProperty(prototype, "segment", originalDescriptor);
    }

    expect(observedInputLengths.length).toBeGreaterThan(0);
    expect(Math.max(...observedInputLengths)).toBeLessThanOrEqual(538);
  });

  test("uses a bounded truthful fallback when no complete visible grapheme can be sampled", async () => {
    const oversizedCombiningCluster = `e${"\u0301".repeat(10_000)}`;
    const oversizedZwjCluster = `👩${"\u200d👩".repeat(1_000)}`;
    const prompts = [" \n\t ", " ".repeat(2_000), oversizedCombiningCluster, oversizedZwjCluster];

    for (const prompt of prompts) {
      const summaries: string[] = [];
      for (const maxCharacters of [180, 360] as const) {
        const { accessibleSummary, summary } = await renderedPromptSummary(prompt, maxCharacters);
        expect(summary).toMatch(/^Content omitted at safe boundary · ref [0-9A-F]{8}$/);
        expect(summary).not.toBe(" … ");
        expect(Array.from(summary).length).toBeLessThanOrEqual(maxCharacters);
        expect(isWellFormedUnicode(summary)).toBe(true);
        expect(accessibleSummary).toBe(summary);
        summaries.push(summary);
      }
      expect(summaries[0]).toBe(summaries[1]);
    }

    mounted = await renderLoadedQueueSurface(
      <QueueSurface
        queue={queue({
          queue: [
            fakeTurn({
              id: "33333333-3333-4333-8333-333333333333",
              prompt: oversizedZwjCluster,
            }),
          ],
        })}
        composer={composer()}
      />,
    );
    await click(mounted.container.querySelector('button[aria-expanded="false"]'));
    const preview = mounted.container.querySelector('[data-testid="queue-prompt-preview-1"]');
    const namedSummary = (preview?.getAttribute("aria-label") ?? "").replace(
      /^Queued prompt 1 summary: /,
      "",
    );
    expect(namedSummary).toMatch(/^Content omitted at safe boundary · ref [0-9A-F]{8}$/);
    expect(preview?.textContent).toMatch(/^Omitted · [0-9A-F]{8}$/);
    expect(namedSummary.endsWith(preview?.textContent?.replace("Omitted · ", "") ?? "")).toBe(true);
    await click(
      mounted.container.querySelector('button[aria-label="Show full content for queued prompt 1"]'),
    );
    expect(
      mounted.container.querySelector('[data-testid="queue-prompt-full-1"]')?.textContent,
    ).toBe(oversizedZwjCluster);
  });

  test("falls back for short non-painting prompts while retaining mixed visible content", async () => {
    const nonPaintingKinds = QUEUE_VISIBILITY_PROBE_KINDS.filter(
      (kind) => kind !== "mixed-visible",
    );
    const fallbackSummaries = new Set<string>();

    for (const kind of nonPaintingKinds) {
      const prompt = queueVisibilityProbePrompt(kind);
      const summaries: string[] = [];
      for (const maxCharacters of [180, 360] as const) {
        const { accessibleSummary, summary } = await renderedPromptSummary(prompt, maxCharacters);
        expect(summary).toMatch(/^Content omitted at safe boundary · ref [0-9A-F]{8}$/);
        expect(Array.from(summary).length).toBeLessThanOrEqual(maxCharacters);
        expect(isWellFormedUnicode(summary)).toBe(true);
        expect(accessibleSummary).toBe(summary);
        summaries.push(summary);
      }
      expect(summaries[0]).toBe(summaries[1]);
      fallbackSummaries.add(summaries[0] ?? "");
    }
    expect(fallbackSummaries.size).toBe(nonPaintingKinds.length);

    const mixedPrompt = queueVisibilityProbePrompt("mixed-visible");
    for (const maxCharacters of [180, 360] as const) {
      const { accessibleSummary, summary } = await renderedPromptSummary(
        mixedPrompt,
        maxCharacters,
      );
      expect(summary).toBe(mixedPrompt);
      expect(summary).toContain("Visible identity 😀");
      expect(summary).not.toContain("Content omitted at safe boundary");
      expect(accessibleSummary).toBe(summary);
    }

    const prompts = nonPaintingKinds.map(queueVisibilityProbePrompt);
    mounted = await renderLoadedQueueSurface(
      <QueueSurface
        queue={queue({
          queue: prompts.map((prompt, index) =>
            fakeTurn({
              id: `${String(index + 1).padStart(8, "0")}-3333-4333-8333-333333333333`,
              prompt,
            }),
          ),
        })}
        composer={composer()}
      />,
    );
    const collapsedToggle = mounted.container.querySelector(
      'button[aria-label="6 queued prompts"]',
    );
    const collapsedVisual = mounted.container.querySelector(
      '[data-testid="queue-collapsed-preview"]',
    );
    expect(collapsedToggle?.getAttribute("aria-description")).toMatch(
      /^Content omitted at safe boundary · ref [0-9A-F]{8}$/,
    );
    expect(collapsedVisual?.textContent).toMatch(/^Omitted · [0-9A-F]{8}$/);
    expect(
      collapsedToggle
        ?.getAttribute("aria-description")
        ?.endsWith(collapsedVisual?.textContent?.replace("Omitted · ", "") ?? ""),
    ).toBe(true);
    await click(mounted.container.querySelector('button[aria-expanded="false"]'));
    for (const [index, prompt] of prompts.entries()) {
      const ordinal = index + 1;
      const preview = mounted.container.querySelector(
        `[data-testid="queue-prompt-preview-${ordinal}"]`,
      );
      expect(preview?.getAttribute("aria-label")).toMatch(
        new RegExp(`^Queued prompt ${ordinal} summary: Content omitted at safe boundary · ref `),
      );
      expect(preview?.textContent).toMatch(/^Omitted · [0-9A-F]{8}$/);
      expect(
        preview
          ?.getAttribute("aria-label")
          ?.endsWith(preview?.textContent?.replace("Omitted · ", "") ?? ""),
      ).toBe(true);
      expect(preview?.textContent).not.toContain(prompt);
      await click(
        mounted.container.querySelector(
          `button[aria-label="Show full content for queued prompt ${ordinal}"]`,
        ),
      );
      expect(
        mounted.container.querySelector(`[data-testid="queue-prompt-full-${ordinal}"]`)
          ?.textContent,
      ).toBe(prompt);
    }
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
    mounted = await renderLoadedQueueSurface(
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
    const visibleIdentities = new Set<string>();
    let index = 0;
    for (const preview of mounted.container.querySelectorAll(
      '[data-testid^="queue-prompt-preview-"]',
    )) {
      const label = preview.getAttribute("aria-label") ?? "";
      expect(label).toContain(" summary: ");
      expect(label.length).toBeLessThan(410);
      const summary = label.replace(/^Queued prompt \d+ summary: /, "");
      expect(Array.from(summary).length).toBeLessThanOrEqual(360);
      expect(summary).toContain("😀 … ");
      expect(summary.endsWith(`${String(index + 1).padStart(3, "0")} 😀`)).toBe(true);
      const identity = preview.querySelector(
        `[data-testid="queue-prompt-identity-${index + 1}"]`,
      )?.textContent;
      expect(identity).toBe(`fingerprint: ${String(index + 1).padStart(3, "0")} 😀`);
      expect(preview.querySelector('[aria-hidden="true"]')?.textContent).toBe(preview.textContent);
      accessibleContent.add(summary);
      visibleIdentities.add(identity ?? "");
      index += 1;
    }
    expect(accessibleContent.size).toBe(100);
    expect(visibleIdentities.size).toBe(100);
  });

  test("keeps exact hostile queue errors in a bounded keyboard scroller beside retry", async () => {
    const queueFailure = new Error("queue failed");
    const mutationFailure = new Error(
      `Mutation failed\nhttps://queue.invalid/${"unbroken".repeat(10_000)}\nRetry safely`,
    );
    const calls: string[] = [];
    mounted = await renderLoadedQueueSurface(
      <QueueSurface
        queue={queue({
          error: queueFailure,
          mutationError: mutationFailure,
          clearMutationError: () => calls.push("clear"),
          refresh: async () => {
            calls.push("refresh");
          },
        })}
        composer={composer()}
      />,
    );

    const alert = mounted.container.querySelector('[role="alert"]');
    const message = mounted.container.querySelector('[data-testid="queue-error-message"]');
    const retry = mounted.container.querySelector(
      'button[aria-label="Dismiss queue error and retry"]',
    );
    expect(alert?.classList.contains("min-w-0")).toBe(true);
    expect(alert?.classList.contains("max-w-full")).toBe(true);
    expect(alert?.classList.contains("flex-wrap")).toBe(true);
    expect(message?.textContent).toBe(mutationFailure.message);
    expect(message?.textContent).not.toContain(queueFailure.message);
    expect(message?.getAttribute("role")).toBe("region");
    expect(message?.getAttribute("aria-label")).toBe("Queue error details");
    expect(message?.getAttribute("tabindex")).toBe("0");
    expect(message?.getAttribute("dir")).toBe("auto");
    expect(message?.classList.contains("max-h-[min(5rem,20dvh)]")).toBe(true);
    expect(message?.classList.contains("flex-[1_1_5rem]")).toBe(true);
    expect(message?.classList.contains("overflow-auto")).toBe(true);
    expect(message?.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(message?.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
    expect(message?.classList.contains("[unicode-bidi:plaintext]")).toBe(true);
    expect(retry?.classList.contains("shrink-0")).toBe(true);
    expect(retry?.classList.contains("self-start")).toBe(true);

    await click(retry);
    expect(calls).toEqual(["clear", "refresh"]);
  });

  test("renders queue load errors losslessly when there is no mutation error", async () => {
    const failure = new Error(`Load failed: ${"Q".repeat(20_000)}`);
    mounted = await renderLoadedQueueSurface(
      <QueueSurface queue={queue({ error: failure })} composer={composer()} />,
    );

    expect(
      mounted.container.querySelector('[data-testid="queue-error-message"]')?.textContent,
    ).toBe(failure.message);
  });

  test("explains the durable Steer shutdown fence instead of looking stuck in an ordinary queue", async () => {
    mounted = await renderLoadedQueueSurface(
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
    mounted = await renderLoadedQueueSurface(
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
