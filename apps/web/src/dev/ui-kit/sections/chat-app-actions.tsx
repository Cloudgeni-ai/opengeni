import { ApprovalSurface, type PendingApproval } from "@opengeni/react";
import { SecretsUiProvider } from "@opengeni/react/session-ui";
import {
  OpenGeniApiError,
  toolReviewAction,
  toolReviewDetails,
  toolReviewFields,
  type ToolActionReview,
} from "@opengeni/sdk";
import type { ToolReviewContext } from "@opengeni/contracts";
import {
  appActionConfirmationTitle,
  appActionTargetFacts,
  type AppActionTargets,
} from "@opengeni/contracts/app-actions";

import { webSecretsUi } from "@opengeni/react/app/lib/secrets-ui";
import { KitBlock, KitSection, StateCell, StatesGrid } from "../kit";
import { ChatFrame, kitEvent, lead, showPart } from "./chat-shared";

/* ----------------------------------------------------------------------------
   Opengeni app actions (admin_action_call) waiting for the person: each card
   names what it changes, from what the server found for the call's ids, and
   the history says what was decided. Real ApprovalSurface and timeline; the
   reviews are built by the same contract functions the worker and API use.
   -------------------------------------------------------------------------- */

const WORKSPACE = "3e7157ca-9d54-4c0d-b5fb-135454e3cb35";
const HERE = { workspaceId: WORKSPACE, sessionId: "1e0d4cf5-93f9-43ff-b452-b7faa5708664" };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Scene = {
  approval: PendingApproval;
  review: ToolActionReview;
  context: ToolReviewContext;
  title: string;
};

function scene(callId: string, args: Record<string, unknown>, targets: AppActionTargets): Scene {
  const title = appActionConfirmationTitle(args, HERE, targets);
  const context: ToolReviewContext = {
    kind: "generic",
    title,
    targetFacts: appActionTargetFacts(args, HERE, targets),
  };
  const approval: PendingApproval = {
    id: callId,
    name: "opengeni__admin_action_call",
    arguments: JSON.stringify(args),
    display: { toolName: "admin_action_call", title },
  };
  const { fields, moreFields } = toolReviewFields(args, context, "admin_action_call");
  const review = {
    version: 1,
    id: callId,
    actionDigest: `kit-${callId}`,
    revision: "kit-1",
    status: "pending",
    ...toolReviewAction("admin_action_call", args, context),
    samples: [],
    fields,
    moreFields,
    reason: "This action asks first by default.",
    createdAt: "2026-10-30T07:41:00Z",
    updatedAt: "2026-10-30T07:41:00Z",
    availableActions: ["approve", "reject"],
    detailsAvailable: true,
  } as ToolActionReview;
  return { approval, review, context, title };
}

const deleteConnection = (callId: string, connectionId: string, targets: AppActionTargets) =>
  scene(
    callId,
    {
      id: "deleteConnection",
      pathParameters: { workspaceId: WORKSPACE, connectionId },
      ...(callId.endsWith("drive")
        ? { body: { expectedVersion: 2, idempotencyKey: "17b33d48-0392-4c22-a7cc-a268cfb90185" } }
        : {}),
    },
    targets,
  );

/** The four connections a staging cleanup removed, as the server reads them. */
const GMAIL = deleteConnection(
  "toolu_016mVqHqos4m2cH4WRPmqfvV",
  "e6b94031-cf62-4ec7-b31d-c19d73ea29f3",
  {
    connectionId: {
      kind: "connection",
      name: "Gmail",
      account: "anna@example.com",
      facts: [
        { label: "Who can use it", value: "Only you" },
        { label: "Added", value: "14 Oct 2026, 07:41 UTC" },
        { label: "Last used", value: "14 Oct 2026" },
      ],
    },
  },
);
const LINEAR_OLD = deleteConnection(
  "toolu_01ANumrv1YVxrsjfnQocpqDt",
  "44238bee-45bf-4199-881b-d7e2a0db3313",
  {
    connectionId: {
      kind: "connection",
      name: "Linear",
      account: "Anna · Example",
      facts: [
        { label: "Status", value: "Needs reconnecting" },
        { label: "Who can use it", value: "Only you" },
        { label: "Added", value: "2 Jul 2026, 10:05 UTC" },
        { label: "Last used", value: "11 Jul 2026" },
      ],
    },
  },
);
const LINEAR_NEWER = deleteConnection(
  "toolu_015KP7RtuiDmgdJyZYMJ7nUu",
  "771383b6-b314-4d8f-bb14-1b98fca1c3ae",
  {
    connectionId: {
      kind: "connection",
      name: "Linear",
      account: "Anna · Example",
      facts: [
        { label: "Status", value: "Needs reconnecting" },
        { label: "Who can use it", value: "Only you" },
        { label: "Added", value: "9 Jul 2026, 14:22 UTC" },
        { label: "Last used", value: "18 Jul 2026" },
      ],
    },
  },
);
const DRIVE = deleteConnection(
  "toolu_01SQ5pkkmFFotCoHmFDNoAWE-drive",
  "a5f6c565-d374-4bc5-ab6b-0261351266fd",
  {
    connectionId: {
      kind: "connection",
      name: "Google Drive",
      account: "anna@example.com",
      facts: [
        { label: "Who can use it", value: "Everyone in this workspace" },
        { label: "Added", value: "18 Aug 2026, 12:30 UTC" },
        { label: "Last used", value: "3 Oct 2026" },
      ],
    },
  },
);
const DELETES = [GMAIL, DRIVE, LINEAR_OLD, LINEAR_NEWER];

/** Other kinds of change, to show the same naming everywhere. */
const SCHEDULE = scene(
  "kit-schedule",
  {
    id: "deleteScheduledTask",
    pathParameters: { workspaceId: WORKSPACE, taskId: "5d0c7a9e-2f61-4c55-9a43-0f7b1c9f3e21" },
  },
  {
    taskId: {
      kind: "scheduled task",
      name: "Weekly metrics digest",
      facts: [
        { label: "Runs", value: "Mondays at 08:00 (Europe/Oslo)" },
        { label: "Created by", value: "anna@example.com" },
      ],
    },
  },
);
const MEMBER = scene(
  "kit-member",
  {
    id: "removeWorkspaceMember",
    pathParameters: { workspaceId: WORKSPACE, subjectId: "user_2tQ8wR1nKc" },
  },
  {
    subjectId: {
      kind: "member",
      name: "Ola Nordmann",
      account: "ola@example.com",
      facts: [{ label: "Role", value: "Admin" }],
    },
  },
);
const OTHER_WORKSPACE_KEY = scene(
  "kit-key",
  {
    id: "deleteApiKey",
    pathParameters: {
      workspaceId: "8b2f1c44-6a0e-4d1b-9b7e-3c5d2e1f0a99",
      apiKeyId: "0c9e4f2a-1b3d-4e5f-8a7b-6c5d4e3f2a1b",
    },
  },
  {
    workspaceId: { kind: "workspace", name: "Marketing" },
    apiKeyId: {
      kind: "API key",
      name: "Zapier export",
      facts: [
        { label: "Starts with", value: "og_live_7Kp…" },
        { label: "Last used", value: "29 Oct 2026" },
      ],
    },
  },
);
const MISSING = deleteConnection("kit-missing", "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f", {
  connectionId: { kind: "connection" },
});
const SCENES = [...DELETES, SCHEDULE, MEMBER, OTHER_WORKSPACE_KEY, MISSING];

const loadReview = async (approval: PendingApproval): Promise<ToolActionReview> => {
  const found = SCENES.find((entry) => entry.approval.id === approval.id);
  if (!found) throw new OpenGeniApiError(404, "Review not found");
  return found.review;
};

const loadDetails = async (review: ToolActionReview, path: string, offset: number) => {
  const found = SCENES.find((entry) => entry.approval.id === review.id)!;
  return {
    version: 1 as const,
    id: review.id,
    actionDigest: review.actionDigest,
    ...toolReviewDetails(
      found.approval.arguments,
      found.context,
      path,
      offset,
      25,
      "admin_action_call",
    ),
  };
};

function Surface({ scenes }: { scenes: Scene[] }) {
  return (
    <ApprovalSurface
      approvals={scenes.map((entry) => entry.approval)}
      loadReview={loadReview}
      loadDetails={loadDetails}
      onApprove={async () => wait(900)}
      onReject={async () => wait(900)}
    />
  );
}

const asked = (scenes: Scene[]) =>
  kitEvent("session.requiresAction", {
    approvals: scenes.map((entry) => ({
      ...entry.approval,
      rawItem: { callId: entry.approval.id },
      ...(entry.context.targetFacts?.length ? { targetFacts: entry.context.targetFacts } : {}),
    })),
  });
const decided = (entry: Scene, decision: "approve" | "reject") =>
  kitEvent("user.approvalDecision", { approvalId: entry.approval.id, decision });

export default function ChatAppActionsSection() {
  return (
    <SecretsUiProvider value={webSecretsUi}>
      <KitSection sectionKey="chat-app-actions">
        {showPart("pending") ? (
          <KitBlock
            title="Four connection removals waiting"
            description="Each card names the connection and account; the facts tell the two Linear ones apart."
          >
            <ChatFrame
              events={[
                ...lead(
                  "Clean up the duplicate connections in staging.",
                  "I found four duplicates. Each removal needs your OK.",
                ),
                asked(DELETES),
              ]}
              height={760}
            >
              <Surface scenes={DELETES} />
            </ChatFrame>
          </KitBlock>
        ) : null}

        {showPart("each") ? (
          <StatesGrid title="The four cards" columns={2}>
            {DELETES.map((entry, index) => (
              <StateCell key={entry.approval.id} label={`${index + 1} of 4`} align="stretch">
                <Surface scenes={[entry]} />
              </StateCell>
            ))}
          </StatesGrid>
        ) : null}

        {showPart("history") ? (
          <KitBlock
            title="Answered"
            description="The history says what was decided, one line per action."
          >
            <ChatFrame
              events={[
                ...lead(
                  "Clean up the duplicate connections in staging.",
                  "I found four duplicates. Each removal needs your OK.",
                ),
                asked(DELETES),
                decided(GMAIL, "approve"),
                decided(DRIVE, "reject"),
                decided(LINEAR_OLD, "approve"),
                decided(LINEAR_NEWER, "approve"),
                kitEvent("session.status.changed", { status: "running" }),
                kitEvent("agent.message.completed", {
                  text: "Removed the older Gmail connection and both broken Linear connections. I kept the Google Drive connection, as you asked.",
                }),
                asked([SCHEDULE]),
              ]}
              height={820}
            >
              <Surface scenes={[SCHEDULE]} />
            </ChatFrame>
          </KitBlock>
        ) : null}

        {showPart("kinds") ? (
          <StatesGrid title="Other changes" columns={2}>
            <StateCell label="Scheduled task" align="stretch">
              <Surface scenes={[SCHEDULE]} />
            </StateCell>
            <StateCell label="Workspace member" align="stretch">
              <Surface scenes={[MEMBER]} />
            </StateCell>
            <StateCell label="In another workspace" align="stretch">
              <Surface scenes={[OTHER_WORKSPACE_KEY]} />
            </StateCell>
            <StateCell label="Not found" align="stretch">
              <Surface scenes={[MISSING]} />
            </StateCell>
          </StatesGrid>
        ) : null}
      </KitSection>
    </SecretsUiProvider>
  );
}
