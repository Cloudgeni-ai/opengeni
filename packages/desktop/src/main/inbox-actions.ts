import type { InboxItem, OpenGeniClient } from "@opengeni/sdk";

import type { InboxAction } from "./inbox-model";

/**
 * Answer an item from its notification, exactly as the inbox would. Returns
 * false when the item needs the full session view instead: the question
 * changed, was already answered, or asks for more than one plain answer.
 */
export async function actOnInboxItem(
  client: OpenGeniClient,
  item: InboxItem,
  action: InboxAction,
): Promise<boolean> {
  if (action.kind === "approve" || action.kind === "deny") {
    if (item.kind !== "approval") return false;
    await client.sendApprovalDecision(item.workspaceId, item.sessionId, {
      approvalId: item.sourceKey,
      decision: action.kind === "approve" ? "approve" : "reject",
    });
    return true;
  }
  if (item.kind !== "question") return false;
  const request = await client.getHumanInputRequest(
    item.workspaceId,
    item.sessionId,
    item.sourceKey,
  );
  const question = request.questions[0];
  if (request.status !== "pending" || request.questions.length !== 1 || !question) return false;
  if (action.kind === "choose") {
    await client.submitHumanInputResponse(item.workspaceId, item.sessionId, item.sourceKey, {
      outcome: "answered",
      answers: [{ questionId: question.id, values: [action.choiceId] }],
    });
    return true;
  }
  const answer = action.text.trim();
  // A secret is never typed into a notification; the session opens on the secure card.
  if (!answer || question.kind === "secret") return false;
  if (question.kind === "text") {
    await client.submitHumanInputResponse(item.workspaceId, item.sessionId, item.sourceKey, {
      outcome: "answered",
      answers: [{ questionId: question.id, values: [answer] }],
    });
    return true;
  }
  if (!question.allowOther) return false;
  await client.submitHumanInputResponse(item.workspaceId, item.sessionId, item.sourceKey, {
    outcome: "answered",
    answers: [{ questionId: question.id, values: [], other: answer }],
  });
  return true;
}
