import { useEffect, useRef, type ReactNode } from "react";
import { HumanInputForm, HumanInputSurface, SecretsUiProvider } from "@opengeni/react/session-ui";
import { MessageTimeline } from "@opengeni/react";
import type { HumanInputQuestion, SessionHumanInputRequest, SessionEvent } from "@opengeni/sdk";

import { webSecretsUi } from "@opengeni/react/app/lib/secrets-ui";
import { KitBlock, KitSection, StateCell, StatesGrid } from "../kit";
import { ChatFrame, kitEvent, lead, showPart } from "./chat-shared";

/* ----------------------------------------------------------------------------
   Every kind of agent question (request_human_input), rendered by the real
   @opengeni/react components: in a chat frame as people meet them, then the
   states, then how answers read afterwards in the timeline.
   -------------------------------------------------------------------------- */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const IN_TWO_HOURS = new Date(Date.now() + 2 * 3_600_000).toISOString();

function q(
  id: string,
  kind: HumanInputQuestion["kind"],
  prompt: string,
  extra: Partial<HumanInputQuestion> = {},
): HumanInputQuestion {
  return {
    id,
    kind,
    prompt,
    options: [],
    required: true,
    allowOther: kind === "single_select" || kind === "multi_select",
    ...extra,
  } as HumanInputQuestion;
}

function request(
  id: string,
  questions: HumanInputQuestion[],
  extra: Partial<SessionHumanInputRequest> = {},
): SessionHumanInputRequest {
  return {
    id: `kit-${id}`,
    questions,
    allowSkip: false,
    expiresAt: null,
    status: "pending",
    createdAt: "2026-09-26T11:48:00Z",
    ...extra,
  } as SessionHumanInputRequest;
}

const DATABASE = q(
  "database",
  "single_select",
  "Which database should the new billing service use?",
  {
    helpText: "I can migrate later, but the first schema lands today.",
    options: [
      {
        id: "postgres",
        label: "PostgreSQL (recommended)",
        description:
          "Matches the other services; the team already runs backups and failover for it.",
      },
      {
        id: "sqlite",
        label: "SQLite",
        description: "Simplest to start with, but one writer at a time.",
      },
      {
        id: "dynamo",
        label: "DynamoDB",
        description: "Scales without tuning; queries across customers get harder.",
      },
    ],
  },
);

const REMINDER = q(
  "send",
  "single_select",
  "Send the payment reminder to all 14 overdue customers now?",
  {
    allowOther: false,
    options: [
      { id: "send", label: "Send now" },
      { id: "wait", label: "Not yet" },
    ],
  },
);

const ENVIRONMENTS = q("envs", "multi_select", "Where should I deploy version 2.4?", {
  options: [
    { id: "staging", label: "Staging" },
    { id: "eu", label: "Production EU", description: "About 60% of traffic" },
    { id: "us", label: "Production US", description: "About 40% of traffic" },
    { id: "canary", label: "Canary only" },
  ],
});

// Agent-marked hints: a recommended option, a yes/no confirm in the agent's
// own words, and per-option previews.
const DATABASE_RECOMMENDED = q(
  "database-r",
  "single_select",
  "Which database should the new billing service use?",
  {
    helpText: "I can migrate later, but the first schema lands today.",
    options: [
      {
        id: "postgres",
        label: "PostgreSQL",
        recommended: true,
        description:
          "Matches the other services; the team already runs backups and failover for it.",
      },
      {
        id: "sqlite",
        label: "SQLite",
        description: "Simplest to start with, but one writer at a time.",
      },
      {
        id: "dynamo",
        label: "DynamoDB",
        description: "Scales without tuning; queries across customers get harder.",
      },
    ],
  },
);

const REMINDER_CONFIRM = q(
  "send-c",
  "single_select",
  "Send the payment reminder to all 14 overdue customers now?",
  {
    confirm: true,
    options: [
      { id: "send", label: "Send 14 reminders", description: "They go out from billing@." },
      { id: "wait", label: "Not yet" },
    ],
  },
);

const SUBJECT_PREVIEWS = q("subject", "single_select", "Which subject line should I use?", {
  label: "Subject line",
  options: [
    {
      id: "plain",
      label: "Plain",
      recommended: true,
      preview: "Your invoice for October is ready",
    },
    {
      id: "friendly",
      label: "Friendly",
      preview: "Hi Sam, here's October's invoice (and a thank-you)",
    },
    {
      id: "urgent",
      label: "With the due date",
      preview: "Invoice #4821 is due on 3 November",
    },
  ],
});

const HEADLINE = q("headline", "text", "What should the release notes headline say?", {
  helpText: "One line. I'll write the rest from the merged changes.",
});

const TRIP = [
  q("dates", "single_select", "Which week works for the offsite?", {
    options: [
      { id: "w45", label: "3 to 7 November" },
      { id: "w46", label: "10 to 14 November" },
      { id: "w47", label: "17 to 21 November", description: "Cheapest flights" },
    ],
  }),
  q("needs", "multi_select", "What does the venue need?", {
    required: false,
    options: [
      { id: "rooms", label: "Breakout rooms" },
      { id: "av", label: "Projector and sound" },
      { id: "food", label: "Catering" },
      { id: "access", label: "Step-free access" },
    ],
  }),
  q("budget", "text", "Budget per person, roughly?", { label: "Budget", required: false }),
];

const LONG = q(
  "migration",
  "single_select",
  "The `orders` table has **2.3 million rows** and the migration adds a non-null `region` column. How should I run it? See the [migration plan](https://example.com/plan) for the full timings.",
  {
    options: [
      {
        id: "online",
        label: "Backfill in batches of 10,000 while the app stays up, then add the constraint",
        description:
          "About 40 minutes. Reads and writes keep working; the constraint is added in a short lock at the end.",
      },
      {
        id: "window",
        label: "Take a 5-minute maintenance window tonight at 23:00",
        description: "Fastest and simplest, but checkout is down for the window.",
      },
      { id: "default", label: "Add the column with a default and skip the backfill" },
    ],
  },
);

function Form({
  request: value,
  decisionButtons,
  submitting,
  error,
  defaultCollapsed,
}: {
  request: SessionHumanInputRequest;
  decisionButtons?: boolean;
  submitting?: boolean;
  error?: string;
  defaultCollapsed?: boolean;
}) {
  return (
    <HumanInputForm
      request={value}
      autoFocus={false}
      decisionButtons={decisionButtons}
      submitting={submitting}
      error={error ?? null}
      defaultCollapsed={defaultCollapsed}
      onSubmit={async () => {
        await wait(900);
      }}
    />
  );
}

/** Clicks or types into a rendered form once, so a state can be screenshotted. */
function Drive({
  children,
  click,
  check,
}: {
  children: ReactNode;
  click?: string;
  check?: string[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root) return;
      for (const label of check ?? []) {
        [...root.querySelectorAll("label")]
          .find((node) => node.textContent?.trim().startsWith(label))
          ?.click();
      }
      if (click === "submit")
        root.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    return () => cancelAnimationFrame(frame);
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className="min-w-0">
      {children}
    </div>
  );
}

/* ---- answered history ------------------------------------------------------ */

function answered(value: SessionHumanInputRequest, response: unknown): SessionEvent[] {
  return [
    kitEvent("session.humanInput.requested", { request: value }),
    kitEvent("user.humanInputResponse", { requestId: value.id, response }),
    kitEvent("agent.message.completed", { text: "Thanks, carrying on with that." }),
    kitEvent("turn.completed", {}),
  ];
}

const SELECT_ANSWER = answered(request("h-db", [DATABASE]), {
  outcome: "answered",
  answers: [{ questionId: "database", values: ["postgres"] }],
});
const OTHER_ANSWER = answered(request("h-other", [DATABASE]), {
  outcome: "answered",
  answers: [
    { questionId: "database", values: [], other: "CockroachDB, we already have a cluster" },
  ],
});
const FORM_ANSWER = answered(request("h-trip", TRIP), {
  outcome: "answered",
  answers: [
    { questionId: "dates", values: ["w47"] },
    { questionId: "needs", values: ["rooms", "food"] },
    { questionId: "budget", values: ["About 400 euros"] },
  ],
});
const SKIPPED = answered(request("h-skip", [HEADLINE], { allowSkip: true }), {
  outcome: "skipped",
});
const EXPIRED = answered(request("h-exp", [ENVIRONMENTS]), { outcome: "expired" });

export default function ChatQuestionsSection() {
  const database = request("database", [DATABASE]);
  return (
    <SecretsUiProvider value={webSecretsUi}>
      <KitSection sectionKey="chat-questions">
        {showPart("chat") ? (
          <KitBlock
            title="In the chat"
            description="The question sits at the end of the conversation, under the agent's last message."
          >
            <ChatFrame
              events={[
                ...lead(
                  "Set up the billing service we talked about.",
                  "I've scaffolded the service and the API routes. Before I write the first migration I need one decision from you.",
                ),
                kitEvent("session.humanInput.requested", { request: database }),
              ]}
            >
              <HumanInputSurface
                requests={[database]}
                autoFocus={false}
                onSubmit={async () => wait(900)}
              />
            </ChatFrame>
          </KitBlock>
        ) : null}

        {showPart("kinds") ? (
          <StatesGrid title="Kinds" columns={2}>
            <StateCell label="One choice, with descriptions" align="stretch">
              <Form request={database} />
            </StateCell>
            <StateCell label="Yes or no, console (radio list)" align="stretch">
              <Form request={request("reminder", [REMINDER])} />
            </StateCell>
            <StateCell label="Yes or no, embedded chat (two buttons)" align="stretch">
              <Form
                request={request("reminder-b", [REMINDER], { allowSkip: true })}
                decisionButtons
              />
            </StateCell>
            <StateCell label="Several choices" align="stretch">
              <Form request={request("envs", [ENVIRONMENTS])} />
            </StateCell>
          </StatesGrid>
        ) : null}
        {showPart("hints") ? (
          <StatesGrid title="Agent hints" columns={2}>
            <StateCell label="A recommended option" align="stretch">
              <Form request={request("database-r", [DATABASE_RECOMMENDED])} />
            </StateCell>
            <StateCell label="Yes or no in the agent's words (confirm)" align="stretch">
              <Form request={request("reminder-c", [REMINDER_CONFIRM], { allowSkip: true })} />
            </StateCell>
            <StateCell label="Options with previews" align="stretch" span="full">
              <Form request={request("subject", [SUBJECT_PREVIEWS])} />
            </StateCell>
          </StatesGrid>
        ) : null}
        {showPart("kinds2") ? (
          <StatesGrid title="Kinds" columns={2}>
            <StateCell label="Free text" align="stretch">
              <Form request={request("headline", [HEADLINE], { allowSkip: true })} />
            </StateCell>
            <StateCell label="Long question with Markdown" align="stretch">
              <Form request={request("long", [LONG])} />
            </StateCell>
            <StateCell label="Three questions, deadline and Skip" align="stretch" span="full">
              <Form request={request("trip", TRIP, { allowSkip: true, expiresAt: IN_TWO_HOURS })} />
            </StateCell>
          </StatesGrid>
        ) : null}

        {showPart("states") ? (
          <StatesGrid title="States" columns={2}>
            <StateCell label="Two questions waiting (1 of 2)" align="stretch">
              <HumanInputSurface
                requests={[
                  request("p1", [HEADLINE]),
                  request("p2", [ENVIRONMENTS], { createdAt: "2026-09-26T11:49:00Z" }),
                ]}
                autoFocus={false}
                onSubmit={async () => wait(900)}
              />
            </StateCell>
            <StateCell label="Collapsed" align="stretch">
              <Form
                request={request("collapsed", [DATABASE], { expiresAt: IN_TWO_HOURS })}
                defaultCollapsed
              />
            </StateCell>
            <StateCell label="Other picked" align="stretch">
              <Drive check={["Other"]}>
                <Form request={request("other", [DATABASE])} />
              </Drive>
            </StateCell>
          </StatesGrid>
        ) : null}
        {showPart("states2") ? (
          <StatesGrid title="States" columns={2}>
            <StateCell label="Missing answer" align="stretch">
              <Drive click="submit">
                <Form request={request("missing", [DATABASE])} />
              </Drive>
            </StateCell>
            <StateCell label="Sending" align="stretch">
              <Drive check={["PostgreSQL"]}>
                <Form request={request("sending", [DATABASE])} submitting />
              </Drive>
            </StateCell>
            <StateCell label="Send failed" align="stretch">
              <Form
                request={request("failed", [DATABASE])}
                error="Your answer wasn't sent. Try again."
              />
            </StateCell>
          </StatesGrid>
        ) : null}

        {showPart("history") ? (
          <StatesGrid
            title="After answering"
            description="How the answer reads in the conversation later."
            columns={2}
          >
            <StateCell label="One choice" align="stretch">
              <MessageTimeline events={SELECT_ANSWER} />
            </StateCell>
            <StateCell label="Other" align="stretch">
              <MessageTimeline events={OTHER_ANSWER} />
            </StateCell>
            <StateCell label="Three questions" align="stretch">
              <MessageTimeline events={FORM_ANSWER} />
            </StateCell>
            <StateCell label="Skipped" align="stretch">
              <MessageTimeline events={SKIPPED} />
            </StateCell>
            <StateCell label="Expired" align="stretch">
              <MessageTimeline events={EXPIRED} />
            </StateCell>
          </StatesGrid>
        ) : null}
      </KitSection>
    </SecretsUiProvider>
  );
}
