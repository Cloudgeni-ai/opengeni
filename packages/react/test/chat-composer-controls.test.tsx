import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";

import { ChatComposer } from "../src/components/chat-composer";
import type { ComposerState } from "../src/hooks/use-composer";
import type { EffectiveSessionControl } from "@opengeni/sdk";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
});

function composer(spy: { sends: string[]; pauses: number; resumes: number }): ComposerState {
  return {
    value: "next prompt",
    setValue: () => {},
    send: async () => {
      spy.sends.push("send");
      return true;
    },
    steer: async () => {
      spy.sends.push("steer");
      return true;
    },
    sending: false,
    canSend: true,
    pause: async () => {
      spy.pauses += 1;
    },
    pausing: false,
    resume: async () => {
      spy.resumes += 1;
    },
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
  };
}

async function press(textarea: HTMLTextAreaElement, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    textarea.focus();
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
    await Promise.resolve();
  });
}

describe("ChatComposer delivery and lifecycle controls", () => {
  test("Enter queues while Cmd/Ctrl+Enter steers", async () => {
    const spy = { sends: [] as string[], pauses: 0, resumes: 0 };
    mounted = await renderComponent(<ChatComposer composer={composer(spy)} />);
    const textarea = mounted.container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    await press(textarea!, {});
    await press(textarea!, { metaKey: true });
    await press(textarea!, { ctrlKey: true });

    expect(spy.sends).toEqual(["send", "steer", "steer"]);
    expect(textarea?.getAttribute("aria-keyshortcuts")).toContain("Meta+Enter");
  });

  test("running shows one Pause control; paused replaces it with one Resume control", async () => {
    const spy = { sends: [] as string[], pauses: 0, resumes: 0 };
    const active: EffectiveSessionControl = {
      state: "active",
      controlVersion: 0,
      controlEtag: "active",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    };
    mounted = await renderComponent(
      <ChatComposer composer={composer(spy)} effectiveControl={active} />,
    );

    const pause = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pause this workstream"]',
    );
    expect(pause).not.toBeNull();
    expect(
      mounted.container.querySelectorAll('button[aria-label="Pause this workstream"]'),
    ).toHaveLength(1);
    expect(
      [...mounted.container.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Resume",
      ),
    ).toBe(false);
    await act(async () => pause?.click());
    expect(spy.pauses).toBe(1);

    const blocker = {
      kind: "session" as const,
      sessionId: "22222222-2222-4222-8222-222222222222",
      displayName: "Paused here",
      actor: null,
      reason: null,
      changedAt: null,
      revision: 1,
    };
    const paused = {
      ...active,
      state: "paused" as const,
      directState: "paused" as const,
      controlVersion: 1,
      controlEtag: "paused",
      primaryBlocker: blocker,
      blockers: [blocker],
      resumeOptions: [
        {
          scope: "selected" as const,
          targetId: blocker.sessionId,
          selectedStateAfter: "active" as const,
          impactCopy: "Runs",
        },
      ],
    };
    await mounted.rerender(<ChatComposer composer={composer(spy)} effectiveControl={paused} />);
    const resume = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Resume this workstream"]',
    );
    expect(resume).not.toBeNull();
    expect(
      mounted.container.querySelector('button[aria-label="Pause this workstream"]'),
    ).toBeNull();
    await act(async () => resume?.click());
    expect(spy.resumes).toBe(1);
  });

  test("the send button queues and explains the steer shortcut", async () => {
    const spy = { sends: [] as string[], pauses: 0, resumes: 0 };
    mounted = await renderComponent(<ChatComposer composer={composer(spy)} />);
    const send = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send message"]',
    );
    expect(send?.title).toContain("Queue message");
    expect(send?.title).toContain("Cmd/Ctrl+Enter");
    await act(async () => send?.click());
    expect(spy.sends).toEqual(["send"]);
  });

  test("inherited Pause names and links every blocker while keeping one primary Resume", async () => {
    const spy = { sends: [] as string[], pauses: 0, resumes: 0 };
    const parentId = "33333333-3333-4333-8333-333333333333";
    const workspaceBlocker = {
      kind: "workspace" as const,
      displayName: "Cloudgeni",
      actor: "Jorge",
      reason: "Maintenance",
      changedAt: "2026-07-16T12:00:00.000Z",
      revision: 8,
    };
    const parentBlocker = {
      kind: "session" as const,
      sessionId: parentId,
      displayName: "Parent orchestrator",
      actor: null,
      reason: null,
      changedAt: null,
      revision: 9,
    };
    const paused: EffectiveSessionControl = {
      state: "paused",
      controlVersion: 9,
      controlEtag: "inherited-pause",
      directState: "active",
      primaryBlocker: parentBlocker,
      additionalBlockerCount: 1,
      blockers: [parentBlocker, workspaceBlocker],
      resumeOptions: [
        {
          scope: "selected",
          targetId: "22222222-2222-4222-8222-222222222222",
          selectedStateAfter: "active",
          impactCopy: "Resume this workstream",
        },
        {
          scope: "workspace",
          selectedStateAfter: "paused",
          remainingPrimaryBlocker: parentBlocker,
          impactCopy: "Resume workspace",
        },
      ],
      override: null,
      settlement: null,
    };
    mounted = await renderComponent(
      <ChatComposer
        composer={composer(spy)}
        effectiveControl={paused}
        controlLinks={{
          workspaceHref: "/workspaces/cloudgeni",
          sessionHref: (sessionId) => `/sessions/${sessionId}`,
        }}
      />,
    );

    expect(mounted.container.textContent).toContain("Paused by Parent orchestrator");
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Show pause details"]')
        ?.click();
    });
    expect(
      mounted.container.querySelector<HTMLAnchorElement>(`a[href="/sessions/${parentId}"]`)
        ?.textContent,
    ).toBe("Parent orchestrator");
    expect(
      mounted.container.querySelector<HTMLAnchorElement>('a[href="/workspaces/cloudgeni"]')
        ?.textContent,
    ).toBe("Cloudgeni");
    expect(
      mounted.container.querySelectorAll('button[aria-label="Resume this workstream"]'),
    ).toHaveLength(1);
  });
});
