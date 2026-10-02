// Browser fixture for the usage allowance surfaces: the admin member list with
// its share slider, the composer notice, and the conversation refusal row
// (default and host-customized). Saves are recorded on window for assertions.
import type { SessionEvent } from "@opengeni/sdk";
import type {
  MemberAllowanceRule,
  MemberAllowanceUsage,
  WorkspaceUsageResponse,
} from "@opengeni/sdk/usage-allowances";
import { MessageTimeline } from "@opengeni/react";
import { UsageLimitNotice, UsageMemberList } from "@opengeni/react/usage";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { CONSOLE_USAGE_AMOUNTS } from "../src/lib/usage-allowances";
import "../src/styles.css";

declare global {
  interface Window {
    usageSaves: { subjectId: string; rule: MemberAllowanceRule }[];
  }
}
window.usageSaves = [];

const RESET = "2026-11-01T00:00:00+00:00";
function member(
  subjectId: string,
  used: number,
  rule: MemberAllowanceRule = null,
): MemberAllowanceUsage {
  const limit = rule && "share" in rule ? rule.share * 500_000_000 : 125_000_000;
  const fraction = used / limit;
  return {
    subjectId,
    externalIdentity: null,
    rule,
    version: 1,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    fraction,
    status: fraction >= 1 ? "exhausted" : fraction >= 0.8 ? "warning" : "ok",
    resetsAt: RESET,
  };
}

function roster(members: MemberAllowanceUsage[]): WorkspaceUsageResponse {
  const used = members.reduce((sum, row) => sum + row.used, 0);
  return {
    period: { start: "2026-10-01T00:00:00+00:00", end: RESET },
    workspace: {
      limit: 500_000_000,
      used,
      remaining: 500_000_000 - used,
      fraction: used / 500_000_000,
      status: "ok",
      resetsAt: RESET,
      includedCredits: 500_000_000,
      grantsRemaining: 0,
    },
    members,
    nextCursor: null,
  };
}

const NAMES: Record<string, string> = {
  "user:ada": "Ada Okafor",
  "user:grace": "Grace Kim",
  "user:linus": "Linus Berg",
  "user:margaret": "Margaret Hale",
};

function event(
  sequence: number,
  type: string,
  payload: unknown,
  turnId: string | null = "turn-1",
): SessionEvent {
  return {
    id: `evt-${sequence}`,
    workspaceId: "ws",
    sessionId: "session",
    sequence,
    type,
    payload,
    turnId,
    occurredAt: new Date(Date.UTC(2026, 9, 1, 9, 0, sequence)).toISOString(),
  } as SessionEvent;
}
const refusal = {
  code: "allowance_exhausted",
  scope: "member",
  subjectId: "user:grace",
  resetsAt: RESET,
  message: "The member usage allowance is exhausted.",
};
const conversation = [
  event(
    1,
    "user.message",
    { text: "Draft the onboarding checklist.", routing: "accepted_for_execution" },
    null,
  ),
  event(2, "turn.queued", {
    turnId: "turn-1",
    triggerEventId: "evt-1",
    routing: "accepted_for_execution",
  }),
  event(3, "usage.exhausted", refusal),
  event(4, "turn.completed", { ...refusal, segmentLimit: "budget_exhausted" }),
];

function Fixture() {
  const [members, setMembers] = useState(() => [
    member("user:ada", 70_000_000),
    member("user:grace", 126_000_000),
    member("user:linus", 22_900_000),
    member("user:margaret", 12_300_000),
  ]);
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 bg-background p-8 text-foreground">
      <section aria-label="Members">
        <UsageMemberList
          usage={roster(members)}
          memberDefault="equal_share"
          amounts={CONSOLE_USAGE_AMOUNTS}
          describe={(row) => ({ name: NAMES[row.subjectId] ?? row.subjectId })}
          onChangeRule={async (row, rule) => {
            window.usageSaves.push({ subjectId: row.subjectId, rule });
            setMembers((current) =>
              current.map((candidate) =>
                candidate.subjectId === row.subjectId
                  ? member(row.subjectId, row.used, rule)
                  : candidate,
              ),
            );
          }}
        />
      </section>
      <section aria-label="Composer notice" className="rounded-xl border">
        <UsageLimitNotice usage={roster([member("user:grace", 126_000_000)])} />
      </section>
      <section aria-label="Default conversation" className="h-72">
        <MessageTimeline events={conversation} />
      </section>
      <section aria-label="Host conversation" className="h-72">
        <MessageTimeline
          events={conversation}
          renderAllowanceExhausted={(typed) => (
            <p role="status" data-host-refusal={typed.scope}>
              You've used this month's plan. <a href="#upgrade">Ask your admin for more</a>
            </p>
          )}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
