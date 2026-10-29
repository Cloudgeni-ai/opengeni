import {
  isMcpElicitationUrlQuestion,
  mcpElicitationKind,
  mcpElicitationUrlHost,
  type McpElicitationApprovalRequest,
  type McpElicitationKind,
  type ToolActionReview,
} from "@opengeni/contracts";
import type { SlackMessageBlock } from "./slack-bot";

/** Action ids of a server question's "Open <host>" link buttons, numbered per page. */
const SERVER_QUESTION_PAGE_ACTION = "opengeni.approval.open_page";

/**
 * An MCP server's question, as plain text from the approval event itself so a
 * replayed post has the same bytes. Slack answers a plain confirmation, and a
 * page to open (a link button naming its host, then Continue), when it is
 * short enough to show whole. Anything to fill in is answered in the session,
 * because a Slack form needs a modal opened within three seconds of the click
 * and decisions here go through the durable action queue.
 */
export function slackServerQuestion(question: McpElicitationApprovalRequest): {
  block: SlackMessageBlock;
  kind: McpElicitationKind;
  answerableInSlack: boolean;
  /** Link buttons for the pages a `url` question asks the person to open. */
  pageButtons: Array<Extract<SlackMessageBlock, { type: "actions" }>["elements"][number]>;
} {
  const text = [
    `${question.server} asks:`,
    ...question.requests.map((request) => request.message.trim()).filter(Boolean),
  ].join("\n");
  const fits = text.length <= 2800;
  const kind = mcpElicitationKind(question);
  const pageButtons =
    kind === "url"
      ? question.requests.filter(isMcpElicitationUrlQuestion).flatMap((request, index) => {
          const host = mcpElicitationUrlHost(request.url);
          return host && request.url.length <= 3000
            ? [
                {
                  type: "button" as const,
                  action_id: `${SERVER_QUESTION_PAGE_ACTION}.${index}`,
                  url: request.url,
                  text: { type: "plain_text" as const, text: `Open ${host}`.slice(0, 75) },
                },
              ]
            : [];
        })
      : [];
  return {
    block: {
      type: "section",
      text: { type: "plain_text", text: fits ? text : `${text.slice(0, 2799)}…` },
    },
    kind,
    answerableInSlack:
      fits &&
      (kind === "confirm" ||
        (kind === "url" &&
          pageButtons.length === question.requests.filter(isMcpElicitationUrlQuestion).length)),
    pageButtons,
  };
}

/**
 * A click on a server question's page link: Slack opens the page in the
 * browser and still reports the click, which is acknowledged and never queued.
 */
export function isSlackServerQuestionPageAction(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const { type, actions } = payload as { type?: unknown; actions?: unknown };
  if (type !== "block_actions" || !Array.isArray(actions) || actions.length !== 1) return false;
  const action = actions[0] as { action_id?: unknown } | null;
  return (
    typeof action?.action_id === "string" &&
    /^opengeni\.approval\.open_page\.\d{1,2}$/u.test(action.action_id)
  );
}

/** Shared review facts, projected only into a proven private bot conversation. */
export function slackToolReviewCanDecide(review: ToolActionReview): boolean {
  // Delivery retries belong to the original review event. Its content must not
  // change when a later decision changes status, revision or availableActions.
  return (
    review.detailsAvailable &&
    reviewLines(review).every((line) => line.length <= 2800) &&
    JSON.stringify({
      title: review.title,
      account: review.accountLabel,
      consequence: review.consequence,
      effects: review.effects,
      samples: review.samples,
      fields: review.fields,
      moreFields: review.moreFields,
      reason: review.reason,
    }).length <= 6000
  );
}

export function slackToolReviewBlocks(
  review: ToolActionReview,
  privateAudience: boolean,
): SlackMessageBlock[] {
  if (!privateAudience || !slackToolReviewCanDecide(review))
    return [
      {
        type: "section",
        text: {
          type: "plain_text",
          text: "An action needs review. Open the task to review its private details.",
        },
      },
    ];
  const lines = reviewLines(review);
  const blocks: SlackMessageBlock[] = [];
  let text = "";
  for (const line of lines) {
    if (text && text.length + line.length + 1 > 2800) {
      blocks.push({ type: "section", text: { type: "plain_text", text } });
      text = "";
    }
    text += `${text ? "\n" : ""}${line}`;
  }
  if (text) blocks.push({ type: "section", text: { type: "plain_text", text } });
  return blocks;
}

function reviewLines(review: ToolActionReview): string[] {
  return [
    review.title,
    review.accountLabel,
    review.consequence,
    ...review.effects,
    ...(review.samples ?? []).map((sample) =>
      [sample.title, sample.subtitle].filter(Boolean).join(" — "),
    ),
    ...review.fields.map((field) => `${field.label}: ${field.preview}`),
    review.moreFields ? `${review.moreFields} more fields in full details.` : null,
    review.reason,
  ].filter((line): line is string => Boolean(line));
}
