// Browser fixture for "Who can use it?" on a connected machine: the machine
// detail row and the change dialog, against a deterministic fake API.
import { MachineDetail, type MachineView } from "@opengeni/react/machines";
import type {
  ChangeMachineAudienceRequest,
  MachineAudienceItem,
  MachineAudiencePreview,
  MachineAudiencePreviewRequest,
} from "@opengeni/sdk";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import {
  MachineAudienceDialog,
  type MachineAudienceClient,
} from "../src/components/machines/machine-audience-dialog";
import { ContentPage } from "../src/components/ui/content-layout";
import { Toaster } from "../src/components/ui/sonner";
import { AppearanceProvider } from "../src/lib/appearance";
import "../src/styles.css";

const machine = {
  sandboxId: "33333333-3333-4333-8333-333333333333",
  enrollmentId: "11111111-1111-4111-8111-111111111111",
  scope: "workspace",
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
  desktopUnavailableReason: null,
  allowScreenControl: false,
  sharedSessionCount: 3,
  lastSeenAt: new Date().toISOString(),
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

const state = {
  previews: [] as MachineAudiencePreviewRequest[],
  changes: [] as ChangeMachineAudienceRequest[],
};
Reflect.set(window, "machineAudienceFixture", state);

const base = {
  sessionId: null,
  scheduledTaskId: null,
  enrollmentId: null,
  workspaceId: "workspace-a",
  ownerSubjectId: null,
  stopsTurn: false,
  stopsCommands: 0,
} as const;

const summary = {
  keptChats: 4,
  keptSharedChats: 1,
  movedOffChats: 2,
  schedulesMadeOnlyMe: 1,
  schedulesPaused: 1,
  stoppedTurns: 1,
  stoppedCommands: 1,
  notifiedPeople: 2,
};

function preview(request: MachineAudiencePreviewRequest): MachineAudiencePreview {
  const items: MachineAudienceItem[] = [
    {
      ...base,
      kind: "chat",
      action: "move_off",
      sessionId: "44444444-4444-4444-8444-444444444444",
      relation: "other_member",
      visibility: "workspace_shared",
      title: "Release checklist for the March launch",
      ownerSubjectId: "user:sam",
      stopsTurn: true,
      stopsCommands: 1,
    },
    {
      ...base,
      kind: "chat",
      action: "move_off",
      sessionId: "55555555-5555-4555-8555-555555555555",
      relation: "other_member",
      visibility: "user_private",
      title: null,
    },
    {
      ...base,
      kind: "chat",
      action: "keep",
      sessionId: "66666666-6666-4666-8666-666666666666",
      relation: "owner_shared",
      visibility: "workspace_shared",
      title: "Weekly report",
      ownerSubjectId: "user:me",
    },
    {
      ...base,
      kind: "schedule",
      action: "make_only_me",
      scheduledTaskId: "77777777-7777-4777-8777-777777777777",
      relation: "owner_shared",
      visibility: "workspace_shared",
      title: "Nightly build",
      ownerSubjectId: "user:me",
    },
    {
      ...base,
      kind: "schedule",
      action: "pause",
      scheduledTaskId: "88888888-8888-4888-8888-888888888888",
      relation: "other_member",
      visibility: "workspace_shared",
      title: "Dependency updates",
      ownerSubjectId: "user:sam",
    },
  ];
  return {
    enrollmentId: machine.enrollmentId,
    sandboxId: machine.sandboxId,
    machineName: machine.name,
    currentAudience: "workspace",
    targetAudience: request.audience,
    generation: 4,
    ownerSubjectId: request.ownerSubjectId ?? "user:me",
    summary,
    items,
    ready: true,
  };
}

const client: MachineAudienceClient = {
  previewMachineAudience: async (_ws, _id, request) => {
    state.previews.push(request);
    await new Promise((resolve) => setTimeout(resolve, 120));
    return preview(request);
  },
  changeMachineAudience: async (_ws, _id, request) => {
    state.changes.push(request);
    return {
      enrollmentId: machine.enrollmentId,
      sandboxId: machine.sandboxId,
      previousAudience: "workspace",
      audience: request.audience,
      ownerSubjectId: "user:me",
      generation: 5,
      summary,
      detachedSessionIds: [
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
      ],
      keptSessionIds: [],
    };
  },
  listWorkspaceMembers: async () => [
    {
      subjectId: "user:me",
      subjectLabel: "Alex Example",
      role: "admin",
      permissions: [],
      createdAt: "",
    },
    {
      subjectId: "user:sam",
      subjectLabel: "Sam Example",
      role: "member",
      permissions: [],
      createdAt: "",
    },
  ],
};

function Fixture() {
  const [open, setOpen] = useState(new URLSearchParams(location.search).get("view") === "dialog");
  const [current, setCurrent] = useState(machine);
  return (
    <ContentPage width="standard">
      <MachineDetail
        machine={current}
        series={[]}
        window="1h"
        onWindowChange={() => undefined}
        onBack={() => undefined}
        onChangeAudience={() => setOpen(true)}
      />
      {open ? (
        <MachineAudienceDialog
          client={client}
          workspaceId="workspace-a"
          machine={current}
          subjectId="user:me"
          workspaceAdmin
          open
          onOpenChange={setOpen}
          onChanged={(result) =>
            setCurrent({ ...current, scope: result.audience === "only_me" ? "user" : "workspace" })
          }
        />
      ) : null}
    </ContentPage>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: Fixture }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(
  <AppearanceProvider>
    <RouterProvider router={router} />
    <Toaster />
  </AppearanceProvider>,
);
