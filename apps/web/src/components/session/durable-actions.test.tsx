import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  BackgroundJob,
  BackgroundJobArtifact,
  BackgroundJobLog,
  DurableWait,
} from "@opengeni/sdk";
import type { SessionEvent } from "@/types";
import { DurableActionsView, type DurableActionsClient } from "./durable-actions";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const WAIT_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-07-19T00:00:00.000Z";

let mounted: { root: Root; container: HTMLElement } | null = null;

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await act(async () => current.root.unmount());
  current.container.remove();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function durableWait(patch: Partial<DurableWait> = {}): DurableWait {
  return {
    id: WAIT_ID,
    sessionId: SESSION_ID,
    originTurnId: "66666666-6666-4666-8666-666666666666",
    kind: "ask_user",
    requestKey: "release-input",
    state: "waiting",
    outcome: null,
    request: {
      title: "Release input",
      description: "Answer each field before the session resumes.",
      questions: [
        {
          id: "notes",
          type: "text",
          prompt: "Release notes",
          required: true,
          minLength: 3,
        },
        {
          id: "region",
          type: "single_select",
          prompt: "Region",
          required: true,
          options: [
            { value: "eu", label: "Europe" },
            { value: "us", label: "United States" },
          ],
        },
        {
          id: "checks",
          type: "multi_select",
          prompt: "Checks",
          required: true,
          minSelections: 2,
          maxSelections: 2,
          options: [
            { value: "ci", label: "CI green" },
            { value: "review", label: "Review complete" },
          ],
        },
      ],
    },
    wakeAt: null,
    nextReminderAt: null,
    reminderSequence: 0,
    backgroundJobId: null,
    createdAt: NOW,
    resolvedAt: null,
    ...patch,
  };
}

function backgroundJob(patch: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: JOB_ID,
    accountId: "77777777-7777-4777-8777-777777777777",
    workspaceId: WORKSPACE_ID,
    originSessionId: SESSION_ID,
    originTurnId: "66666666-6666-4666-8666-666666666666",
    waitId: WAIT_ID,
    provider: "modal",
    spec: {
      command: "bun",
      args: ["test"],
      artifactPaths: ["coverage.json"],
      metadata: { title: "Fault suite" },
    },
    fireKey: "session:test:background-job:fault-suite",
    status: "running",
    providerRef: "modal-ref",
    providerInstanceId: "modal-instance",
    startCount: 1,
    cancelRequestedAt: null,
    exitCode: null,
    error: null,
    startedAt: NOW,
    finishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function client(overrides: Partial<DurableActionsClient> = {}): DurableActionsClient {
  return {
    listDurableWaits: async () => [],
    resolveAskUser: async () => {
      throw new Error("unexpected ask-user resolution");
    },
    listBackgroundJobs: async () => [],
    listBackgroundJobLogs: async () => [],
    listBackgroundJobArtifacts: async () => [],
    createBackgroundJobArtifactDownloadUrl: async () => {
      throw new Error("unexpected artifact download");
    },
    cancelBackgroundJob: async () => {
      throw new Error("unexpected background-job cancellation");
    },
    ...overrides,
  };
}

async function render(node: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  mounted = { root, container };
  await flush();
  return container;
}

async function rerender(node: ReactElement): Promise<void> {
  if (!mounted) throw new Error("component is not mounted");
  await act(async () => mounted?.root.render(node));
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function changeValue(control: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    control.focus();
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setValue) throw new Error("native textarea value setter is unavailable");
    setValue.call(control, value);
    control.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: "insertText",
      }),
    );
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("DurableActionsView", () => {
  test("validates structured answers, preserves a draft across refresh, and submits once", async () => {
    const resolutions: Parameters<DurableActionsClient["resolveAskUser"]>[] = [];
    const durableClient = client({
      listDurableWaits: async () => [durableWait()],
      resolveAskUser: async (...args) => {
        resolutions.push(args);
        return undefined as never;
      },
    });
    const view = (events: SessionEvent[]) => (
      <DurableActionsView
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        events={events}
        client={durableClient}
      />
    );
    const container = await render(view([]));
    const submit = button(container, "Submit answers");
    expect(submit.disabled).toBe(true);
    expect(container.textContent).toContain("Release notes is required.");

    const notes = container.querySelector("textarea")!;
    await changeValue(notes, "Ready for release");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Ready for release",
    );
    await rerender(view([{ sequence: 1 } as SessionEvent]));
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Ready for release",
    );

    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const checks = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => {
      radios[0]?.click();
      checks[0]?.click();
      checks[1]?.click();
    });
    expect(submit.disabled).toBe(false);

    await act(async () => submit.click());
    await flush();
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.slice(0, 3)).toEqual([WORKSPACE_ID, SESSION_ID, WAIT_ID]);
    expect(resolutions[0]?.[3]).toMatchObject({
      outcome: "answered",
      answers: [
        { questionId: "notes", value: "Ready for release" },
        { questionId: "region", value: "eu" },
        { questionId: "checks", value: ["ci", "review"] },
      ],
    });
    expect((resolutions[0]?.[3] as { clientEventId: string }).clientEventId).toBeTruthy();
  });

  test("cancels an ask-user wait with a fresh idempotency key", async () => {
    const resolutions: Parameters<DurableActionsClient["resolveAskUser"]>[] = [];
    const container = await render(
      <DurableActionsView
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        events={[]}
        client={client({
          listDurableWaits: async () => [durableWait()],
          resolveAskUser: async (...args) => {
            resolutions.push(args);
            return undefined as never;
          },
        })}
      />,
    );
    await act(async () => button(container, "Cancel wait").click());
    await flush();
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.[3]).toMatchObject({
      outcome: "cancelled",
      reason: "Cancelled by the user",
    });
    expect((resolutions[0]?.[3] as { clientEventId: string }).clientEventId).toBeTruthy();
  });

  test("renders reminders, timeouts, timers, and event outcomes without model-poll controls", async () => {
    const waits = [
      durableWait({ reminderSequence: 2 }),
      durableWait({
        id: "88888888-8888-4888-8888-888888888888",
        state: "resolved",
        outcome: "timed_out",
        resolvedAt: NOW,
      }),
      durableWait({
        id: "99999999-9999-4999-8999-999999999999",
        kind: "until",
        requestKey: "wait-until",
        request: { until: "2026-07-20T01:02:03.000Z" },
        wakeAt: "2026-07-20T01:02:03.000Z",
      }),
      durableWait({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "event",
        requestKey: "wait-event",
        request: { type: "deploy.finished", correlationKey: "deploy-42" },
        state: "resolved",
        outcome: "event_received",
        resolvedAt: NOW,
      }),
    ];
    const container = await render(
      <DurableActionsView
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        events={[]}
        client={client({ listDurableWaits: async () => waits })}
      />,
    );
    expect(container.textContent).toContain("Reminder 2");
    expect(container.textContent).toContain("Timed out without an answer.");
    expect(container.textContent).toContain("Waiting until a scheduled time");
    expect(container.textContent).toContain("Finished: event received.");
    expect(container.textContent).not.toContain("Poll");
  });

  test("shows job logs and artifacts, cancels execution, and opens a signed download", async () => {
    const cancellations: Parameters<DurableActionsClient["cancelBackgroundJob"]>[] = [];
    const downloads: Parameters<DurableActionsClient["createBackgroundJobArtifactDownloadUrl"]>[] =
      [];
    const logs: BackgroundJobLog[] = [
      {
        jobId: JOB_ID,
        attemptId: null,
        sequence: 1,
        providerOffset: 0,
        stream: "stdout",
        text: "fault suite running\n",
        occurredAt: NOW,
      },
    ];
    const artifacts: BackgroundJobArtifact[] = [
      {
        id: ARTIFACT_ID,
        jobId: JOB_ID,
        path: "coverage.json",
        filename: "coverage.json",
        contentType: "application/json",
        sizeBytes: 2_048,
        sha256: "a".repeat(64),
        storageKey: "background-jobs/job/coverage.json",
        createdAt: NOW,
      },
    ];
    const opened = mock((_url?: string | URL) => null);
    const previousOpen = window.open;
    window.open = opened as typeof window.open;
    try {
      const container = await render(
        <DurableActionsView
          workspaceId={WORKSPACE_ID}
          sessionId={SESSION_ID}
          events={[]}
          client={client({
            listBackgroundJobs: async () => [backgroundJob()],
            listBackgroundJobLogs: async () => logs,
            listBackgroundJobArtifacts: async () => artifacts,
            cancelBackgroundJob: async (...args) => {
              cancellations.push(args);
              return backgroundJob({ status: "cancelling" });
            },
            createBackgroundJobArtifactDownloadUrl: async (...args) => {
              downloads.push(args);
              return {
                url: "https://downloads.example/coverage.json",
                expiresAt: "2026-07-19T00:05:00.000Z",
              };
            },
          })}
        />,
      );
      expect(container.textContent).toContain("Fault suite");
      expect(container.textContent).toContain("fault suite running");
      expect(container.textContent).toContain("coverage.json");
      expect(container.textContent).toContain("2.0 KB");
      expect(container.querySelector('pre[tabindex="0"]')?.getAttribute("aria-label")).toBe(
        "Logs for Fault suite",
      );

      await act(async () => button(container, "Cancel job").click());
      await flush();
      expect(cancellations).toEqual([[WORKSPACE_ID, JOB_ID]]);

      await act(async () => button(container, "coverage.json").click());
      await flush();
      expect(downloads).toEqual([[WORKSPACE_ID, JOB_ID, ARTIFACT_ID]]);
      expect(opened).toHaveBeenCalledWith(
        "https://downloads.example/coverage.json",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      window.open = previousOpen;
    }
  });
});
