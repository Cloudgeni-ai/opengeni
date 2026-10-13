import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  ChangeMachineAudienceRequest,
  MachineAudiencePreview,
  MachineAudiencePreviewRequest,
  MachineView,
} from "@opengeni/sdk";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import * as FormDialogModule from "@/components/ui/form-dialog";
import type { MachineAudienceClient } from "./machine-audience-dialog";

// Keep the test independent of Radix portal mounting: the same form frame,
// rendered in place while open.
mock.module("@/components/ui/form-dialog", () => ({
  ...FormDialogModule,
  FormDialog: ({
    open,
    onOpenChange,
    size: _size,
    ...frame
  }: Parameters<typeof FormDialogModule.FormDialog>[0]) =>
    open ? (
      <FormDialogModule.FormFrame
        variant="dialog"
        {...frame}
        onSubmitted={() => onOpenChange(false)}
      />
    ) : null,
}));

const { MachineAudienceDialog, machineAudienceSummaryLines } =
  await import("./machine-audience-dialog");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const ENROLLMENT = "11111111-1111-4111-8111-111111111111";
const MEMBER_CHAT = "22222222-2222-4222-8222-222222222222";
const SUMMARY = {
  keptChats: 2,
  keptSharedChats: 1,
  movedOffChats: 1,
  schedulesMadeOnlyMe: 1,
  schedulesPaused: 1,
  stoppedTurns: 1,
  stoppedCommands: 2,
  notifiedPeople: 1,
};

function machine(scope: MachineView["scope"]): MachineView & { enrollmentId: string } {
  return {
    sandboxId: "33333333-3333-4333-8333-333333333333",
    enrollmentId: ENROLLMENT,
    scope,
    generation: 4,
    name: "Build box",
    kind: "selfhosted",
    state: "online",
    active: false,
    isSessionGroup: false,
    workspaceGeneration: null,
    archiveGeneration: null,
    archiveComplete: false,
    os: "linux",
    arch: "x86_64",
    hasDisplay: false,
    allowScreenControl: false,
    sharedSessionCount: 0,
    lastSeenAt: null,
    connectionAuthority: {
      state: "not_applicable",
      generation: 0,
      supersededCount: 0,
      duplicateRunnerDeniedCount: 0,
      duplicateRunnerDeniedAt: null,
    },
    runtime: null,
    operationPolicy: null,
    metrics: null,
  } as unknown as MachineView & { enrollmentId: string };
}

function previewFor(
  request: MachineAudiencePreviewRequest,
  options: { ready?: boolean } = {},
): MachineAudiencePreview {
  return {
    enrollmentId: ENROLLMENT,
    sandboxId: "33333333-3333-4333-8333-333333333333",
    machineName: "Build box",
    currentAudience: "workspace",
    targetAudience: request.audience,
    generation: 4,
    ownerSubjectId: "user:me",
    summary: SUMMARY,
    ready: options.ready ?? true,
    items: [
      {
        kind: "chat",
        action: "move_off",
        sessionId: MEMBER_CHAT,
        scheduledTaskId: null,
        enrollmentId: null,
        workspaceId: "workspace-a",
        relation: "other_member",
        visibility: "workspace_shared",
        title: "Release notes",
        ownerSubjectId: "user:member",
        stopsTurn: true,
        stopsCommands: 2,
      },
      ...(options.ready === false
        ? [
            {
              kind: "duplicate_connection" as const,
              action: "remove_first" as const,
              sessionId: null,
              scheduledTaskId: null,
              enrollmentId: "99999999-9999-4999-8999-999999999999",
              workspaceId: null,
              relation: null,
              visibility: null,
              title: null,
              ownerSubjectId: null,
              stopsTurn: false,
              stopsCommands: 0,
            },
          ]
        : []),
    ],
  };
}

function fakeClient(options: { ready?: boolean } = {}): MachineAudienceClient & {
  previews: MachineAudiencePreviewRequest[];
  changes: ChangeMachineAudienceRequest[];
} {
  const previews: MachineAudiencePreviewRequest[] = [];
  const changes: ChangeMachineAudienceRequest[] = [];
  return {
    previews,
    changes,
    previewMachineAudience: mock(async (_ws, _enrollment, input) => {
      previews.push(input);
      return previewFor(input, options);
    }),
    changeMachineAudience: mock(async (_ws, _enrollment, input) => {
      changes.push(input);
      return {
        enrollmentId: ENROLLMENT,
        sandboxId: "33333333-3333-4333-8333-333333333333",
        previousAudience: "workspace" as const,
        audience: input.audience,
        ownerSubjectId: "user:me",
        generation: 5,
        summary: SUMMARY,
        detachedSessionIds: [MEMBER_CHAT],
        keptSessionIds: [],
      };
    }),
    listWorkspaceMembers: mock(async () => []),
  };
}

function inRouter(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return <RouterProvider router={router} />;
}

async function render(node: ReactNode): Promise<{ root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(inRouter(node));
  });
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return { root };
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!found) throw new Error(`button not rendered: ${label}`);
  return found as HTMLButtonElement;
}

describe("who can use a machine", () => {
  test("summarizes everything narrowing does and applies it with one confirmation", async () => {
    const client = fakeClient();
    const onChanged = mock(() => undefined);
    const onOpenChange = mock((_open: boolean) => undefined);
    const { root } = await render(
      <MachineAudienceDialog
        client={client}
        workspaceId="workspace-a"
        machine={machine("workspace")}
        subjectId="user:me"
        workspaceAdmin={false}
        open
        onOpenChange={onOpenChange}
        onChanged={onChanged}
      />,
    );

    expect(client.previews).toEqual([{ audience: "only_me" }]);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Who can use Build box?");
    expect(text).toContain("Your 3 chats on it keep working.");
    expect(text).toContain("1 chat from someone else moves off it.");
    expect(text).toContain("1 running turn someone else started stops now.");
    expect(text).toContain("Your Workspace schedule on it becomes Only me.");
    expect(text).toContain("The shared one stays shared; only you can run it on this machine.");
    expect(text).toContain("1 schedule pauses.");
    expect(text).toContain("1 person gets a notice");
    expect(text).toContain("To undo, share it with the workspace again.");
    // The itemized list is collapsed behind one row.
    expect(text).toContain("Chats and schedules affected");
    expect(text).toContain("1 item");
    // A member can't pick another owner.
    expect(text).not.toContain("As an admin you can make it someone else's.");

    const submit = button("Switch to Only me");
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.closest("form")!.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.changes).toEqual([{ audience: "only_me", expectedGeneration: 4 }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => root.unmount());
  });

  test("a second connection of the same computer blocks the switch", async () => {
    const client = fakeClient({ ready: false });
    const { root } = await render(
      <MachineAudienceDialog
        client={client}
        workspaceId="workspace-a"
        machine={machine("workspace")}
        subjectId="user:me"
        workspaceAdmin
        open
        onOpenChange={() => undefined}
      />,
    );
    expect(document.body.textContent).toContain("This computer is connected twice");
    expect(button("Switch to Only me").disabled).toBe(true);
    await act(async () => root.unmount());
  });

  test("sharing an Only me machine needs a workspace admin and asks nothing first", async () => {
    const client = fakeClient();
    const { root } = await render(
      <MachineAudienceDialog
        client={client}
        workspaceId="workspace-a"
        machine={machine("user")}
        subjectId="user:me"
        workspaceAdmin={false}
        open
        onOpenChange={() => undefined}
      />,
    );
    expect(document.body.textContent).toContain("Only a workspace admin can share a machine");
    expect(client.previews).toEqual([]);
    expect(button("Share with workspace").disabled).toBe(true);
    await act(async () => root.unmount());
  });

  test("names the new owner when an admin narrows it for someone else", () => {
    expect(
      machineAudienceSummaryLines(
        { ...SUMMARY, keptSharedChats: 0, stoppedTurns: 0, stoppedCommands: 0 },
        "only_me",
        { you: false, name: "Sam Example" },
      ),
    ).toEqual([
      "Sam Example's 2 chats on it keep working.",
      "1 chat from someone else moves off it. Its history stays; its next turn needs another machine.",
      "Sam Example's Workspace schedule on it becomes Only me.",
      "1 schedule pauses. Resume it after choosing another machine.",
      "1 person gets a notice in their inbox saying what changed.",
    ]);
  });
});
