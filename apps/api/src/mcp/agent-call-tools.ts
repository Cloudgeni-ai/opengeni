// An agent calling the person it works for (docs/design/agent-calls.md): their
// phones ring with the system's incoming-call screen, and answering opens this
// chat's voice call, which starts by saying why the agent called. The tool
// waits while it rings and returns the outcome. Phones ring only when their
// person turned agent calls on, so the agent never chooses a device.
import {
  AGENT_CALL_REASON_MAX_CHARS,
  SessionAgentCallRingingPayload,
  type AccessGrant,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  AGENT_CALL_ANSWER_GRACE_SECONDS,
  AGENT_CALL_DECLINE_COOLDOWN_MINUTES,
  AGENT_CALL_HOURLY_LIMIT,
  getSessionInboxRecipient,
  getSessionTitles,
  placeAgentCall,
  type AgentCallRefusal,
  type AgentCallRow,
} from "@opengeni/db";
import { appendAndPublishTurnEventsFenced } from "@opengeni/events";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { currentAgentCall, finishAgentCall } from "../agent-calls";
import { personLabel, resolveMember } from "./notification-tools";

type JsonResult = (value: unknown) => {
  content: { type: "text"; text: string }[];
};

type AttemptClaims = {
  callerTurnId: string;
  callerExecutionGeneration: number;
  callerAttemptId: string;
};

export type RegisterAgentCallToolsInput = {
  server: McpServer;
  deps: ApiRouteDeps;
  grant: AccessGrant;
  sessionId: string;
  authorize: () => Promise<void>;
  attempt: () => AttemptClaims;
  json: JsonResult;
  /** Test seam: how long to wait between looks at a ringing call. */
  pollMs?: number;
  /** Test seam: how long a call rings. */
  ringSeconds?: number;
};

const POLL_MS = 1_000;
/** Settling a rung-out call waits a moment for an answer already on its way. */
const LATE_ANSWER_MS = AGENT_CALL_ANSWER_GRACE_SECONDS * 1000;

const REFUSALS: Record<AgentCallRefusal, (who: string) => string> = {
  no_phone: (who) =>
    `${who} has no phone that takes calls from agents (they turn it on in the Opengeni app's settings). Notify them instead (notify_user).`,
  busy: (who) =>
    `Another call is ringing ${who} right now. Notify them instead (notify_user), or try again in a minute if it truly cannot wait.`,
  rate_limited: (who) =>
    `This chat already called ${who} ${AGENT_CALL_HOURLY_LIMIT} times in the last hour, the limit. Notify them instead (notify_user).`,
  declined_recently: (who) =>
    `${who} declined a call from this chat in the last ${AGENT_CALL_DECLINE_COOLDOWN_MINUTES} minutes. Don't call again about it; notify them instead (notify_user).`,
};

function outcomeMessage(call: AgentCallRow, who: string): string {
  switch (call.state) {
    case "answered":
      return `${who} answered. You are now on a voice call with them in this chat: the voice side opens by saying why you called, and what they ask for reaches you as new messages here. End this turn now.`;
    case "declined":
      return `${who} declined the call. Don't call again about this; if it still needs them, notify them (notify_user) and carry on.`;
    case "missed":
      return `${who} didn't answer. They have a missed-call notice with your reason. Don't call again right away; carry on, and notify them (notify_user) if it still needs them.`;
    case "cancelled":
      return "The call was cancelled before anyone answered.";
    default:
      return `The call is still ringing ${who}.`;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function registerAgentCallTools(input: RegisterAgentCallToolsInput): void {
  const { server, deps, grant, sessionId, authorize, attempt, json } = input;
  const pollMs = input.pollMs ?? POLL_MS;

  server.registerTool(
    "call_user",
    {
      description: [
        "Phone the person who owns this session: their phone rings with the system's incoming-call screen, and if they answer you talk by voice in this chat.",
        "Only for something that cannot wait and needs them live: an outage or emergency, a decision blocking urgent work, or when they asked you to call. Everything else goes through notify_user.",
        "reason: a few words shown on the ring screen and in the chat, saying why you call ('Production is down', 'Need a yes on the refund').",
        "It rings for up to 40 seconds and returns answered, declined or missed. Answered means they are on the line: end your turn, and the call carries on in this chat. Never call again about something they declined or missed; notify them instead.",
        "It only rings phones where the person turned agent calls on; otherwise you get placed: false with why. recipient (optional): call another member of this workspace instead, by email or name, which works only if they let teammates' agents call them.",
      ].join(" "),
      inputSchema: {
        reason: z.string().trim().min(1).max(AGENT_CALL_REASON_MAX_CHARS),
        recipient: z
          .string()
          .trim()
          .min(1)
          .max(320)
          .optional()
          .describe(
            "Another workspace member to call, by email or name. Omit to call the person you work for.",
          ),
      },
    },
    async ({ reason, recipient }, extra) => {
      await authorize();
      const owner = await getSessionInboxRecipient(
        deps.db,
        grant.workspaceId,
        sessionId,
        attempt().callerTurnId,
      );
      if (!owner) {
        throw new Error(
          "This session works for no person (an API key or service started it), so there is nobody to call.",
        );
      }
      let callee = owner.subjectId;
      let member = false;
      let who = "The person";
      if (recipient) {
        const found = await resolveMember(deps, grant.workspaceId, recipient);
        if (!found) {
          throw new Error(
            `${recipient} is not a member of this workspace (or the name matches more than one member). Use their email.`,
          );
        }
        if (found.subjectId !== owner.subjectId) {
          callee = found.subjectId;
          member = true;
          who = found.label;
        }
      }
      const titles = await getSessionTitles(deps.db, grant.workspaceId, [sessionId]).catch(
        () => new Map<string, string | null>(),
      );
      const callerLabel = member
        ? await personLabel(deps, grant.workspaceId, owner.subjectId)
        : titles.get(sessionId)?.trim() || null;
      const placed = await placeAgentCall(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        calleeSubjectId: callee,
        callerSubjectId: member ? owner.subjectId : null,
        callerLabel,
        reason,
        member,
        ...(input.ringSeconds ? { ringSeconds: input.ringSeconds } : {}),
      });
      if (!placed.placed) {
        return json({
          placed: false,
          refusal: placed.refusal,
          message: REFUSALS[placed.refusal](member ? who : "The person"),
        });
      }
      const scope = {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
      };
      const claims = attempt();
      const appended = await appendAndPublishTurnEventsFenced(
        deps.db,
        deps.bus,
        grant.workspaceId,
        sessionId,
        claims.callerTurnId,
        claims.callerExecutionGeneration,
        claims.callerAttemptId,
        [
          {
            type: "session.agentCall.ringing",
            payload: SessionAgentCallRingingPayload.parse({
              callId: placed.call.id,
              calleeSubjectId: callee,
              callerLabel,
              reason: placed.call.reason,
              ringUntil: placed.call.ringUntil,
              devices: placed.call.devices,
            }),
          },
        ] as Parameters<typeof appendAndPublishTurnEventsFenced>[7],
      );
      if (!appended.accepted) {
        await finishAgentCall(deps, {
          ...scope,
          callId: placed.call.id,
          outcome: "cancelled",
        });
        throw new Error("The calling turn was replaced before the call rang.");
      }
      const signal = extra.signal;
      const deadline = Date.parse(placed.call.ringUntil);
      let call: AgentCallRow | null = placed.call;
      while (call?.state === "ringing") {
        if (signal.aborted) {
          // The turn stopped while it rang: stop ringing their phones.
          call =
            (await finishAgentCall(deps, {
              ...scope,
              callId: placed.call.id,
              outcome: "cancelled",
            })) ??
            (await currentAgentCall(deps, {
              ...scope,
              callId: placed.call.id,
            }));
          break;
        }
        await sleep(Math.max(50, Math.min(pollMs, deadline + LATE_ANSWER_MS - Date.now())), signal);
        call = await currentAgentCall(deps, {
          ...scope,
          callId: placed.call.id,
        });
        if (call?.state === "ringing" && Date.now() >= deadline + LATE_ANSWER_MS) {
          call =
            (await finishAgentCall(deps, {
              ...scope,
              callId: placed.call.id,
              outcome: "missed",
            })) ??
            (await currentAgentCall(deps, {
              ...scope,
              callId: placed.call.id,
            }));
        }
      }
      const settled = call ?? placed.call;
      return json({
        placed: true,
        callId: settled.id,
        outcome: settled.state,
        phones: settled.devices,
        message: outcomeMessage(settled, member ? who : "They"),
      });
    },
  );
}
