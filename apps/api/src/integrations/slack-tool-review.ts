import type { ToolActionReview } from "@opengeni/contracts";
import type { SlackMessageBlock } from "./slack-bot";

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
