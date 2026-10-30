import {
  mcpElicitationKind,
  type McpElicitationApprovalRequest,
  type McpElicitationKind,
  type ToolActionReview,
} from "@opengeni/contracts";
import type { SlackMessageBlock } from "./slack-bot";

/**
 * An MCP server's question, as plain text from the approval event itself so a
 * replayed post has the same bytes. Slack answers a plain confirmation when it
 * is short enough to show whole. Anything to fill in is answered in the
 * session, because a Slack form needs a modal opened within three seconds of
 * the click and decisions here go through the durable action queue.
 */
export function slackServerQuestion(question: McpElicitationApprovalRequest): {
  block: SlackMessageBlock;
  kind: McpElicitationKind;
  answerableInSlack: boolean;
} {
  const text = [
    `${question.server} asks:`,
    ...question.requests.map((request) => request.message.trim()).filter(Boolean),
  ].join("\n");
  const fits = text.length <= 2800;
  const kind = mcpElicitationKind(question);
  return {
    block: {
      type: "section",
      text: { type: "plain_text", text: fits ? text : `${text.slice(0, 2799)}…` },
    },
    kind,
    answerableInSlack: fits && kind === "confirm",
  };
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
  const fields = review.fields.map((field) => `${field.label}: ${field.preview}`);
  // An app action's fields are what the server found about its target; they
  // come right under the question, before anything the agent sent.
  const serverFacts = review.fields.some((field) => field.path.startsWith("/$target/"));
  return [
    review.title,
    ...(serverFacts ? fields : []),
    review.accountLabel,
    review.consequence,
    ...review.effects,
    ...(review.samples ?? []).map((sample) =>
      [sample.title, sample.subtitle].filter(Boolean).join(" — "),
    ),
    ...(serverFacts ? [] : fields),
    review.moreFields ? `${review.moreFields} more fields in full details.` : null,
    review.reason,
  ].filter((line): line is string => Boolean(line));
}
