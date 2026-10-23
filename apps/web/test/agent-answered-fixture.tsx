// A sub-session page after its question was answered: the real timeline (with
// the app's readable turns), composer and styles. `?who=agent` (default) shows
// the parent agent's answer, `?who=person` the same question answered by the
// person; `?open` expands the turn's work details; `?light` for the light theme.
import { ChatComposer, DisclosureDefaultsProvider, MessageTimeline } from "@opengeni/react";
import type { SessionEvent } from "@opengeni/sdk";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import {
  emptyAttachments,
  GALLERY_SESSION_ID,
  GALLERY_WORKSPACE_ID,
  idleComposer,
} from "../src/dev/composer-chrome-fixtures";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
if (params.has("light")) document.documentElement.dataset.ogTheme = "light";
const respondedByKind = params.get("who") === "person" ? "human" : "agent_attempt";
const open = params.has("open");

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function childTimeline(): SessionEvent[] {
  const event = (sequence: number, type: string, payload: unknown) =>
    ({
      id: `child-${sequence}`,
      workspaceId: GALLERY_WORKSPACE_ID,
      sessionId: GALLERY_SESSION_ID,
      sequence,
      type,
      payload,
      occurredAt: minutesAgo(12 - sequence),
      turnId: "turn-1",
    }) as SessionEvent;
  const questions = [
    {
      id: "base",
      kind: "single_select",
      label: "Target branch",
      prompt: "The fix also applies to the release branch. Where should it land?",
      options: [
        { id: "main", label: "main only" },
        { id: "both", label: "main and release/2026.10" },
      ],
      required: true,
      allowOther: true,
    },
  ];
  return [
    event(1, "user.message", {
      text: "Review PR #4418 and land the fix where it belongs.",
    }),
    event(2, "turn.started", {}),
    event(3, "agent.message.completed", {
      messageId: "m1",
      text: "The review is done and the fix is correct. Before merging I need to know which branches it should land on.",
    }),
    event(4, "agent.toolCall.created", {
      id: "ask-1",
      name: "request_human_input",
      arguments: { questions },
    }),
    event(5, "session.humanInput.requested", {
      request: { id: "review-base", toolCallId: "ask-1", questions },
    }),
    event(6, "user.humanInputResponse", {
      requestId: "review-base",
      respondedByKind,
      response: { outcome: "answered", answers: [{ questionId: "base", values: ["both"] }] },
    }),
    event(7, "agent.toolCall.output", {
      id: "ask-1",
      output: JSON.stringify({ requestId: "review-base", outcome: "answered" }),
    }),
    event(8, "agent.message.completed", {
      messageId: "m2",
      text: "Landing it on main and release/2026.10. I'll open the backport after the main merge.",
    }),
    event(9, "turn.completed", {}),
  ];
}

function Page() {
  const events = useMemo(() => childTimeline(), []);
  return (
    <TooltipProvider>
      <div className="flex h-dvh min-h-0 flex-col bg-bg text-fg">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 text-sm font-medium">
          Review PR #4418
        </header>
        <div className="min-h-0 flex-1">
          <DisclosureDefaultsProvider defaultOpen={open}>
            <MessageTimeline className="h-full" events={events} turnSummary={{ rolling: true }} />
          </DisclosureDefaultsProvider>
        </div>
        <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            <ChatComposer
              composer={idleComposer({ value: "", canSend: false })}
              attachments={emptyAttachments()}
              placeholder="Message"
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
