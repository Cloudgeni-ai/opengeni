import { useState } from "react";
import type { SessionEvent } from "@opengeni/sdk";
import { projectPendingApprovals } from "@opengeni/react/session";
import { ApprovalSurface } from "@opengeni/react/session-ui";

import { KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";

/* ----------------------------------------------------------------------------
   An MCP server's question in the middle of a tool call, as the real approval
   card renders it. Only the decision callbacks are fakes.
   -------------------------------------------------------------------------- */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Question = {
  id: string;
  message: string;
  requestedSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

function approvals(input: {
  name: string;
  title: string;
  args: Record<string, unknown>;
  server: string;
  requests: Question[];
}) {
  return projectPendingApprovals([
    {
      type: "session.requiresAction",
      turnId: "kit-turn",
      payload: {
        approvals: [
          {
            id: `kit-${input.name}`,
            name: input.name,
            arguments: JSON.stringify(input.args),
            display: { toolName: input.name.split("__")[1], title: input.title },
            elicitation: { server: input.server, requests: input.requests },
          },
        ],
      },
    },
  ] as SessionEvent[]);
}

const CONFIRM = approvals({
  name: "messages__send_message",
  title: "Send message",
  args: { chat: "Design team", text: "The new build is up, have a look when you can." },
  server: "Messages",
  requests: [
    {
      id: "confirm",
      message:
        "Send “The new build is up, have a look when you can.” to Design team? This chat isn't on your list of chats the agent may message on its own.",
      requestedSchema: { type: "object", properties: {} },
    },
  ],
});

const BOOKING = approvals({
  name: "calendar__book_meeting",
  title: "Book meeting",
  args: { topic: "Quarterly planning" },
  server: "Calendar",
  requests: [
    {
      id: "details",
      message: "A few details before I book “Quarterly planning”.",
      requestedSchema: {
        type: "object",
        properties: {
          room: {
            type: "string",
            title: "Room",
            oneOf: [
              { const: "small", title: "Small room, 4 people" },
              { const: "large", title: "Large room, 12 people" },
              { const: "online", title: "Online only" },
            ],
            default: "small",
          },
          attendees: {
            type: "integer",
            title: "People",
            description: "Including you.",
            minimum: 1,
            maximum: 12,
          },
          day: { type: "string", title: "Day", format: "date" },
          equipment: {
            type: "array",
            title: "Equipment",
            items: {
              anyOf: [
                { const: "screen", title: "Screen" },
                { const: "whiteboard", title: "Whiteboard" },
                { const: "camera", title: "Camera" },
              ],
            },
          },
          recurring: { type: "boolean", title: "Repeat every quarter", default: false },
          note: { type: "string", title: "Note for the invite", maxLength: 2000 },
        },
        required: ["room", "attendees", "day"],
      },
    },
  ],
});

const TIMEZONE = approvals({
  name: "calendar__book_meeting",
  title: "Book meeting",
  args: { topic: "Weekly sync" },
  server: "Calendar",
  requests: [
    {
      id: "zone",
      message: "Which time zone should the invite use?",
      requestedSchema: {
        type: "object",
        properties: {
          zone: {
            type: "string",
            title: "Time zone",
            enum: [
              "Europe/Oslo",
              "Europe/London",
              "America/New_York",
              "America/Los_Angeles",
              "Asia/Tokyo",
              "Australia/Sydney",
              "UTC",
            ],
          },
        },
        required: ["zone"],
      },
    },
  ],
});

function Card({
  pending,
  mode = "ok",
}: {
  pending: ReturnType<typeof approvals>;
  mode?: "ok" | "error" | "slow";
}) {
  const [decided, setDecided] = useState<string | null>(null);
  if (decided) {
    return <p className="text-sm text-fg-muted">{decided}</p>;
  }
  const settle = async (outcome: string) => {
    await wait(mode === "slow" ? 60_000 : 700);
    if (mode === "error") throw new Error("Couldn't send your answer. Try again.");
    setDecided(outcome);
  };
  return (
    <ApprovalSurface
      approvals={pending}
      onApprove={async (_approval, answer) =>
        await settle(`Answered: ${JSON.stringify(answer?.content ?? {})}`)
      }
      onReject={async () => await settle("Declined.")}
    />
  );
}

export default function McpQuestionSection() {
  return (
    <KitSection sectionKey="mcp-question">
      <StatesGrid
        title="Card"
        description="The question pauses the call until the person answers, however long that takes."
        columns={2}
      >
        <StateCell label="Confirmation (no fields)" align="stretch">
          <Card pending={CONFIRM} />
        </StateCell>
        <StateCell label="Form with defaults and required fields" align="stretch">
          <Card pending={BOOKING} />
        </StateCell>
        <StateCell label="Many choices become a drop-down" align="stretch">
          <Card pending={TIMEZONE} />
        </StateCell>
        <StateCell label="Sending" align="stretch" note="Answer to see the busy state.">
          <Card pending={CONFIRM} mode="slow" />
        </StateCell>
        <StateCell label="Sending fails" align="stretch" note="Answer to see the error.">
          <Card pending={CONFIRM} mode="error" />
        </StateCell>
      </StatesGrid>
      <UsageNotes
        use={[
          "An MCP server asks the person something before a tool call can finish (MCP form elicitation).",
        ]}
        avoid={[
          "Questions the agent itself asks: those use the human input form.",
          "Approving a call before it runs: that is the ordinary approval card.",
        ]}
      />
    </KitSection>
  );
}
