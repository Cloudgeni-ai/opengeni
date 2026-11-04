import {
  APP_ACTION_CALL_TOOL_NAME,
  appActionCallNeedsConfirmation,
  appActionCallHandlesSecrets,
  appActionConfirmationTitle,
  appActionTargetFacts,
  type AppActionTargets,
} from "@opengeni/contracts/app-actions";
import type { Settings } from "@opengeni/config";
import {
  prefixedMcpToolName,
  type ConnectorActionPolicyHooks,
  type ConnectorActionToolCall,
} from "@opengeni/runtime";
import { videoPolicyCardPrice } from "../video-generation-availability";

/** As whom this turn's app actions run; see resolveSessionAppActionAuthority. */
export type AppActionAuthorityKind = "full_access" | "confirm" | "read_only" | "unavailable";

/** The live check's answer: how changes run, and for whom when a person asks. */
export type AppActionAuthority = {
  kind: AppActionAuthorityKind;
  /** The person the chat acts for, when there is one. */
  subjectId?: string;
};

/** The person a card's targets are read as; what they may see is read live. */
export type AppActionReader = { subjectId: string };

const APP_ACTION_CALL_MODEL_NAME = prefixedMcpToolName("opengeni", APP_ACTION_CALL_TOOL_NAME);

/** The chat asking, and the deployment settings that price what it asks. */
type AppActionChat = { workspaceId: string; sessionId: string; settings?: Settings };

/** What one confirmation card shows: its question and the facts under it. */
export type AppActionApprovalCard = {
  title: string;
  targetFacts: Array<{ label: string; value: string }>;
};

/**
 * The card's question, plus the price when the change starts something paid
 * (turning on video paid with Opengeni credits), so one yes covers the cost.
 */
function confirmationTitle(args: unknown, chat: AppActionChat, targets?: AppActionTargets): string {
  const title = appActionConfirmationTitle(args, chat, targets);
  const price = chat.settings ? videoPolicyCardPrice(chat.settings, args) : null;
  const full = price ? `${title} ${price}` : title;
  // The saved review's title holds at most 256 characters. Cut by code
  // point, so half an emoji never reaches the saved review's JSON.
  if (full.length <= TITLE_LIMIT) return full;
  let cut = "";
  for (const point of full) {
    if (cut.length + point.length > TITLE_LIMIT - 1) break;
    cut += point;
  }
  return `${cut.trimEnd()}…`;
}

const TITLE_LIMIT = 256;

/**
 * Word an app action's pending approval as the same plain question its saved
 * review asks, so every surface that draws the approval from the event alone
 * (embeds, the session-ui components, the chat's history) shows it too:
 * `cards` holds what this attempt's reviews saved, by call id, and its facts
 * ride along so history can tell two alike apart; a call without one is
 * worded from its checked arguments. Presentation only.
 */
export function withAppActionApprovalTitle(
  approval: unknown,
  chat: AppActionChat & { cards?: ReadonlyMap<string, AppActionApprovalCard> },
): unknown {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return approval;
  const item = approval as Record<string, unknown>;
  const raw =
    item.rawItem && typeof item.rawItem === "object" && !Array.isArray(item.rawItem)
      ? (item.rawItem as Record<string, unknown>)
      : {};
  if ((item.name ?? item.toolName ?? raw.name) !== APP_ACTION_CALL_MODEL_NAME) return approval;
  const display =
    item.display && typeof item.display === "object" && !Array.isArray(item.display)
      ? (item.display as Record<string, unknown>)
      : {};
  const callId = raw.callId ?? item.callId ?? item.id;
  const saved = typeof callId === "string" ? chat.cards?.get(callId) : undefined;
  return {
    ...item,
    display: {
      ...display,
      toolName: APP_ACTION_CALL_TOOL_NAME,
      title: saved?.title ?? confirmationTitle(item.arguments ?? raw.arguments, chat),
    },
    // Beside the display, which older clients parse strictly.
    ...(saved && saved.targetFacts.length > 0 ? { targetFacts: saved.targetFacts } : {}),
  };
}

/**
 * Decide, per admin_action_call, whether it waits for the person's
 * confirmation in the chat: a change in a session without full access does,
 * with a plain question as the card's title that names what it changes, as
 * `targets` reads it from Opengeni's own records (never the call's text),
 * and the facts that tell it apart. A read, a full-access session,
 * and anything the API refuses whatever the answer (an action that handles
 * secrets, a change from a read-only embed, a turn where the route is
 * unavailable) run without a card, so nobody is asked to allow what can't run. The API checks the confirmation again before a
 * change runs. Every other call passes through untouched.
 *
 * One call keeps its first decision and wording within an attempt, so its
 * preparation, execution and pending event always agree; `cards` receives
 * each card by call id for the pending event.
 */
export function withAppActionConfirmation(
  policy: ConnectorActionPolicyHooks,
  chat: AppActionChat & {
    authority: () => Promise<AppActionAuthority>;
    /** What the call's ids name, read as the person the chat acts for. */
    targets?: (args: unknown, reader: AppActionReader) => Promise<AppActionTargets>;
    /**
     * The card a previous attempt saved for this call, so a resumed attempt
     * asks with the same words instead of reading its targets again.
     */
    saved?: (approvalId: string) => Promise<AppActionApprovalCard | undefined>;
    cards?: Map<string, AppActionApprovalCard>;
  },
): ConnectorActionPolicyHooks {
  // In flight too, so parallel hooks for one call share one decision.
  const decided = new Map<string, Promise<AppActionApprovalCard | null>>();
  const decide = async (call: ConnectorActionToolCall): Promise<ConnectorActionToolCall> => {
    if (call.serverId !== "opengeni" || call.toolName !== APP_ACTION_CALL_TOOL_NAME) return call;
    let pending = decided.get(call.approvalId);
    if (!pending) {
      pending = (async () => {
        const authority =
          appActionCallNeedsConfirmation(call.arguments) &&
          !appActionCallHandlesSecrets(call.arguments)
            ? await chat.authority()
            : null;
        if (authority?.kind !== "confirm") return null;
        const card =
          (await chat.saved?.(call.approvalId).catch(() => undefined)) ??
          (await cardFor(call.arguments, authority));
        chat.cards?.set(call.approvalId, card);
        return card;
      })();
      decided.set(call.approvalId, pending);
      // A failed decision is decided again next time.
      pending.catch(() => decided.delete(call.approvalId));
    }
    const card = await pending;
    if (card) {
      // The card's own facts only: none when it has none.
      const { targetFacts: _earlier, ...context } = call.reviewContext ?? {};
      return {
        ...call,
        approvalMode: "session_mcp",
        defaultDecision: "ask",
        reviewContext: {
          kind: "generic",
          ...context,
          title: card.title,
          ...(card.targetFacts.length > 0 ? { targetFacts: card.targetFacts } : {}),
        },
      };
    }
    const { approvalMode: _approvalMode, ...rest } = call;
    return { ...rest, defaultDecision: "allow" };
  };
  const cardFor = async (
    args: unknown,
    authority: AppActionAuthority,
  ): Promise<AppActionApprovalCard> => {
    // Targets are read only as the person asked; a lookup that fails keeps
    // the plain wording, and the card still asks.
    const targets =
      chat.targets && authority.subjectId
        ? await chat.targets(args, { subjectId: authority.subjectId }).catch(() => undefined)
        : undefined;
    return {
      title: confirmationTitle(args, chat, targets),
      targetFacts: appActionTargetFacts(args, chat, targets),
    };
  };
  return {
    ...(policy.preview
      ? { preview: async (call) => await policy.preview!(await decide(call)) }
      : {}),
    prepare: async (call) => await policy.prepare(await decide(call)),
    begin: async (call) => await policy.begin(await decide(call)),
    complete: policy.complete,
  };
}
